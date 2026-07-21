/**
 * Manual runner for `runRuleCheck` — neo4j-aware matchResume rule evaluation.
 *
 * Edit the parameters below, then run:
 *   npx tsx scripts/run-match-resume-rule-check.ts
 *
 * Prerequisites:
 *
 *  1. Ontology API (the Studio app) running on http://localhost:3500.
 *     The library reads candidate, resume, job_requisition, applications,
 *     blacklist hits, and employment links from there.
 *  2. The candidate, resume, and JD exist as instance nodes in neo4j under
 *     the RAAS-v1 domain. Use the studio's /api/v1/ontology/instances UI or
 *     POST endpoints to seed them if the dev DB is empty.
 *  3. LLM gateway configured via env. Either:
 *       AI_BASE_URL=...    AI_API_KEY=...    (preferred — internal gateway)
 *     or:
 *       OPENAI_API_KEY=...                   (fallback — direct OpenAI)
 *  4. ONTOLOGY_API_BASE / ONTOLOGY_API_TOKEN set (already in your .env.local
 *     since earlier work).
 *
 * The script prints the full MatchResumeCheckResult to stdout — decision,
 * stats, per-rule rule_results, derived explanations, and audit metadata.
 */

import { buildRuleCheckInput, runRuleCheck } from "../lib/rule-check";

// ============================================================================
// 参数 — edit these to taste
// ============================================================================

// candidate_id is the primary handle. The library uses it to:
//   - GET /instances/Candidate/{candidate_id}
//   - listInstances("Resume",     { candidate_id })  → first row
//   - listInstances("Application",{ candidate_id })
//   - listInstances("Blacklist",  { candidate_id })
//   - listLinks({ from: candidate_id, type: "EMPLOYED_BY" })
const candidate_id = "C-100023";

// job_requisition_id is the second handle. The library does:
//   - GET /instances/Job_Requisition/{job_requisition_id}
const job_requisition_id = "JR-2026-001";

// The job_requisition object is also injected into the prompt as §2.2 Inputs.
// Include whatever structured fields you have; client_id / business_group
// drive the rule-filtering dimensions (CLI_TENCENT_PCG → 腾讯 / PCG).
const job_requisition = {
  job_requisition_id,
  client_id: "CLI_TENCENT_PCG",
  client_department_id: "CLI_TENCENT_IEG_TIANMEI",
  title: "高级后端工程师",
  job_responsibility: "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。",
  required_skills: ["Java", "Spring Boot", "MySQL"],
  preferred_skills: ["Kafka", "Redis"],
  min_years_experience: 5,
  education: "本科及以上",
  age_max: 40,
};

// Optional: RAAS Job_Requisition_Specification (priority / deadline / HSM id).
// Pass null if not applicable.
const job_requisition_specification: Record<string, unknown> | null = null;

// Optional: prior HSM feedback for this (candidate, JR) pair. Pass null if
// this is the first match attempt.
const hsm_feedback: Record<string, unknown> | null = null;

// runtime_context fields. candidate_id is the load-bearing one; the rest are
// mainly for telemetry / log correlation.
const runtime_context = {
  upload_id: "upload_demo",
  candidate_id,
  resume_id: "R-100023",
  employee_id: "EMP_001",
  filename: "zhangsan-resume.pdf",
  received_at: new Date().toISOString(),
  trace_id: null as string | null,
};

// ============================================================================
// run
// ============================================================================

async function main(): Promise<void> {
  console.log(
    `→ runRuleCheck candidate_id=${candidate_id} job_requisition_id=${job_requisition_id}`,
  );

  const input = buildRuleCheckInput({
    runtime_context,
    parsed_resume: null, // ignored by the library — resume comes from neo4j
    job_requisition,
    job_requisition_specification,
    hsm_feedback,
  });

  const t0 = Date.now();
  const result = await runRuleCheck(input);
  const elapsedMs = Date.now() - t0;

  console.log("\n========== MatchResumeCheckResult ==========\n");
  console.log(JSON.stringify(result, null, 2));
  console.log("\n========== summary ==========");
  console.log(`decision      : ${result.decision}`);
  console.log(
    `stats         : pass=${result.stats.pass} fail=${result.stats.fail} pending=${result.stats.pending} ` +
      `info=${result.stats.insufficient_info} not_triggered=${result.stats.not_triggered} not_executed=${result.stats.not_executed} ` +
      `(total=${result.stats.total})`,
  );
  console.log(`rule_results  : ${result.rule_results.length} entries`);
  console.log(`explanations  : ${result.explanations.length} entries`);
  console.log(
    `audit         : rules_evaluated=${result.audit.rules_evaluated} graph_calls=${result.audit.graph_calls} ` +
      `model=${result.audit.llm_model} tool_rounds=${result.audit.llm_round_trips} ` +
      `llm_ms=${result.audit.llm_duration_ms}${result.audit.fail_reason ? ` fail_reason=${result.audit.fail_reason}` : ""}`,
  );
  console.log(`wall          : ${elapsedMs}ms`);
}

main().catch((err) => {
  console.error("✗ failed:", err);
  process.exit(1);
});
