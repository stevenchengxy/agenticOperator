// Neo4j 实例数据写入 — E2E test 用,直连 neo4j-driver。
//
// 长期生产路径走 Ontology API (:3500),见 docs/neo4j-instance-storage-plan.md。
// 这里 test harness 用 driver 直写,简化 ops。同样的 label / property 在两条
// 路径下应该可以无缝切换(只是 transport 层换)。
//
// 写入两类节点 + 关系:
//
//   (:RuleCheckAudit)     ← 每次 rule check 一条
//   (:RuleCheckFlag)      ← LLM rule_flags[] 里每条 applicable=true 的一条
//   (:RuleCheckAudit)-[:HAS_FLAG]->(:RuleCheckFlag)
//
// 测试结束后 verifier 用 Cypher 查回来对比 LLM 输出。

import neo4j, { type Driver, type Session } from 'neo4j-driver';

import type { RuleCheckVerdict, RuleFlag } from '../../lib/rule-check/types';

export interface WriteAuditArgs {
  audit_id: string;
  run_id: string;
  scenario_id: string;
  candidate_id: string;
  job_requisition_id: string;
  upload_id: string;
  resume_id: string;
  client_name: string;
  business_group: string | null;
  studio: string | null;
  llm_decision: 'PASS' | 'FAIL' | 'KEEP' | 'DROP' | 'PAUSE' | 'UNKNOWN';
  decision: 'PASS' | 'FAIL';
  llm_model: string;
  llm_duration_ms: number;
  llm_prompt_tokens: number | null;
  llm_completion_tokens: number | null;
  rules_evaluated: number;
  rules_total_in_ontology: number;
  rule_source: 'neo4j-direct' | 'ontology-api' | 'json-fallback' | 'unknown' | null;
  partial_resume_fields: string[] | null;
  failure_reasons: string[];
  resume_augmentation: string | null;
  /** ISO datetime string,Cypher 那边转 datetime() */
  created_at: string;
}

export interface WriteFlagArgs {
  flag_id: string;
  audit_id: string;
  rule_id: string;
  rule_name_snapshot: string;
  severity: 'terminal' | 'needs_human' | 'flag_only' | string;
  applicable: boolean;
  result: 'PASS' | 'FAIL' | 'REVIEW' | 'NOT_APPLICABLE' | string;
  evidence: string;
  next_action: string;
  created_at: string;
}

export class Neo4jInstanceWriter {
  constructor(private driver: Driver, private database: string) {}

  static fromEnv(): Neo4jInstanceWriter {
    const uri = process.env.RAAS_LINKS_NEO4J_URI;
    const user = process.env.RAAS_LINKS_NEO4J_USER;
    const password = process.env.RAAS_LINKS_NEO4J_PASSWORD;
    const database = process.env.RAAS_LINKS_NEO4J_DATABASE ?? 'neo4j';
    if (!uri || !user || !password) {
      throw new Error(
        '[neo4j-writer] RAAS_LINKS_NEO4J_{URI,USER,PASSWORD} env not configured',
      );
    }
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      connectionTimeout: 10_000,
      disableLosslessIntegers: true,
    });
    return new Neo4jInstanceWriter(driver, database);
  }

  async ping(): Promise<{ ok: boolean; serverInfo?: string; error?: string }> {
    try {
      const info = await this.driver.getServerInfo();
      return { ok: true, serverInfo: `${info.address} (${info.protocolVersion})` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async clearTestRun(runId: string): Promise<void> {
    const s = this.driver.session({ database: this.database });
    try {
      // 清掉本 run_id 之前留下的 audit 节点(reruns 用),flag 跟 audit 连着,
      // detach delete 一并清。
      await s.run(
        `MATCH (a:RuleCheckAudit {run_id: $run_id})
         OPTIONAL MATCH (a)-[:HAS_FLAG]->(f:RuleCheckFlag)
         DETACH DELETE a, f`,
        { run_id: runId },
      );
    } finally {
      await s.close();
    }
  }

  async writeAudit(args: WriteAuditArgs): Promise<void> {
    const s = this.driver.session({ database: this.database });
    try {
      await s.run(
        `MERGE (a:RuleCheckAudit {audit_id: $audit_id})
         SET a += $props,
             a.created_at = datetime($created_at)
         RETURN a.audit_id AS id`,
        {
          audit_id: args.audit_id,
          created_at: args.created_at,
          props: {
            run_id: args.run_id,
            scenario_id: args.scenario_id,
            candidate_id: args.candidate_id,
            job_requisition_id: args.job_requisition_id,
            upload_id: args.upload_id,
            resume_id: args.resume_id,
            client_name: args.client_name,
            business_group: args.business_group,
            studio: args.studio,
            llm_decision: args.llm_decision,
            decision: args.decision,
            llm_model: args.llm_model,
            llm_duration_ms: args.llm_duration_ms,
            llm_prompt_tokens: args.llm_prompt_tokens,
            llm_completion_tokens: args.llm_completion_tokens,
            rules_evaluated: args.rules_evaluated,
            rules_total_in_ontology: args.rules_total_in_ontology,
            rule_source: args.rule_source,
            partial_resume_fields: args.partial_resume_fields,
            failure_reasons: args.failure_reasons,
            resume_augmentation: args.resume_augmentation,
          },
        },
      );
    } finally {
      await s.close();
    }
  }

  async writeFlags(audit_id: string, flags: WriteFlagArgs[]): Promise<void> {
    if (flags.length === 0) return;
    const s = this.driver.session({ database: this.database });
    try {
      // 一次性 UNWIND 批量插入,然后用 audit_id 建关系
      await s.run(
        `MATCH (a:RuleCheckAudit {audit_id: $audit_id})
         UNWIND $flags AS f
         MERGE (rcf:RuleCheckFlag {flag_id: f.flag_id})
         SET rcf += f.props,
             rcf.created_at = datetime(f.props.created_at)
         MERGE (a)-[:HAS_FLAG]->(rcf)`,
        {
          audit_id,
          flags: flags.map((f) => ({
            flag_id: f.flag_id,
            props: {
              audit_id: f.audit_id,
              rule_id: f.rule_id,
              rule_name_snapshot: f.rule_name_snapshot,
              severity: f.severity,
              applicable: f.applicable,
              result: f.result,
              evidence: f.evidence,
              next_action: f.next_action,
              created_at: f.created_at,
            },
          })),
        },
      );
    } finally {
      await s.close();
    }
  }

  async readBackForVerify(audit_id: string): Promise<{
    audit: Record<string, unknown> | null;
    flags: Array<Record<string, unknown>>;
  }> {
    const s: Session = this.driver.session({ database: this.database });
    try {
      const r = await s.run(
        `MATCH (a:RuleCheckAudit {audit_id: $audit_id})
         OPTIONAL MATCH (a)-[:HAS_FLAG]->(f:RuleCheckFlag)
         RETURN a, collect(f) AS flags`,
        { audit_id },
      );
      const rec = r.records[0];
      if (!rec) return { audit: null, flags: [] };
      const auditNode = rec.get('a');
      const flagsNodes = rec.get('flags') as Array<{ properties: Record<string, unknown> }>;
      return {
        audit: auditNode?.properties ?? null,
        flags: (flagsNodes ?? [])
          .filter((n) => n !== null && n !== undefined)
          .map((n) => n.properties),
      };
    } finally {
      await s.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

// ─── 工具:RuleCheckVerdict → Audit + Flag 转换 ───

export function verdictToAuditFlags(
  verdict: RuleCheckVerdict,
  ctx: {
    run_id: string;
    scenario_id: string;
    candidate_id: string;
    job_requisition_id: string;
    upload_id: string;
    resume_id: string;
  },
): { audit: WriteAuditArgs; flags: WriteFlagArgs[] } {
  const audit_id = `rca_${ctx.run_id}_${ctx.scenario_id}`;
  const now = new Date().toISOString();
  const llm_output = verdict.llm_output;

  const audit: WriteAuditArgs = {
    audit_id,
    run_id: ctx.run_id,
    scenario_id: ctx.scenario_id,
    candidate_id: ctx.candidate_id,
    job_requisition_id: ctx.job_requisition_id,
    upload_id: ctx.upload_id,
    resume_id: ctx.resume_id,
    client_name: verdict.audit.dims.client_id,
    business_group: verdict.audit.dims.business_group,
    studio: verdict.audit.dims.studio,
    llm_decision: verdict.llm_decision,
    decision: verdict.decision,
    llm_model: verdict.audit.llm_model,
    llm_duration_ms: verdict.audit.llm_duration_ms,
    llm_prompt_tokens: verdict.audit.llm_prompt_tokens ?? null,
    llm_completion_tokens: verdict.audit.llm_completion_tokens ?? null,
    rules_evaluated: verdict.audit.rules_evaluated,
    rules_total_in_ontology: verdict.audit.rules_total_in_ontology,
    rule_source: verdict.audit.rule_source ?? null,
    partial_resume_fields: verdict.audit.partial_resume_fields ?? null,
    failure_reasons: verdict.failure_reasons,
    resume_augmentation: verdict.resume_augmentation ?? null,
    created_at: now,
  };

  // 把 llm_output.rule_flags 中 applicable=true 的全部写成 flag 节点
  const allFlags: RuleFlag[] = Array.isArray(llm_output?.rule_flags)
    ? llm_output!.rule_flags!
    : [];
  const flags: WriteFlagArgs[] = allFlags
    .filter((f) => f.applicable === true)
    .map((f) => ({
      flag_id: `rcf_${ctx.run_id}_${ctx.scenario_id}_${f.rule_id}`,
      audit_id,
      rule_id: f.rule_id,
      rule_name_snapshot: f.rule_name ?? '',
      severity: f.severity,
      applicable: f.applicable,
      result: f.result,
      evidence: f.evidence ?? '',
      next_action: f.next_action ?? '',
      created_at: now,
    }));

  return { audit, flags };
}
