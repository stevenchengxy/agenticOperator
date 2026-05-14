// 6 个 (candidate × JD) 测试场景 + 每个的 expected verdict。
//
// fixture 数据本身复用 scripts/rule-check-poc/fixtures/{candidates,job-requisitions}.ts
// (那些已经为 POC 6 个场景调过,跟 RaasRequirement / ParsedResume 真实 shape 对齐)。
//
// 这里只声明 "哪些 candidate 配哪些 JD" + "期望 verdict",其余引用复用。

import { CANDIDATES } from '../../rule-check-poc/fixtures/candidates';
import { JOB_REQUISITIONS } from '../../rule-check-poc/fixtures/job-requisitions';

export type ScenarioId =
  | 's01-clean-tencent-pcg-keep'
  | 's02-huawei-cooldown-drop'
  | 's03-csi-blacklist-drop'
  | 's04-tencent-history-cross-studio'
  | 's05-tencent-history-same-studio'
  | 's06-bytedance-history-pause'
  | 's07-foreign-marital-tencent'       // c05 外籍 + 28 岁未婚女 → 腾讯 CDG
  | 's08-bytedance-cooldown-expired'    // c06 字节回流冷冻已过 → 字节 TikTok
  | 's09-tencent-history-to-bytedance'  // c04 腾讯 IEG 史 → 字节(跨客户,腾讯规则不适用)
  | 's10-clean-tencent-cdg';            // c01 干净 → 腾讯 CDG(测干净+CDG 路径)

export interface ExpectedVerdict {
  /** binary gate 结果。FAIL 覆盖 LLM 输出 DROP/PAUSE 两种;真实测试时
   * 我们也会断言 LLM 的原始 llm_decision。 */
  decision: 'PASS' | 'FAIL';
  /**
   * LLM 原始输出 overall_decision。
   * 新 schema (2026-05-12 后):'PASS' | 'FAIL'(二元,无 KEEP/DROP/PAUSE)。
   * 老 schema 值('KEEP' / 'DROP' / 'PAUSE')仅作为旧 fixture 备份保留。
   */
  llm_decision: 'PASS' | 'FAIL' | 'KEEP' | 'DROP' | 'PAUSE';
  /** 期望失败原因里至少包含的 rule_ids(子集匹配)。 */
  must_fail_rule_ids: string[];
  /** 期望这些规则 applicable=true 且 result=PASS(certificate of negative)。 */
  must_pass_rule_ids: string[];
  /** PASS scenario 强制要求 augmentation 注入 Robohire 调用。 */
  must_have_augmentation: boolean;
  /** 人类备注:为什么期望这个结果(给 reporter 写到 .md 里)。 */
  rationale: string;
}

export interface Scenario {
  id: ScenarioId;
  candidate_id: string;
  jd_id: string;
  expected: ExpectedVerdict;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 's01-clean-tencent-pcg-keep',
    candidate_id: 'c01-zhangsan-clean',
    jd_id: 'jr-tencent-pcg-frontend',
    expected: {
      decision: 'PASS',
      llm_decision: 'PASS',
      must_fail_rule_ids: [],
      // 10-25(华为冷冻)在所有客户都 applicable,候选人无华为史 → PASS
      must_pass_rule_ids: ['10-25'],
      must_have_augmentation: true,
      rationale:
        '张三 5y 前端,阿里 + 字节背景,无任何红线/CSI/腾讯历史。 ' +
        '腾讯 PCG 岗位下,binary 模式应该全部规则 PASS / NOT_APPLICABLE → KEEP/PASS。',
    },
  },
  {
    id: 's02-huawei-cooldown-drop',
    candidate_id: 'c02-lisi-huawei-recent',
    jd_id: 'jr-bytedance-tiktok-fe',
    expected: {
      decision: 'FAIL',
      llm_decision: 'FAIL', // 10-25 命中 → binary 模式直接 FAIL
      must_fail_rule_ids: ['10-25'],
      must_pass_rule_ids: [],
      must_have_augmentation: false, // FAIL 路径不调 Robohire
      rationale:
        '李四 2 个月前从华为离职 < 3 个月冷冻期。10-25 必须命中并挂起,' +
        '通知招聘专员"竞对互不挖角待确认"。evidence 应该引用华为 离职日期。',
    },
  },
  {
    id: 's03-csi-blacklist-drop',
    candidate_id: 'c03-wangwu-csi-blacklist',
    jd_id: 'jr-tencent-pcg-frontend',
    expected: {
      decision: 'FAIL',
      llm_decision: 'FAIL',
      must_fail_rule_ids: ['10-17'],
      must_pass_rule_ids: [],
      must_have_augmentation: false,
      rationale:
        '王五在中软国际离职原因 A15(劳动纠纷),命中 10-17 通用黑名单高风险类型,' +
        '系统自动判定不予录用,立即终止匹配流程。',
    },
  },
  {
    id: 's04-tencent-history-cross-studio',
    candidate_id: 'c04-zhaoliu-tencent-ieg',
    jd_id: 'jr-tencent-ieg-tianmei',
    expected: {
      decision: 'FAIL',
      llm_decision: 'FAIL',
      // 注意:fixture c04 是 PCG 史(不是天美),所以应该不触发 10-43 跨工作室。
      // 这里只 assert 10-38 必命中(腾讯历史从业)。
      must_fail_rule_ids: ['10-38'],
      must_pass_rule_ids: [],
      must_have_augmentation: false,
      rationale:
        '赵六腾讯 PCG 在职史(主动离场 4 个月前)。 ' +
        '10-38 必须命中:暂停推荐 + 向 HSM 发起核实任务确认真实离场原因。',
    },
  },
  {
    id: 's05-tencent-history-same-studio',
    candidate_id: 'c04-zhaoliu-tencent-ieg',
    jd_id: 'jr-tencent-cdg-data',
    expected: {
      decision: 'FAIL',
      llm_decision: 'FAIL',
      // CDG 6 个月内拦截 (10-42) 是 terminal 但需要候选人是 IEG 史;c04 是 PCG,
      // 所以应该 PASS。但 10-38 仍触发。
      must_fail_rule_ids: ['10-38'],
      must_pass_rule_ids: ['10-42'], // CDG 拦截规则适用,但候选人没有 CDG 史 → PASS
      must_have_augmentation: false,
      rationale:
        '同候选人推 CDG 岗位,10-38 必命中。10-42 CDG 6 个月拦截虽适用此岗位 client/部门 ' +
        '维度,但候选人是 PCG 史不是 CDG 史,应该 result=PASS。',
    },
  },
  {
    id: 's06-bytedance-history-pause',
    candidate_id: 'c01-zhangsan-clean',
    jd_id: 'jr-bytedance-tiktok-fe',
    expected: {
      // 2026-05-12 校准:c01 张三 work_history 含字节跳动正式员工经历
      // (2018-07 ~ 2021-02 前端工程师),配字节 JD 应**触发 10-49**
      // (字节正编员工回流标记 — 需上传合规凭证)。binary 模式下命中规则即 FAIL。
      decision: 'FAIL',
      llm_decision: 'FAIL',
      must_fail_rule_ids: ['10-49'],
      must_pass_rule_ids: ['10-25', '10-26'], // 华为/OPPO 未命中
      must_have_augmentation: false, // FAIL 不调 Robohire
      rationale:
        '张三 work_history[1] 显示曾在字节跳动任前端工程师(2018-2021,正式职位),' +
        '配字节 TikTok 岗位时 10-49(字节正编员工回流标记)必命中,' +
        '需上传客户 BP 同意回流凭证后才能继续推荐。binary 模式 → FAIL。',
    },
  },
  // ═════════════════ 扩展 scenarios:覆盖复合用例 + 真实候选人 ═════════════════
  {
    id: 's07-foreign-marital-tencent',
    candidate_id: 'c05-zhouqi-foreign-data',
    jd_id: 'jr-tencent-cdg-data',
    expected: {
      decision: 'FAIL',
      llm_decision: 'FAIL',
      // 美籍华人 28 岁未婚女 + 腾讯 CDG 岗位:
      // - 10-35 必命中:nationality=美国 → 通道限制
      // - 10-47 必命中:女 + >26 岁 + 未婚 → HSM 婚育审视
      must_fail_rule_ids: ['10-35', '10-47'],
      must_pass_rule_ids: [],
      must_have_augmentation: false,
      rationale:
        '周七 nationality="美国"(外籍)+ gender="女" + age=28 + marital="未婚"。' +
        '腾讯客户场景 10-35(外籍通道限制)+ 10-47(女>26 未婚/已婚未育 HSM 审视)' +
        '都必须命中。复合多规则 → FAIL。',
    },
  },
  {
    id: 's08-bytedance-cooldown-expired',
    candidate_id: 'c06-qianba-bytedance-history',
    jd_id: 'jr-bytedance-tiktok-fe',
    expected: {
      // 钱八字节离职 2 年前(>6 个月冷冻早过)
      // 10-49 字节正编回流标记仍然命中(凭证要求);
      // 但严格说"冷冻已过"+ "需凭证"是 needs_human / not terminal
      // → binary 模式 LLM 应判 FAIL(needs_human 都算 FAIL)
      decision: 'FAIL',
      llm_decision: 'FAIL',
      must_fail_rule_ids: ['10-49'],
      must_pass_rule_ids: [],
      must_have_augmentation: false,
      rationale:
        '钱八 work_history 含字节跳动正式员工(2 年前主动离职)。10-49 字节正编回流' +
        '标记仍要求上传客户 BP 凭证。冷冻期已过(>6m),但凭证流程未走完 → needs_human → FAIL。',
    },
  },
  {
    id: 's09-tencent-history-to-bytedance',
    candidate_id: 'c04-zhaoliu-tencent-ieg',
    jd_id: 'jr-bytedance-tiktok-fe',
    expected: {
      // 跨客户:腾讯 IEG 史推字节岗
      // 腾讯专属规则(10-38/10-40/10-43/10-46 等)在字节路径下 applicable=false
      // 字节专属规则(10-1/10-49 等)applicable=true,但 c04 没字节史 → PASS
      // 通用规则:技能不匹配(c04 是游戏后端 C++/Lua,字节要前端 React/TS)→ 10-5 命中
      decision: 'FAIL',
      llm_decision: 'FAIL',
      must_fail_rule_ids: ['10-5'], // 技能完全不匹配
      must_pass_rule_ids: ['10-38', '10-43'], // 腾讯规则在字节路径下不适用
      must_have_augmentation: false,
      rationale:
        '赵六(C++/Lua 游戏后端)推字节 TikTok 前端岗。腾讯规则 (10-38/10-43)' +
        '在字节路径下 applicable=false(客户不匹配,规则不适用)。' +
        '通用 10-5(技能一票否决)必命中。',
    },
  },
  {
    id: 's10-clean-tencent-cdg',
    candidate_id: 'c01-zhangsan-clean',
    jd_id: 'jr-tencent-cdg-data',
    expected: {
      // 张三(前端)推腾讯 CDG 数据岗位
      // - 10-5 技能不匹配:张三是 React/TS 前端,CDG 岗位通常要 Java/Spark/SQL
      // - 应该 FAIL on 10-5
      decision: 'FAIL',
      llm_decision: 'FAIL',
      must_fail_rule_ids: ['10-5'],
      must_pass_rule_ids: ['10-25', '10-38'], // 无华为/腾讯历史
      must_have_augmentation: false,
      rationale:
        '张三是 React/TS 前端工程师,推腾讯 CDG 数据分析岗 → 技能完全不匹配,' +
        '10-5 硬性要求一票否决必命中。',
    },
  },
];

// ─── 工具方法 ───

export function candidateById(id: string) {
  const c = CANDIDATES.find((x) => x.id === id);
  if (!c) throw new Error(`candidate fixture not found: ${id}`);
  return c;
}

export function jdById(id: string) {
  const j = JOB_REQUISITIONS.find((x) => x.id === id);
  if (!j) throw new Error(`JD fixture not found: ${id}`);
  return j;
}

export function scenarioById(id: ScenarioId): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`scenario not found: ${id}`);
  return s;
}
