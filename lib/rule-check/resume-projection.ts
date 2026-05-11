// Resume projection — Kenny §2 关键:不发整段 parsed resume 给 LLM,
// 只发评估本批次规则需要的最小字段子集。
//
// 收益:
//   - 减 50-80% prompt token(整简历 ~3000 token → partial ~600 token)
//   - LLM 注意力集中(不会因为看到"教育背景 GPA"而误判腾讯历史从业规则)
//   - 触发证据更聚焦(evidence 字段引用的就是相关字段而非整简历)
//
// 字段 map 覆盖范围:
//   Phase 1:51 条 matchResume 规则全部覆盖(<rule_id> → required ParsedResume fields)
//   Phase 3:把这个 map 迁到 ontology Rule 节点的 requiredResumeFields 字段
//   (届时本文件改为从 Rule 节点读取,不再硬编码)
//
// 维护约定:每加一条新规则 → 必须在 RULE_REQUIRED_FIELDS 加一条 entry。
// LINT(`assertAllRulesMapped`)校验:`rule.id` 在 ontology 出现但 map 缺,build 失败。

import type { Rule } from './types';

// ─── ParsedResume 上所有可投影字段(types 名字跟 RaasParseResumeData 对齐) ───
// 注意:这里用字面量 union,不直接 import RaasParseResumeData 类型,因为
// 我们要做的是"按字段名 pick",ts 不能从值-空间 keyof 反推到字面量。
export type ResumeField =
  | 'name'
  | 'email'
  | 'phone'
  | 'location'
  | 'summary'
  | 'experience'         // 工作经历
  | 'education'          // 教育经历
  | 'skills'
  | 'certifications'
  | 'languages'
  | 'rawText'
  | 'birth_date'
  | 'gender'
  | 'nationality'
  | 'marital_status'
  | 'conflict_of_interest'      // 利益冲突声明
  | 'expected_salary_range'
  | 'outsourcing_acceptance'    // 是否接受人力外包模式
  | 'labor_form_preference'     // 实习/兼职/正式偏好
  | 'former_csi_employment'     // 华腾/中软国际历史(高风险离场编码核查)
  | 'gap_periods'               // 空窗期记录
  | 'former_tencent_employment'; // 腾讯历史从业(正编/外包/工作室)

// ─── 51 条规则 → 字段需求 map ───
// 规则来源:lib/rule-check/rules.json,id starts with "10-"
// 字段需求来源:rule.standardizedLogicRule 文本里提到的简历字段
// 维护人:rule check team(陈洋长期会把这个迁到 ontology Rule 节点上)

export const RULE_REQUIRED_FIELDS: Record<string, readonly ResumeField[]> = {
  // ═════ STEP 1:红线与黑名单(experience-heavy)═════
  '10-25': ['experience'],                                            // 华为荣耀竞业冷冻
  '10-26': ['experience'],                                            // OPPO 小米竞业冷冻
  '10-38': ['experience'],                                            // 腾讯历史从业识别
  '10-39': ['former_tencent_employment'],                             // 腾讯历史从业核实结果(HSM 反馈触发)
  '10-40': ['former_tencent_employment'],                             // 腾讯主动离职紧急回流
  '10-17': ['former_csi_employment'],                                 // CSI 高风险回流(B7-1 / B3 / A15 / B8 编码)
  '10-18': ['former_csi_employment'],                                 // CSI EHS 风险回流(A13(1))
  '10-16': ['former_csi_employment'],                                 // CSI 被动释放(YCH 非高风险)
  '10-19': ['former_csi_employment'],                                 // CSI 被动释放特殊审批(HSM 判定)
  '10-20': ['former_csi_employment'],                                 // CSI EHS 特殊审批(BG HRD 审批)

  // ═════ STEP 2:硬性要求(全条件)═════
  '10-5':  ['education', 'skills', 'languages', 'gender', 'birth_date'], // 一票否决:学历+技能+语言+性别+年龄
  '10-21': ['birth_date'],                                            // 年龄红线上限
  '10-22': ['birth_date'],                                            // 35 岁隐形门槛(只标记,不终止)
  '10-14': ['languages'],                                              // 外语硬性证书
  '10-35': ['nationality'],                                            // 腾讯外籍候选人通道限制
  '10-13': ['education', 'birth_date'],                                // 教育周期偏差人工核查(年龄逻辑)
  '10-12': ['education', 'birth_date'],                                // 教育周期年限偏差自动预警
  '10-11': ['labor_form_preference'],                                  // 劳务形式校验(实习/兼职/正式)
  '10-6':  ['experience', 'skills', 'education'],                      // 加分项识别(work_years/名企/技能超配)
  '10-15': ['outsourcing_acceptance'],                                 // 特殊工时与出差意愿(轮班/夜班/长期出差)
  '10-47': ['gender', 'birth_date', 'marital_status'],                 // 腾讯婚育风险(女 >26 未婚/已婚未育)
  '10-7':  ['expected_salary_range'],                                  // 期望薪资 vs 岗位上限
  '10-36': ['gender', 'birth_date', 'marital_status'],                 // 字节婚育风险(女 >28)
  '10-30': ['education'],                                              // 最低学历资格(<专科特批)
  '10-54': ['experience'],                                             // 对标公司/行业画像负向要求命中
  '10-31': ['education'],                                              // 无学历候选人特批
  '10-9':  ['education', 'experience', 'gap_periods'],                 // 履历空窗期检测(>3 个月空白)
  '10-10': ['experience', 'gap_periods'],                              // 空窗期 + 职业稳定性(消极理由 / 平均 <1 年)
  '10-8':  ['outsourcing_acceptance'],                                 // 候选人意愿度(外包模式排斥)

  // ═════ STEP 3:加分项 + 回流冷冻期 ═════
  '10-4':  [],                                                         // IEG 简历改推报备(HSM 流程,无需简历字段)
  '10-37': ['gender', 'birth_date', 'marital_status'],                 // 婚育风险人工管控(HSM 解除)
  '10-56': ['experience'],                                             // 腾娱互动子公司 6 个月冷冻
  '10-33': [],                                                         // 字节客户退场回流(基于系统记录,不看简历)
  '10-27': ['conflict_of_interest'],                                   // 腾讯亲属回避(利益冲突声明)
  '10-28': ['conflict_of_interest'],                                   // 腾讯亲属回避处理(HSM 反馈触发)
  '10-49': ['experience'],                                             // 字节正编员工回流标记
  '10-53': [],                                                         // 非 IEG 跳过技术面(无简历字段需求)
  '10-2':  [],                                                         // 字节新需求 HC 冻结候选人召回(系统逻辑)
  '10-50': ['experience'],                                             // 字节正编 BP 核查
  '10-45': ['former_tencent_employment'],                              // 腾讯正编转外包受控标记
  '10-24': [],                                                         // JD 关联到原始需求(基于元数据,不看简历)
  '10-1':  [],                                                         // 字节新需求滞留简历优先转推(系统逻辑)
  '10-51': [],                                                         // 字节正编客户 BP 放行(HSM 反馈)
  '10-32': [],                                                         // 岗位冷冻期(系统记录,不看简历)
  '10-3':  [],                                                         // IEG 活跃流程改推拦截(系统状态)
  '10-34': ['experience'],                                             // 字节友商非 BPO 外包 6 个月冷冻
  '10-29': [],                                                         // 二次入职 3 个月提醒(系统记录)
  '10-52': [],                                                         // IEG 内部技术面试强制(流程节点,不看简历)
  '10-46': ['former_tencent_employment'],                              // 腾讯正编转外包凭证校验
  '10-42': ['experience', 'former_tencent_employment'],                // CDG 6 个月回流绝对拦截
  '10-43': ['experience'],                                             // IEG 四大工作室互斥
};

// ─── 工具函数 ───

/**
 * 投影 parsed resume → 仅保留 applicableRules 需要的字段。
 *
 * `name` 始终保留(给 LLM context anchor)。空字段也会保留键(便于 LLM
 * 看到 "这字段 RAAS 提供了但是空" vs "这字段根本没提供")。
 */
export function projectResume(
  parsedResume: Record<string, unknown> | null | undefined,
  applicableRules: ReadonlyArray<Rule>,
): Record<string, unknown> {
  if (!parsedResume) return {};

  const fieldsNeeded = new Set<ResumeField>(['name']);
  for (const rule of applicableRules) {
    const map = RULE_REQUIRED_FIELDS[rule.id];
    if (map) {
      for (const f of map) fieldsNeeded.add(f);
    }
    // 如果 map 缺 entry,这条规则不贡献字段(防御性 — 不抛,只是不投影)
    // CI 用 assertAllRulesMapped 做硬约束。
  }

  const out: Record<string, unknown> = {};
  for (const f of fieldsNeeded) {
    if (f in parsedResume) {
      out[f] = parsedResume[f];
    }
  }
  return out;
}

/**
 * Lint helper:本仓 CI / 单测可调用,确保 rules.json 里所有 rule_id
 * 都在 RULE_REQUIRED_FIELDS 里有 entry。新加规则忘了更新 map → fail-fast。
 */
export function assertAllRulesMapped(
  allRuleIds: ReadonlyArray<string>,
): { ok: true } | { ok: false; missing: string[] } {
  const missing = allRuleIds.filter((id) => !(id in RULE_REQUIRED_FIELDS));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * 给 audit 用 — 返回本次实际投影出来的字段名列表(LLM prompt size 分析、
 * partial-coverage 监控用)。
 */
export function fieldsProjected(
  applicableRules: ReadonlyArray<Rule>,
): ResumeField[] {
  const set = new Set<ResumeField>(['name']);
  for (const rule of applicableRules) {
    const map = RULE_REQUIRED_FIELDS[rule.id];
    if (map) for (const f of map) set.add(f);
  }
  return [...set];
}
