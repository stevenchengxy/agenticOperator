// 真实 run 规则校验「模拟运行」—— 把一条**可见的** audit 写进本地 AO Postgres,
// 让 /rule-check 审计页能看到修复后(client_department 兜底 → bg=CDG)的结果,
// **不碰 RAAS / partner-pg / 生产配置**。
//
// 背景:run 01KTKGJ0QC8PQCTHZ6FVDVKFY4(候选人陈思 · 腾讯 CDG 岗位 TEST334)当时
// partner-pg 没解析出 bg(sd_org_name='Technology'),10-42 被 fail-closed 漏掉,
// 真实 audit 落库时 business_group=null、rules_total=4。partner-pg 现在又不可达
// (ECONNREFUSED),没法靠「重跑」演示修复。这里改用**真实的分类逻辑** ruleProvenance(),
// 喂入 Part A(rule-fetch-real-run.test.ts)已证实会被解析出的 dims(client=腾讯,
// bg=CDG),算出真实 provenance(10-42 纳入),再用 app 的 prisma 写一条模拟 audit。
//
// 写的是独立 audit_id(rca_sim_…),不覆盖真实那条;llm_model 标注「simulation」。
// 跑:`npm run simulate:rule-check`

import { prisma } from '@/server/db';
import { ruleProvenance } from '@/lib/rule-check/api-rule-fetcher';
import { severityForRuleId } from '@/lib/rule-check/ontology';
import {
  REAL_ACTION_RULES,
  REAL_ANCHORS,
  REAL_PARSED_RESUME,
  realJobRequisitionDetail,
} from '@/server/inngest/agents/__fixtures__/real-run-chensiying';

const CLIENT_NAME = '腾讯'; // resolveClientName(partner-pg client) 的真实解析值
const BG = 'CDG'; // resolveDepartmentBg(partner-pg client_department 兜底)的真实解析值

async function main() {
  // 1) 真实分类逻辑:11 条候选规则 × (腾讯, CDG) → provenance(5 纳入含 10-42 / 6 排除)
  const provenance = REAL_ACTION_RULES.map((r) =>
    ruleProvenance(r as unknown as Record<string, unknown>, CLIENT_NAME, BG),
  );
  const included = provenance.filter((p) => p.included);
  const byId = new Map(REAL_ACTION_RULES.map((r) => [r.id, r]));

  // 2) 逐条判定:陈思无腾讯经历 → 回流类(腾讯)规则不触发但 PASS;通用竞对规则 not_triggered
  const ruleResults = included.map((p) => {
    const isTencentRule = byId.get(p.rule_id)?.applicableClient === '腾讯';
    return {
      rule_id: p.rule_id,
      rule_name: byId.get(p.rule_id)?.businessLogicRuleName ?? '',
      status: isTencentRule ? 'pass' : 'not_triggered',
      reason: isTencentRule
        ? '候选人无腾讯/腾讯外包经历,回流冷冻类规则不触发'
        : '非该客户竞对挖角场景,规则不触发',
    };
  });

  const auditId = `rca_sim_${REAL_ANCHORS.job_requisition_id}`;
  const flags = included.map((p) => {
    const rr = ruleResults.find((x) => x.rule_id === p.rule_id)!;
    return {
      flag_id: `${auditId}::${p.rule_id}`,
      audit_id: auditId,
      rule_id: p.rule_id,
      rule_name_snapshot: rr.rule_name,
      severity: severityForRuleId(p.rule_id),
      applicable: rr.status !== 'not_triggered',
      result: rr.status === 'pass' ? 'PASS' : 'NOT_TRIGGERED',
      evidence: rr.reason,
      next_action: 'continue',
    };
  });

  const auditData = {
    run_id: `sim-${REAL_ANCHORS.upload_id}`,
    trace_id: null,
    upload_id: REAL_ANCHORS.upload_id,
    candidate_id: REAL_ANCHORS.candidate_id,
    resume_id: REAL_ANCHORS.resume_id,
    job_requisition_id: REAL_ANCHORS.job_requisition_id,
    client_name: REAL_ANCHORS.client_id,
    client_display_name: CLIENT_NAME,
    business_group: BG,
    studio: null,
    decision: 'PASS',
    llm_decision: 'PASS',
    failure_reasons: '[]',
    llm_model: '(simulation · 确定性分类 · 见 rule-fetch-real-run.test.ts)',
    llm_duration_ms: 0,
    llm_prompt_tokens: null,
    llm_completion_tokens: null,
    rules_evaluated: included.length,
    rules_total_in_ontology: provenance.length,
    rule_source: 'ontology-api',
    fail_reason: null,
    partial_resume_fields: '[]',
    rule_provenance: JSON.stringify(provenance),
    user_prompt: `（模拟运行 · 真实 run 01KTKGJ0QC8PQCTHZ6FVDVKFY4 · 候选人陈思 · 腾讯 CDG 岗位）`,
    system_prompt: null,
    llm_raw_text: JSON.stringify({ rule_results: ruleResults }),
    parsed_resume_json: JSON.stringify(REAL_PARSED_RESUME),
    job_requisition_json: JSON.stringify(realJobRequisitionDetail()),
  };

  await prisma.$transaction(async (tx) => {
    await tx.ruleCheckFlag.deleteMany({ where: { audit_id: auditId } });
    await tx.ruleCheckAudit.upsert({
      where: { audit_id: auditId },
      create: { audit_id: auditId, ...auditData },
      update: auditData,
    });
    await tx.ruleCheckFlag.createMany({ data: flags });
  });

  const excluded = provenance.filter((p) => !p.included);
  console.log(`✓ 已写入模拟 audit: ${auditId}`);
  console.log(`  打开 http://localhost:3002/rule-check → 找 ${REAL_ANCHORS.job_requisition_id}（client_display_name=腾讯 / bg=CDG）`);
  console.log(`  规则库 ${provenance.length} → 排除 ${excluded.length} → 选中 ${included.length}`);
  console.log(`  选中: ${included.map((p) => p.rule_id).join(', ')}  ← 含 10-42(CDG)`);
  console.log(`  排除: ${excluded.map((p) => p.rule_id).join(', ')}`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('[simulate-rule-check] FAILED:', e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
