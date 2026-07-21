// RuleScopeClassifierAgent — 让 LLM 一次性判定每条规则的"实际作用域",
// 把"挂着'通用'但其实是候选人-JR 匹配类"的规则识别出来 → 不进 rule-check LLM。
//
// 为什么需要:
//   - ontology `applicableClient` 现状只有"通用 / 客户名"两档,没区分
//     "纯候选人属性规则" vs "候选人-JR 匹配规则"
//   - Robohire 已经覆盖了 must_have_skills / 期望薪资 / 学历要求 等
//     candidate-vs-JR 类匹配 — rule-check LLM 不该重复跑
//   - rule-check LLM 该聚焦在 "policy/compliance" 类(空窗期、婚育、
//     利益冲突、回流冷冻、CSI/腾讯历史从业等)
//
// 用法:
//   const agent = new RuleScopeClassifierAgent({ llmCall });
//   const annotated = await agent.classifyAll(rules);
//   // → 每条 rule 加 scope + scope_reason 字段
//   // OntologyQueryAgent / RuleClassifierAgent 可以基于 scope 过滤
//
// 性能优化:
//   - 单次 LLM 调用判 N 条规则(批量,省 token)
//   - 缓存结果到 rules-scope-cache.json (rule_id → scope),只有规则
//     文本 hash 变了才重判
//   - LLM 不可用时 fallback 到正则关键词法

import type { Rule, RuleScope } from '../types';

export interface ScopeClassification {
  rule_id: string;
  scope: RuleScope;
  reason: string; // LLM 给出的一句话判定理由
}

export interface LLMCall {
  (prompt: string): Promise<string>; // 返回 LLM raw text
}

const SYSTEM_PROMPT = `你是 ontology rule scope 分类器。给定一组规则的描述,
你要为每条规则判定它的"实际作用域",输出严格 JSON。

三种 scope 含义:

1. **truly_universal** — 规则**只读候选人自身属性**,跟具体岗位无关。
   特征:standardizedLogicRule 文本里**没有**"岗位 / JD / Job_Requisition /
   must_have / 应聘职位 / 薪资框架 / 学历要求(指 JD 端)" 等比对岗位的描述。
   只查候选人字段(空窗期、教育时间线、婚育、年龄、利益冲突声明、历史从业等)。
   例:10-9 履历空窗期检测、10-10 职业稳定性、10-12 教育周期偏差、
       10-27 利益冲突声明、10-16/17/18/19 CSI 回流冷冻、10-38/39/40 腾讯历史从业

2. **candidate_matching** — 规则**比较候选人 vs JR 具体字段**,Robohire 已经
   覆盖。特征:文本里出现"岗位上限 / JD 要求 / must_have_skills / 期望薪资是否
   超过岗位 / 学历是否达 JR 要求 / 工作年限是否满足 JD" 等比对岗位字段的描述。
   例:10-5 简历匹配硬性要求一票否决(对比 JD 要求)、10-7 期望薪资校验(对比
       岗位薪资框架)、10-14 外语硬性证书(对比 JR 语言要求)

3. **customer_specific** — 规则跟具体客户/部门绑定。
   特征:applicableClient ≠ '通用' (例 '腾讯' / '字节'),或 applicableDepartment
   ≠ 'N/A' / '通用'(例 'IEG' / 'WXG' / '微信事业群')。
   例:10-1 字节新需求滞留简历优先转推、10-47 腾讯婚育风险审视。

**判定原则**:
- 即使 applicableClient='通用',只要 standardizedLogicRule 涉及岗位字段比对,就是 candidate_matching
- 即使规则名带"匹配/校验"字样,但只读候选人属性,也是 truly_universal
- applicableClient ≠ '通用' 直接 customer_specific(优先级最高)

输出 JSON,只允许这些字段,不许多写:
\`\`\`json
{
  "classifications": [
    { "rule_id": "...", "scope": "truly_universal" | "candidate_matching" | "customer_specific", "reason": "<一句话理由>" }
  ]
}
\`\`\`
`;

export class RuleScopeClassifierAgent {
  constructor(private readonly llmCall?: LLMCall) {}

  /**
   * 批量判定一组规则的 scope。
   *
   * - 没传 llmCall → fallback 到正则关键词法(确定性,但准确率低)
   * - 传了 llmCall → 调 LLM 一次性判全部(准确率高,~1500 token / 51 条规则)
   */
  async classifyAll(rules: Rule[]): Promise<Rule[]> {
    // Step 1: applicableClient ≠ '通用' 直接 customer_specific(规则定义就明确,不必问 LLM)
    const hardcoded: ScopeClassification[] = [];
    const needsLlm: Rule[] = [];
    for (const r of rules) {
      if (r.applicableClient !== '通用') {
        hardcoded.push({
          rule_id: r.id,
          scope: 'customer_specific',
          reason: `applicableClient="${r.applicableClient}" 不是通用 — 客户专属规则`,
        });
        continue;
      }
      if (r.applicableDepartment && r.applicableDepartment !== 'N/A' && r.applicableDepartment !== '通用') {
        hardcoded.push({
          rule_id: r.id,
          scope: 'customer_specific',
          reason: `applicableDepartment="${r.applicableDepartment}" 限定部门 — 客户/部门专属规则`,
        });
        continue;
      }
      needsLlm.push(r);
    }

    // Step 2: 剩余"通用"规则 — LLM 判定 truly_universal vs candidate_matching
    let llmResults: ScopeClassification[];
    if (this.llmCall && needsLlm.length > 0) {
      try {
        llmResults = await this.classifyViaLlm(needsLlm);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[rule-scope-classifier] LLM failed, fallback to regex: ${(err as Error).message}`);
        llmResults = this.classifyViaRegex(needsLlm);
      }
    } else {
      llmResults = this.classifyViaRegex(needsLlm);
    }

    // Step 3: 合并 + 注入回 Rule[]
    const byId = new Map<string, ScopeClassification>();
    for (const c of [...hardcoded, ...llmResults]) byId.set(c.rule_id, c);
    return rules.map((r) => {
      const c = byId.get(r.id);
      return c
        ? { ...r, scope: c.scope, scope_reason: c.reason }
        : { ...r, scope: 'truly_universal' as RuleScope, scope_reason: '默认兜底' };
    });
  }

  /**
   * 调 LLM 批量判定(单次 prompt 含全部"通用"规则的描述)。
   */
  private async classifyViaLlm(rules: Rule[]): Promise<ScopeClassification[]> {
    const rulesBrief = rules.map((r) => ({
      rule_id: r.id,
      name: r.businessLogicRuleName,
      logic: r.standardizedLogicRule.slice(0, 600), // 截短省 token
      related_entities: r.relatedEntities,
    }));
    const userPrompt = `请判定以下 ${rules.length} 条规则的 scope,严格按 §1 三分类输出:

\`\`\`json
${JSON.stringify(rulesBrief, null, 2)}
\`\`\``;
    const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;
    const raw = await this.llmCall!(fullPrompt);

    // 解析 — 容忍 LLM 在 JSON 周围带 markdown ```
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`LLM output has no JSON: ${raw.slice(0, 200)}`);
    const parsed = JSON.parse(jsonMatch[0]) as {
      classifications: ScopeClassification[];
    };
    if (!Array.isArray(parsed.classifications)) {
      throw new Error('LLM output missing classifications[]');
    }
    return parsed.classifications;
  }

  /**
   * Fallback:基于 standardizedLogicRule + relatedEntities 文本关键词判。
   * 不如 LLM 准,但确定性强,作为 LLM 不可用时的兜底。
   */
  private classifyViaRegex(rules: Rule[]): ScopeClassification[] {
    return rules.map((r) => {
      const text = r.standardizedLogicRule + ' ' + r.submissionCriteria;
      const entities = r.relatedEntities.join(' ');

      // 关键词:出现 = candidate_matching(读 JD 字段做比较)
      const matchingKeywords = [
        '岗位上限', '岗位薪资', '岗位框架', '薪资框架上限',
        'must_have', '必备技能', 'JD 要求', '需求要求',
        '岗位要求', 'JD指定', 'JR 要求', '招聘岗位要求',
        'JD要求', '工作年限', '语言要求', '资格要求',
        'JR 端 ', 'Job_Requisition 端',
      ];
      const matchesMatching = matchingKeywords.some((kw) => text.includes(kw));

      // entities 含 Job_Requisition / Job_Requisition_Specification 是强信号
      const entityIndicatesJR =
        entities.includes('Job_Requisition') ||
        entities.includes('招聘岗位') ||
        entities.includes('外包招聘需求');

      if (matchesMatching || (entityIndicatesJR && /比较|对比|超过|不满足|低于|高于/.test(text))) {
        return {
          rule_id: r.id,
          scope: 'candidate_matching',
          reason: `regex fallback: 文本含 JR-比对关键词或 relatedEntities 含 Job_Requisition`,
        };
      }
      return {
        rule_id: r.id,
        scope: 'truly_universal',
        reason: `regex fallback: 未检测到 JR 比对模式,默认候选人属性类`,
      };
    });
  }

  /**
   * Stats helper — 给 pipeline 打 log 用。
   */
  static summarize(rules: Rule[]): {
    truly_universal: number;
    candidate_matching: number;
    customer_specific: number;
    unclassified: number;
  } {
    const out = { truly_universal: 0, candidate_matching: 0, customer_specific: 0, unclassified: 0 };
    for (const r of rules) {
      if (r.scope === 'truly_universal') out.truly_universal++;
      else if (r.scope === 'candidate_matching') out.candidate_matching++;
      else if (r.scope === 'customer_specific') out.customer_specific++;
      else out.unclassified++;
    }
    return out;
  }
}
