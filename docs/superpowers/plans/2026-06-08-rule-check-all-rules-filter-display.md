# Rule-Check 审计页:全规则筛选判断 + AI 验证 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让规则检查审计页对引擎考虑过的每一条规则(`rule_provenance` 全量,含被 fail-closed 排除的 10-42)都展示「确定性筛选判断 + 独立 AI 验证」,PASS/FAIL 判断逻辑不变。

**Architecture:** 读时 · provenance 驱动。`rule_provenance`(已持久化全量)是「所有规则」事实源;排除规则的名称/定义读时按 id 从打包目录 `loadAllRules()` 补全(零迁移)。扩展现有**单次** verify LLM 调用,复用 `selection_ok` 语义覆盖排除规则。现存 audit 无需重跑。

**Tech Stack:** Next.js App Router route handlers · React 19 client component · vitest · 纯函数优先(grouping/补全/派生 verdict 全部抽成可测纯函数)。

**Spec:** [docs/superpowers/specs/2026-06-08-rule-check-all-rules-filter-display-design.md](../specs/2026-06-08-rule-check-all-rules-filter-display-design.md)

**约定**:本仓库在 `main` 上直接开发(不用 worktree);commit 用 `git commit -m "…" -- <files>` pathspec(pre-commit hook 会 re-stage 全部改动,普通 add+commit 会吞用户未完成工作);不 push。

---

## Chunk 1: 纯函数数据层(目录补全 + 展示模型)

两个新纯函数模块,无 IO,vitest 直测。这是整个特性的承重单元。

### Task 1: 目录补全器 `excluded-rule-enrich.ts`

**Files:**
- Create: `lib/rule-check/excluded-rule-enrich.ts`
- Test: `lib/rule-check/excluded-rule-enrich.test.ts`

职责:把 provenance 条目用打包规则目录(`loadAllRules`)按 id 补全 —— ① 给全量 provenance 补 `rule_name`(详情 API 用);② 把排除条目展开成带 name/client/dept/definition 的 `ExcludedRule[]`(verify route 用)。

- [ ] **Step 1: Write the failing test**

```ts
// lib/rule-check/excluded-rule-enrich.test.ts
import { describe, it, expect } from 'vitest';
import { enrichProvenanceWithNames, buildExcludedRules } from './excluded-rule-enrich';
import type { RuleProvenance } from './types';

const prov: RuleProvenance[] = [
  { rule_id: '10-25', tier: 'general', included: true, reason: '通用规则(CSI),无条件纳入' },
  { rule_id: '10-42', tier: 'department', included: false, reason: '排除：岗位 bg 未解析,部门专属规则(CDG)fail-closed' },
  { rule_id: 'ZZ-NOPE', tier: 'client', included: false, reason: '不在目录里' },
];

describe('enrichProvenanceWithNames', () => {
  it('给在目录里的规则补 rule_name,保留原字段', () => {
    const out = enrichProvenanceWithNames(prov);
    const cdg = out.find((p) => p.rule_id === '10-42')!;
    expect(cdg.rule_name).toBe('CDG事业群6个月回流冷冻期绝对拦截');
    expect(cdg.included).toBe(false);
    expect(cdg.reason).toContain('fail-closed');
  });
  it('目录里没有的 id 不报错,rule_name 省略/空', () => {
    const out = enrichProvenanceWithNames(prov);
    const miss = out.find((p) => p.rule_id === 'ZZ-NOPE')!;
    expect(miss.rule_name ?? '').toBe('');
  });
});

describe('buildExcludedRules', () => {
  it('只取 included=false,补 name/client/dept/definition', () => {
    const out = buildExcludedRules(prov);
    expect(out.map((r) => r.rule_id)).toEqual(['10-42', 'ZZ-NOPE']);
    const cdg = out[0];
    expect(cdg.rule_name).toBe('CDG事业群6个月回流冷冻期绝对拦截');
    expect(cdg.applicable_department).toBe('CDG');
    expect(cdg.tier).toBe('department');
    expect(cdg.definition.length).toBeGreaterThan(20); // standardizedLogicRule 不空
  });
  it('目录缺失的排除规则降级为仅 id+reason(name/definition 空字符串)', () => {
    const out = buildExcludedRules(prov);
    const miss = out.find((r) => r.rule_id === 'ZZ-NOPE')!;
    expect(miss.rule_name).toBe('');
    expect(miss.definition).toBe('');
    expect(miss.reason).toBe('不在目录里');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/rule-check/excluded-rule-enrich.test.ts`
Expected: FAIL — `Cannot find module './excluded-rule-enrich'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/rule-check/excluded-rule-enrich.ts
// 读时把 rule_provenance 用打包规则目录(loadAllRules)按 id 补全名称/定义。
// provenance 只存 {rule_id,tier,included,reason} — 排除规则的可读名称/逻辑
// 定义不落库,这里按 id 现查目录补回,供详情 UI 展示 + verify 喂给第二模型。
import { loadAllRules } from './ontology';
import type { RuleProvenance } from './types';

export type EnrichedProvenance = RuleProvenance & { rule_name?: string };

export type ExcludedRule = {
  rule_id: string;
  rule_name: string;
  applicable_client: string;
  applicable_department: string;
  tier: string;
  reason: string;
  definition: string;
};

function catalogById() {
  return new Map(loadAllRules().map((r) => [r.id, r]));
}

export function enrichProvenanceWithNames(prov: RuleProvenance[]): EnrichedProvenance[] {
  const byId = catalogById();
  return prov.map((p) => {
    const r = byId.get(p.rule_id);
    return r ? { ...p, rule_name: r.businessLogicRuleName } : { ...p };
  });
}

export function buildExcludedRules(prov: RuleProvenance[]): ExcludedRule[] {
  const byId = catalogById();
  return prov
    .filter((p) => !p.included)
    .map((p) => {
      const r = byId.get(p.rule_id);
      return {
        rule_id: p.rule_id,
        rule_name: r?.businessLogicRuleName ?? '',
        applicable_client: r?.applicableClient ?? '',
        applicable_department: r?.applicableDepartment ?? '',
        tier: p.tier,
        reason: p.reason,
        definition: r?.standardizedLogicRule ?? '',
      };
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/rule-check/excluded-rule-enrich.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(rule-check): catalog-enrich provenance for excluded-rule names/defs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- lib/rule-check/excluded-rule-enrich.ts lib/rule-check/excluded-rule-enrich.test.ts
```

---

### Task 2: 展示模型 `rule-display-model.ts`(分组 + 四象限 verdict)

**Files:**
- Create: `lib/rule-check/rule-display-model.ts`
- Test: `lib/rule-check/rule-display-model.test.ts`

职责:把全量 provenance + AI opinions 折成 UI 可直接渲染的两组行 + 计数 + 每行的「筛选 verdict」。verdict 四象限是这个特性的语义核心,必须独立可测。

- [ ] **Step 1: Write the failing test**

```ts
// lib/rule-check/rule-display-model.test.ts
import { describe, it, expect } from 'vitest';
import { filterVerdict, buildRuleDisplayModel } from './rule-display-model';

describe('filterVerdict 四象限', () => {
  it('纳入+应纳入 → correct_included', () => expect(filterVerdict(true, true)).toBe('correct_included'));
  it('纳入+存疑 → suspect_over', () => expect(filterVerdict(true, false)).toBe('suspect_over'));
  it('排除+不该纳入 → correct_excluded', () => expect(filterVerdict(false, false)).toBe('correct_excluded'));
  it('排除+应纳入 → suspect_missed(10-42 信号)', () => expect(filterVerdict(false, true)).toBe('suspect_missed'));
  it('没有 AI 意见 → unknown', () => {
    expect(filterVerdict(true, null)).toBe('unknown');
    expect(filterVerdict(false, null)).toBe('unknown');
  });
});

describe('buildRuleDisplayModel', () => {
  const provenance = [
    { rule_id: '10-25', tier: 'general' as const, included: true, reason: 'r1', rule_name: '通用A' },
    { rule_id: '10-42', tier: 'department' as const, included: false, reason: 'fail-closed', rule_name: 'CDG拦截' },
  ];
  it('按 included 分两组并计数', () => {
    const m = buildRuleDisplayModel({ provenance, opinions: [] });
    expect(m.counts).toEqual({ total: 2, selected: 1, excluded: 1 });
    expect(m.selected.map((r) => r.rule_id)).toEqual(['10-25']);
    expect(m.excluded.map((r) => r.rule_id)).toEqual(['10-42']);
  });
  it('有 opinion 时给排除行算出 suspect_missed', () => {
    const opinions = [{ rule_id: '10-42', selection_ok: true } as never];
    const m = buildRuleDisplayModel({ provenance, opinions });
    expect(m.excluded[0].filter_verdict).toBe('suspect_missed');
    expect(m.excluded[0].selection_ok).toBe(true);
  });
  it('无 opinion 行 selection_ok=null,verdict=unknown', () => {
    const m = buildRuleDisplayModel({ provenance, opinions: [] });
    expect(m.excluded[0].selection_ok).toBeNull();
    expect(m.excluded[0].filter_verdict).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/rule-check/rule-display-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/rule-check/rule-display-model.ts
// 把全量 rule_provenance(已补 rule_name)+ 第二模型 selection 意见,折成
// UI 直接渲染的「选中 / 排除」两组 + 计数 + 每行的筛选 verdict。
// selection_ok 语义 = 「该不该为此候选人×岗位纳入」,与是否实际纳入交叉 → 四象限。
import type { EnrichedProvenance } from './excluded-rule-enrich';

export type FilterVerdict =
  | 'correct_included' // 纳入且 AI 认同应纳入
  | 'suspect_over' // 纳入但 AI 认为不该纳入(疑似多纳入)
  | 'correct_excluded' // 排除且 AI 认同不该纳入
  | 'suspect_missed' // 排除但 AI 认为应纳入(疑似漏选)
  | 'unknown'; // 尚无 AI 意见

export function filterVerdict(included: boolean, selectionOk: boolean | null): FilterVerdict {
  if (selectionOk === null) return 'unknown';
  if (included) return selectionOk ? 'correct_included' : 'suspect_over';
  return selectionOk ? 'suspect_missed' : 'correct_excluded';
}

export type RuleDisplayRow = {
  rule_id: string;
  rule_name: string;
  tier: string;
  included: boolean;
  reason: string;
  selection_ok: boolean | null;
  filter_verdict: FilterVerdict;
};

export function buildRuleDisplayModel(args: {
  provenance: EnrichedProvenance[];
  opinions: Array<{ rule_id: string; selection_ok: boolean }>;
}): {
  selected: RuleDisplayRow[];
  excluded: RuleDisplayRow[];
  counts: { total: number; selected: number; excluded: number };
} {
  const okById = new Map(args.opinions.map((o) => [o.rule_id, o.selection_ok]));
  const rows: RuleDisplayRow[] = args.provenance.map((p) => {
    const selection_ok = okById.has(p.rule_id) ? (okById.get(p.rule_id) as boolean) : null;
    return {
      rule_id: p.rule_id,
      rule_name: p.rule_name ?? '',
      tier: p.tier,
      included: p.included,
      reason: p.reason,
      selection_ok,
      filter_verdict: filterVerdict(p.included, selection_ok),
    };
  });
  const selected = rows.filter((r) => r.included);
  const excluded = rows.filter((r) => !r.included);
  return { selected, excluded, counts: { total: rows.length, selected: selected.length, excluded: excluded.length } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/rule-check/rule-display-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(rule-check): rule display model — group + 4-quadrant filter verdict

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- lib/rule-check/rule-display-model.ts lib/rule-check/rule-display-model.test.ts
```

---

## Chunk 2: Verify prompt 覆盖排除规则

扩展现有单次 verify LLM 调用,让第二模型对排除规则也逐条给 `selection_ok`。

### Task 3: `verify-prompt.ts` 加 excluded_rules 段 + 放宽 system 约束

**Files:**
- Modify: `lib/rule-check/verify-prompt.ts`
- Test: `lib/rule-check/verify-prompt.test.ts`(若不存在则 Create)

- [ ] **Step 1: Write the failing test**

```ts
// lib/rule-check/verify-prompt.test.ts(新增/追加这些用例)
import { describe, it, expect } from 'vitest';
import { composeVerifyPrompt, parseVerification, type VerifyPromptInput, type VerifyFlag } from './verify-prompt';

const baseFlag: VerifyFlag = {
  rule_id: '10-25', rule_name_snapshot: '通用A', severity: 'terminal',
  applicable: true, result: 'PASS', evidence: 'ev', next_action: 'continue',
};
const baseInput: VerifyPromptInput = {
  decision: 'PASS', failure_reasons: [], client_name: '腾讯', business_group: null,
  user_prompt: null, resume: { name: '陈思颖' }, jr: { client_job_title: '测试岗位' },
  flags: [baseFlag],
  rule_provenance: [],
  filtered_out_rules: [],
  excluded_rules: [
    { rule_id: '10-42', rule_name: 'CDG拦截', applicable_client: '腾讯',
      applicable_department: 'CDG', tier: 'department',
      reason: '岗位 bg 未解析,fail-closed', definition: '离职不满6个月必须阻断…' },
  ],
};

describe('composeVerifyPrompt — 排除规则段', () => {
  it('渲染被排除规则段,含 id/名称/定义/排除理由', () => {
    const p = composeVerifyPrompt(baseInput);
    expect(p).toContain('被排除的规则');
    expect(p).toContain('10-42');
    expect(p).toContain('CDG拦截');
    expect(p).toContain('fail-closed');
  });
  it('opinions 总数提示 = 已评估 + 被排除', () => {
    const p = composeVerifyPrompt(baseInput);
    // 1 评估 + 1 排除 = 2
    expect(p).toMatch(/2\s*条/);
  });
});

describe('parseVerification — 排除规则意见保留且不计入一致率', () => {
  it('排除规则 opinion(不在 flags 中)保留 selection_ok,但不进 agreement_total', () => {
    const raw = JSON.stringify({
      overall_confidence: 80, verdict: 'trustworthy', summary: 's', dimensions: [],
      rule_opinions: [
        { rule_id: '10-25', selection_ok: true, second_verdict: 'PASS', confidence: 90, dimensions: [] },
        { rule_id: '10-42', selection_ok: true, second_verdict: 'NOT_APPLICABLE', confidence: 70, dimensions: [] },
      ],
      missing_rules: [], over_included_rules: [],
    });
    const v = parseVerification(raw, [baseFlag]);
    const cdg = v.rule_opinions.find((o) => o.rule_id === '10-42')!;
    expect(cdg).toBeTruthy();
    expect(cdg.selection_ok).toBe(true);
    // 只有 10-25 在 flags 中 → agreement_total 只数它
    expect(v.agreement_total).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/rule-check/verify-prompt.test.ts`
Expected: FAIL — `excluded_rules` 不是 `VerifyPromptInput` 字段(类型错)+ prompt 不含「被排除的规则」。

- [ ] **Step 3: Write minimal implementation**

在 `VerifyPromptInput` 加字段(`lib/rule-check/verify-prompt.ts`,接在 `filtered_out_rules` 后):

```ts
  /** 被 client/department/executor 过滤掉的规则,补了名称/定义 —— 让第二模型
   *  对每条也给 selection_ok(该不该排除)。来自 buildExcludedRules(provenance)。 */
  excluded_rules: Array<{
    rule_id: string;
    rule_name: string;
    applicable_client: string;
    applicable_department: string;
    tier: string;
    reason: string;
    definition: string;
  }>;
```

在 `composeVerifyPrompt` 里,把原 `filtered_out_rules` 段替换/补成由 `excluded_rules` 驱动的「逐条判断」段(放在选中规则段之后、结尾说明之前):

```ts
  if (input.excluded_rules.length > 0) {
    lines.push(`## 被排除的规则(${input.excluded_rules.length} 条 —— 也要逐条判断:该不该排除)`);
    lines.push('这些规则被系统的硬编码过滤(客户/部门/executor)排除,未进入 PASS/FAIL 评估。');
    lines.push('请对每条独立判断:**这条规则本该为此候选人×岗位纳入吗?**(给 selection_ok + selection_reasoning)');
    lines.push('排除规则不做 PASS/FAIL 判定:second_verdict 一律填 NOT_APPLICABLE。');
    lines.push('');
    for (const r of input.excluded_rules) {
      lines.push(`### 规则 ${r.rule_id}${r.rule_name ? `:${r.rule_name}` : ''}`);
      if (r.definition) lines.push(`- 规则定义:${truncate(r.definition, 500)}`);
      lines.push(`- 适用客户=${r.applicable_client || '?'} · 适用部门=${r.applicable_department || 'N/A'} · tier=${r.tier}`);
      lines.push(`- 系统排除理由:${r.reason}`);
      lines.push('');
    }
  }
```

更新结尾说明里的 opinions 总数(原来写 `恰好 ${input.flags.length} 条`):

```ts
  const opinionTotal = input.flags.length + input.excluded_rules.length;
  lines.push(
    `请按 system 指定的 JSON schema 输出。rule_opinions 必须恰好 ${opinionTotal} 条 = 已评估 ${input.flags.length} 条 + 被排除 ${input.excluded_rules.length} 条,rule_id 原样照抄;每条都要给 selection_ok / selection_reasoning;已评估规则另给 second_verdict / judgment_reasoning / confidence / dimensions,被排除规则 second_verdict=NOT_APPLICABLE。missing_rules 只放确实缺失且不在上述任何列表里的硬性规则。`,
  );
```

在 `VERIFY_SYSTEM_PROMPT` 把「rule_opinions 必须逐条对应原模型已评估的规则」这条放宽为:

```
- rule_opinions 覆盖两类规则,各恰好一条意见:① 原模型已评估的规则(给完整 selection_ok + second_verdict + judgment_reasoning + confidence + dimensions);② 被排除的规则(只判 selection_ok = 该不该纳入,second_verdict 填 NOT_APPLICABLE,judgment_reasoning/dimensions 可省)。rule_id 必须原样照抄,严禁自创 id。本该有却两类都没列的规则才放进 missing_rules。
```

> `parseVerification` 无需结构改动:它已按 rule_id keying,且 `if (resultByRuleId.has(rule_id))` 守卫保证排除规则不污染 `agreement_total`(测试已锁)。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/rule-check/verify-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing suite to catch the new required field**

Run: `npx vitest run lib/rule-check/`
Expected: 任何构造 `VerifyPromptInput` 的旧测试若漏 `excluded_rules` 会编译失败 —— 给它们补 `excluded_rules: []`。全绿后继续。

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(rule-check): verify prompt covers excluded rules (selection_ok only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- lib/rule-check/verify-prompt.ts lib/rule-check/verify-prompt.test.ts
```

---

## Chunk 3: 路由接线(详情 + verify)

把纯函数接到两个 route handler。这两步主要是接线,测试以「字段出现/被传入」为断言。

### Task 4: 详情 API 给 provenance 补 rule_name

**Files:**
- Modify: `app/api/rule-check-audits/[auditId]/route.ts`

- [ ] **Step 1: 扩展类型**

把 `RuleCheckAuditDetail.rule_provenance` 的元素类型加可选 `rule_name`:

```ts
  rule_provenance: Array<{
    rule_id: string;
    tier: 'general' | 'client' | 'department';
    included: boolean;
    reason: string;
    rule_name?: string;
  }>;
```

- [ ] **Step 2: 读时补全**

顶部 import:

```ts
import { enrichProvenanceWithNames } from '@/lib/rule-check/excluded-rule-enrich';
```

把 `rule_provenance: parseProvenance(audit.rule_provenance),` 改为:

```ts
      rule_provenance: enrichProvenanceWithNames(parseProvenance(audit.rule_provenance)),
```

- [ ] **Step 3: 手动验证(已有 audit,不重跑)**

Run(确保 dev server 在 3002):
```bash
curl -s 'http://localhost:3002/api/rule-check-audits/rca_no-trace_JRQ-a5f6029a-8af8-4f9a-81e8-7c594cc52aa8-TEST334_1780918850764' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0)).detail; console.log(d.rule_provenance.map(p=>`${p.rule_id} included=${p.included} name=${p.rule_name??""}`).join("\n"))'
```
Expected:11 行,含 `10-42 included=false name=CDG事业群6个月回流冷冻期绝对拦截`。

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(rule-check): detail API enriches provenance with rule_name

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- 'app/api/rule-check-audits/[auditId]/route.ts'
```

---

### Task 5: verify route 构造并传入 excluded_rules

**Files:**
- Modify: `app/api/rule-check-audits/[auditId]/verify/route.ts`

- [ ] **Step 1: import + 构造**

顶部 import:

```ts
import { buildExcludedRules } from '@/lib/rule-check/excluded-rule-enrich';
```

在 `composeVerifyPrompt({...})` 调用里,先把 provenance 解析出来复用,再传 `excluded_rules`。把现有内联的 `rule_provenance: parseArray<…>(audit.rule_provenance)` 提取成局部变量:

```ts
    const provenance = parseArray<{
      rule_id: string; tier: string; included: boolean; reason: string;
    }>(audit.rule_provenance);

    const userPrompt = composeVerifyPrompt({
      decision: audit.decision,
      failure_reasons: parseArray<string>(audit.failure_reasons),
      client_name: audit.client_name ?? '',
      business_group: audit.business_group,
      user_prompt: audit.user_prompt,
      resume: parseJsonObject(audit.parsed_resume_json),
      jr: parseJsonObject(audit.job_requisition_json),
      flags,
      rule_provenance: provenance,
      filtered_out_rules: parseArray<{
        rule_id: string; rule_name: string; applicable_client: string;
        applicable_department: string; executor: string; reason: string;
      }>(audit.filtered_out_rules),
      excluded_rules: buildExcludedRules(provenance as never),
    });
```

> 注:`buildExcludedRules` 入参是 `RuleProvenance[]`;`provenance` 这里的局部宽类型用 `as never` 桥接(tier 是 string vs 联合),运行期字段一致。或在 Task 1 把 `buildExcludedRules` 参数放宽为 `Array<{rule_id;tier;included;reason}>`(更干净,推荐)。

- [ ] **Step 2: typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "verify/route"`
Expected: 无输出(该文件零类型错)。

- [ ] **Step 3: 手动验证 — 排除规则拿到 AI 意见**

Run(gateway 已配置时):
```bash
curl -s -XPOST 'http://localhost:3002/api/rule-check-audits/rca_no-trace_JRQ-a5f6029a-8af8-4f9a-81e8-7c594cc52aa8-TEST334_1780918850764/verify' \
  | node -e 'const r=JSON.parse(require("fs").readFileSync(0)); if(!r.ok){console.log("not ok:",r.reason);process.exit()} const o=r.verification.rule_opinions.find(x=>x.rule_id==="10-42"); console.log("10-42 opinion:", JSON.stringify(o&&{selection_ok:o.selection_ok, reason:o.selection_reasoning}))'
```
Expected:能打印 10-42 的 `selection_ok` + 理由(gateway 未配则 `not ok: gateway_unavailable`,属环境问题非代码问题)。

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(rule-check): verify route feeds excluded_rules to second model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- 'app/api/rule-check-audits/[auditId]/verify/route.ts'
```

---

## Chunk 4: UI — 全量分组渲染 + 计数修正

### Task 6: i18n 新 key(zh + en)

**Files:**
- Modify: `lib/i18n.tsx`

- [ ] **Step 1: 加 key**(zh 块约 line 1453 附近,en 块约 line 4100 附近 —— 两份都加)

zh:
```ts
    rc_sel_excluded_group: "未选中 · 排除（{n}）",
    rc_sel_selected_group: "选中（{n}）",
    rc_filter_correct_included: "筛选正确",
    rc_filter_suspect_over: "疑似多纳入",
    rc_filter_correct_excluded: "排除正确",
    rc_filter_suspect_missed: "疑似漏选",
    rc_sel_excluded_reason: "排除理由",
```
en:
```ts
    rc_sel_excluded_group: "Excluded ({n})",
    rc_sel_selected_group: "Selected ({n})",
    rc_filter_correct_included: "Correctly included",
    rc_filter_suspect_over: "Possibly over-included",
    rc_filter_correct_excluded: "Correctly excluded",
    rc_filter_suspect_missed: "Possibly missed",
    rc_sel_excluded_reason: "Exclusion reason",
```

- [ ] **Step 2: Commit**

```bash
git commit -m "i18n(rule-check): keys for excluded-rule group + filter verdicts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- lib/i18n.tsx
```

---

### Task 7: `RuleSelectionVerifyTab.tsx` 渲染排除组 + 修计数

**Files:**
- Modify: `components/rule-check/RuleSelectionVerifyTab.tsx`

职责:`AdaptedRules` 在原「选中」列表之后,新增「未选中·排除」分组(用展示模型),并把因果链计数改为派生自 provenance。**保留** parked(没钱/故障)分支不动。

- [ ] **Step 1: import 纯函数**

```ts
import { buildRuleDisplayModel } from "@/lib/rule-check/rule-display-model";
```

- [ ] **Step 2: 在 `AdaptedRules` 内构造展示模型 + 修计数**

在 `provById`/`opinionById` 之后加:

```ts
  const displayModel = React.useMemo(
    () =>
      buildRuleDisplayModel({
        provenance: detail.rule_provenance ?? [],
        opinions: (verification?.rule_opinions ?? []).map((o) => ({
          rule_id: o.rule_id,
          selection_ok: o.selection_ok,
        })),
      }),
    [detail.rule_provenance, verification],
  );
  const provTotal = displayModel.counts.total;     // 全量(含排除)
  const excludedRows = displayModel.excluded;
```

把因果链那段的 `total` / `filtered` 改为派生(provenance 有数据时优先,否则回退旧字段以兼容无 provenance 的旧/能源 audit):

```ts
  const chainTotal = provTotal > 0 ? provTotal : total;
  const chainFiltered = provTotal > 0 ? excludedRows.length : filtered.length;
```
并把 `t("rc_sel_chain").replace("{total}", String(total))…` 改用 `chainTotal` / `chainFiltered`。

- [ ] **Step 3: 渲染排除分组**

在「↳ 注入说明」那行之后、原 `filtered.length>0` 折叠块**之前**,插入排除分组(仅当有 provenance 排除行时):

```tsx
      {excludedRows.length > 0 ? (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--c-line)", paddingTop: 10 }}>
          <div className="hint" style={{ marginBottom: 6 }}>
            {t("rc_sel_excluded_group").replace("{n}", String(excludedRows.length))}
          </div>
          <div className="flex flex-col" style={{ gap: 6 }}>
            {excludedRows.map((row) => (
              <ExcludedRuleCard
                key={row.rule_id}
                row={row}
                opinion={opinionById.get(row.rule_id) ?? null}
                verifying={verifying}
              />
            ))}
          </div>
        </div>
      ) : null}
```

> 旧的 `filtered.length>0 ? … : rc_sel_empty_filtered` 折叠块:当 `provTotal>0` 时不再渲染(排除信息已由上面新分组覆盖);保留它仅作 `provTotal===0`(无 provenance 旧 audit)的回退。即把该块外层包一层 `{provTotal === 0 && ( … 原块 … )}`。

- [ ] **Step 4: 新增 `ExcludedRuleCard` 组件 + verdict 标签映射**

在文件内(`AdaptedRuleCard` 附近)加:

```tsx
const FILTER_VERDICT_META: Record<string, { key: string; tone: "ok" | "err" | "muted" }> = {
  correct_included: { key: "rc_filter_correct_included", tone: "ok" },
  suspect_over: { key: "rc_filter_suspect_over", tone: "err" },
  correct_excluded: { key: "rc_filter_correct_excluded", tone: "ok" },
  suspect_missed: { key: "rc_filter_suspect_missed", tone: "err" },
  unknown: { key: "", tone: "muted" },
};

/** 单条「被排除规则」卡:确定性排除理由 + AI 该不该纳入(selection_ok)。无 PASS/FAIL。 */
function ExcludedRuleCard({
  row,
  opinion,
  verifying,
}: {
  row: import("@/lib/rule-check/rule-display-model").RuleDisplayRow;
  opinion: RuleOpinion | null;
  verifying: boolean;
}) {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const tierKey = TIER_KEY[row.tier];
  const meta = FILTER_VERDICT_META[row.filter_verdict];
  const tone = meta.tone === "ok" ? "var(--c-ok)" : meta.tone === "err" ? "var(--c-err)" : "var(--c-ink-4)";
  return (
    <div className="border border-line rounded-sm overflow-hidden" style={{ background: "var(--c-bg)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left"
        style={{ padding: "8px 10px", cursor: "pointer" }}
      >
        <span className="text-ink-3 flex-none" style={{ fontSize: 10, transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <span className="mono text-[11.5px] text-ink-1 font-semibold flex-none">{row.rule_id}</span>
        <span className="text-[12px] text-ink-1 flex-1 truncate">{row.rule_name}</span>
        {tierKey ? <Badge variant="default">{t(tierKey)}</Badge> : null}
        <Badge variant="default">{t("rc_sel_should_not_select")}{/* 排除 */}</Badge>
        {meta.key ? (
          <span className="mono rounded-sm flex-none" style={{ fontSize: 10, padding: "1px 6px", color: tone, background: `color-mix(in oklab, ${tone} 12%, var(--c-bg))`, border: `1px solid color-mix(in oklab, ${tone} 35%, var(--c-line))` }}>
            {t(meta.key)}
          </span>
        ) : verifying ? (
          <span className="mono text-ink-3 flex-none" style={{ fontSize: 10 }}>{t("rc_sel_verifying")}</span>
        ) : null}
      </button>
      {open ? (
        <div className="rc-fade-in" style={{ borderTop: "1px solid var(--c-line)", padding: "10px 12px" }}>
          <div className="hint" style={{ marginBottom: 4 }}>{t("rc_sel_excluded_reason")}{tierKey ? `（${t(tierKey)}）` : ""}</div>
          <div className="text-ink-2" style={{ fontSize: 11.5, lineHeight: 1.55, marginBottom: opinion ? 8 : 0 }}>{row.reason}</div>
          {opinion ? (
            <div className="rounded-sm" style={{ background: row.filter_verdict === "suspect_missed" ? "color-mix(in oklab, var(--c-err) 6%, var(--c-bg))" : "var(--c-panel)", borderLeft: `3px solid ${tone}`, padding: "6px 8px" }}>
              <div className="hint" style={{ fontSize: 10, marginBottom: 3 }}>{t("rc_sel_llm_select_judge")}</div>
              <div className="text-ink-2" style={{ fontSize: 11, lineHeight: 1.5 }}>{opinion.selection_reasoning || "—"}</div>
            </div>
          ) : null}
          <div style={{ borderTop: "1px solid var(--c-line)", marginTop: 10 }}>
            <div className="hint" style={{ padding: "8px 0 0" }}>{t("rc_sel_orig_rule_title")}</div>
            <RuleDefinitionPanel ruleId={row.rule_id} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: typecheck + lint**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "RuleSelectionVerifyTab"`
Expected: 无输出。

- [ ] **Step 6: 手动走查(verify skill)**

用 `verify` skill 打开审计 `rca_no-trace_JRQ-a5f6029a-…-TEST334_1780918850764`:
- 「规则筛选」tab 显示「选中（4）」+「未选中 · 排除（7）」两组。
- 10-42 在排除组,排除理由含「fail-closed」。
- 跑完交叉验证后 10-42 带 AI 意见;若 AI 认为应纳入 → 显示红色「疑似漏选」。
- 因果链显示「规则库 11 → 过滤 7 → 选中 4」。

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(rule-check): render excluded-rule group + fix selection chain counts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- components/rule-check/RuleSelectionVerifyTab.tsx
```

---

## Chunk 5(可选 · 前向数据矫正):agent 写入修正

**仅在用户确认要做**(spec §4.5)。UI 不依赖此项;它只让**新** audit 的存库数据自洽。

### Task 8: agent 写真实总数 + 持久化 filtered_out_rules

**Files:**
- Modify: `server/inngest/agents/rule-check-agent.ts`
- Modify: `lib/rule-check/runner.ts` + `lib/rule-check/api-rule-fetcher.ts`(让 audit 带 `filtered_out_rules` + 真实 total)

- [ ] **Step 1:** 在 `api-rule-fetcher.ts` 的 `RuleFetchResult` 增 `filtered_out_rules`(从 `provenance.filter(!included)` + raw rule 元数据),`runner.ts` 透传到 `audit.filtered_out_rules`,并把 `rules_total_in_ontology` 设为 `provenance.length`(或目录候选数)。
- [ ] **Step 2:** `rule-check-agent.ts:542` 把 `rules_total_in_ontology: result.audit.rules_evaluated ?? 0` 改为真实总数;`create` 里补 `filtered_out_rules: JSON.stringify(result.audit.filtered_out_rules ?? [])`。
- [ ] **Step 3:** 跑 `npx vitest run lib/rule-check/ server/inngest/agents/rule-check-agent.test.ts` 全绿。
- [ ] **Step 4:** Commit(pathspec 三文件)。

---

## 收尾

- [ ] 全量回归:`npx vitest run`(或至少 `lib/rule-check/ app/api server/inngest/agents`)全绿。
- [ ] 类型:`npm run build`(next build 跑 typecheck+lint)无新错。
- [ ] 用 `verify` skill 对 Run `01KTKGJ0QC8PQCTHZ6FVDVKFY4` 的审计页确认 spec §7 验收清单逐条满足。
