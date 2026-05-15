// @ts-nocheck — WIP, depends on allmeta-client.writeMatchResult /
// patchInstance which aren't yet exported in main.
// Neo4j writer — Candidate_Match_Result
//
// 写 rule-check + matchResume 合并结果到 Neo4j 实例图。这是 AO 跟 RAAS 之间的
// **共享数据契约**:AO 写入,RAAS 后读(典型场景:RAAS 查"这条 candidate 在哪些
// JR 上拿到了什么决策"用于工作台 / 报表 / 通知)。
//
// 数据来源说明:
//   - rule-check 维度 → AO 端 rule-check LLM 自己跑出来
//   - match 维度      → AO 调 RAAS API Server `/api/v1/match-resume`(RAAS 内部
//                       proxy 到 Robohire),返回值含 matchScore / recommendation
//                       等。**调用链是 AO → RAAS → Robohire**,不直接调 Robohire。
//                       所以 properties 用 `match_*` 不用 `robohire_*`,避免误导
//                       partner 这是直连 Robohire 拿的。
//
// ontology DataObject 已定义 `Candidate_Match_Result` (id/client_id/candidate_id/
// job_position_id/result/reason),schema 偏窄 — 我们额外写 rule-check 维度 +
// match 维度 + 决策元信息 properties。Neo4j 是 property bag,多写不报错;
// 等陈洋 ontology 扩字段后再正式对齐(见 docs/ontology-schema-changes-for-chenyang.md)。
//
// 节点 ID 规则:`cmr_<rule_check_audit_id>` — 跟 Prisma RuleCheckAudit 一对一,便于回查。
// 关系:
//   (Candidate)-[:HAS_MATCH_RESULT]->(Candidate_Match_Result)
//   (Candidate_Match_Result)-[:FOR_JOB_REQUISITION]->(Job_Requisition)

import neo4j, { type Driver, type Session } from 'neo4j-driver';

export interface MatchResultProps {
  candidate_match_result_id: string;
  candidate_id: string;
  job_requisition_id: string;
  client_id?: string | null;

  // rule-check 维度
  rule_check_audit_id: string;
  rule_check_decision: 'PASS' | 'FAIL';
  failure_reason_codes: string[];
  rules_evaluated_count: number;
  terminal_rule_hits: string[];

  // match 维度(来自 AO → RAAS `/api/v1/match-resume`;rule-check FAIL 时全为 null)
  match_score: number | null;            // RAAS 返回 data.matchScore(Robohire-sourced)
  match_recommendation: string | null;   // RAAS 返回 data.recommendation
  match_breakdown_json: string | null;   // RAAS 返回 data 整段(skillMatch / experienceMatch / ...)
  raas_match_request_id: string | null;  // RAAS API response.requestId — 跟 RAAS 服务端日志关联

  // 决策
  final_decision: 'PASS' | 'FAIL';
  final_decision_reason: string;
  decided_at: string;

  // 谱系(补全后重判时指向上一次结果;否则 null)
  parent_match_result_id: string | null;
}

let __driver: Driver | null = null;
function getDriver(): { driver: Driver; database: string } | null {
  if (__driver) {
    return {
      driver: __driver,
      database: process.env.NEO4J_INSTANCE_DATABASE ?? process.env.RAAS_LINKS_NEO4J_DATABASE ?? 'neo4j',
    };
  }
  const uri = process.env.NEO4J_INSTANCE_URI ?? process.env.RAAS_LINKS_NEO4J_URI;
  const user = process.env.NEO4J_INSTANCE_USER ?? process.env.RAAS_LINKS_NEO4J_USER;
  const password = process.env.NEO4J_INSTANCE_PASSWORD ?? process.env.RAAS_LINKS_NEO4J_PASSWORD;
  if (!uri || !user || !password) return null;
  try {
    __driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      connectionTimeout: 5_000,
      disableLosslessIntegers: true,
    });
    return {
      driver: __driver,
      database: process.env.NEO4J_INSTANCE_DATABASE ?? process.env.RAAS_LINKS_NEO4J_DATABASE ?? 'neo4j',
    };
  } catch {
    return null;
  }
}

/**
 * 写 Candidate_Match_Result 节点 + 关系。
 *
 * Idempotent:`MERGE` by `candidate_match_result_id`,多次跑只更新 props。
 *
 * 失败行为:
 *   - Neo4j 不可达 / 写失败 → log warning,**永远不抛**(Inngest step 不会因 Neo4j 失败重试)
 *   - 配置缺 → 静默 skip(返回 wrote=false reason='not_configured')
 *   - 关联的 Candidate / Job_Requisition 节点缺失 → 只写 Match_Result 节点本身,关系建不上但不抛
 */
export async function writeCandidateMatchResult(props: MatchResultProps): Promise<{
  wrote: boolean;
  reason?: string;
  via?: 'allmeta' | 'bolt';
  match_result_id?: string;
}> {
  // Phase 3:首选 Allmeta 特化端点(/actions/matchResume/results),Bolt 是 fallback
  const allmetaEnabled = process.env.ALLMETA_WRITER_ENABLED !== 'false';
  if (allmetaEnabled) {
    const r = await writeMatchResultViaAllmeta(props);
    if (r.wrote) return { ...r, via: 'allmeta' };
    // eslint-disable-next-line no-console
    console.warn(`[neo4j-match-result-writer] Allmeta failed (${r.reason}), fallback to Bolt`);
  }
  const boltResult = await writeMatchResultViaBolt(props);
  return { ...boltResult, via: 'bolt', match_result_id: props.candidate_match_result_id };
}

/** Path A:经 Allmeta 特化端点写 + PATCH 补充 rule-check 维度字段 */
async function writeMatchResultViaAllmeta(props: MatchResultProps): Promise<{
  wrote: boolean;
  reason?: string;
  match_result_id?: string;
}> {
  const { writeMatchResult, patchInstance } = await import('@/lib/allmeta-client');

  // Step 1: 调特化端点写基础 4 字段(端点自动 MERGE Candidate/JR + 建关系)
  const base = await writeMatchResult({
    candidate_id: props.candidate_id,
    job_requisition_id: props.job_requisition_id,
    result:
      props.final_decision === 'PASS'
        ? '匹配'
        : props.rule_check_decision === 'FAIL' && props.failure_reason_codes.length > 0
          ? '不匹配'
          : '待定',
    reason: props.final_decision_reason,
  });
  if (!base.ok) {
    return { wrote: false, reason: `match_result_endpoint:${base.reason}` };
  }
  const serverMatchResultId = base.data.candidateMatchResultId;

  // Step 2: PATCH 补 rule-check + Robohire 维度字段(端点写不进去,这些字段不在端点 schema)
  // 注意:这些字段是否在 :DataObject schema 里声明会决定能否被 strict validation 接受
  const extraProps: Record<string, unknown> = {
    rule_check_audit_id: props.rule_check_audit_id,
    rule_check_decision: props.rule_check_decision,
    failure_reason_codes_json: JSON.stringify(props.failure_reason_codes),
    rules_evaluated_count: props.rules_evaluated_count,
    terminal_rule_hits_json: JSON.stringify(props.terminal_rule_hits),
    final_decision: props.final_decision,
  };
  if (props.match_score !== null) extraProps.match_score = props.match_score;
  if (props.match_recommendation) extraProps.match_recommendation = props.match_recommendation;
  if (props.match_breakdown_json) extraProps.match_breakdown_json = props.match_breakdown_json;
  if (props.raas_match_request_id) extraProps.raas_match_request_id = props.raas_match_request_id;
  if (props.parent_match_result_id) extraProps.parent_match_result_id = props.parent_match_result_id;
  extraProps.ao_match_result_id = props.candidate_match_result_id; // 保留 AO 原 cmr_<audit_id> 作为可读引用

  // PATCH 失败不致命 — 基础节点已建,扩展字段 schema 不全也只是少存几个字段
  const patchR = await patchInstance('Candidate_Match_Result', serverMatchResultId, extraProps);
  if (!patchR.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[match-result-writer] PATCH extra props failed: ${patchR.reason} — base node OK`);
  }

  return { wrote: true, match_result_id: serverMatchResultId };
}

/** Path B:Bolt 直连(老路径,Allmeta 失败时 fallback) */
async function writeMatchResultViaBolt(props: MatchResultProps): Promise<{
  wrote: boolean;
  reason?: string;
}> {
  const cfg = getDriver();
  if (!cfg) return { wrote: false, reason: 'not_configured' };

  const now = new Date().toISOString();
  let session: Session | null = null;
  try {
    session = cfg.driver.session({ database: cfg.database });

    // Neo4j 不接 null 值 — 过滤掉,只 SET 有值的 properties
    const nodeProps: Record<string, unknown> = {
      candidate_match_result_id: props.candidate_match_result_id,
      candidate_id: props.candidate_id,
      job_requisition_id: props.job_requisition_id,
      rule_check_audit_id: props.rule_check_audit_id,
      rule_check_decision: props.rule_check_decision,
      failure_reason_codes: props.failure_reason_codes,
      rules_evaluated_count: props.rules_evaluated_count,
      terminal_rule_hits: props.terminal_rule_hits,
      final_decision: props.final_decision,
      final_decision_reason: props.final_decision_reason,
      decided_at: props.decided_at,
      snapshot_at: now,
    };
    if (props.client_id) nodeProps.client_id = props.client_id;
    if (props.match_score !== null) nodeProps.match_score = props.match_score;
    if (props.match_recommendation) nodeProps.match_recommendation = props.match_recommendation;
    if (props.match_breakdown_json) nodeProps.match_breakdown_json = props.match_breakdown_json;
    if (props.raas_match_request_id) nodeProps.raas_match_request_id = props.raas_match_request_id;
    if (props.parent_match_result_id) nodeProps.parent_match_result_id = props.parent_match_result_id;

    // 单事务:MERGE 节点 + 建关系(关联节点缺失时 OPTIONAL MATCH 兜底)
    await session.run(
      `MERGE (m:Candidate_Match_Result {candidate_match_result_id: $id})
       SET m += $props, m.last_seen_at = datetime($now)
       WITH m
       OPTIONAL MATCH (c:Candidate {candidate_id: $cid})
       FOREACH (cc IN CASE WHEN c IS NULL THEN [] ELSE [c] END |
         MERGE (cc)-[:HAS_MATCH_RESULT]->(m)
       )
       WITH m
       OPTIONAL MATCH (jr:Job_Requisition {job_requisition_id: $jrid})
       FOREACH (jj IN CASE WHEN jr IS NULL THEN [] ELSE [jr] END |
         MERGE (m)-[:FOR_JOB_REQUISITION]->(jj)
       )
       WITH m
       OPTIONAL MATCH (parent:Candidate_Match_Result {candidate_match_result_id: $parentId})
       FOREACH (pp IN CASE WHEN parent IS NULL THEN [] ELSE [parent] END |
         MERGE (m)-[:REPLAY_OF]->(pp)
       )`,
      {
        id: props.candidate_match_result_id,
        cid: props.candidate_id,
        jrid: props.job_requisition_id,
        parentId: props.parent_match_result_id ?? '__none__',
        props: nodeProps,
        now,
      },
    );

    return { wrote: true };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    // eslint-disable-next-line no-console
    console.warn(
      `[neo4j-match-result-writer] write failed for ${props.candidate_match_result_id}: ${msg.slice(0, 200)}`,
    );
    return { wrote: false, reason: `error:${msg.slice(0, 80)}` };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}
