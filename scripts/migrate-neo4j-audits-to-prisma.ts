// 一次性迁移脚本 — Neo4j :RuleCheckAudit / :RuleCheckFlag → Prisma
//
// 用途:Q架构纠偏后,把 19 条历史 audit 节点 + flag 节点搬到 Prisma 表。
// 跑完后 Neo4j 那 19 条 audit 节点可以 DETACH DELETE 清掉(本脚本不删,保险起见)。

import neo4j from 'neo4j-driver';
import { prisma } from '@/server/db';

const URI = process.env.NEO4J_INSTANCE_URI ?? 'bolt://localhost:7688';
const USER = process.env.NEO4J_INSTANCE_USER ?? 'neo4j';
const PW = process.env.NEO4J_INSTANCE_PASSWORD ?? 'testpassword123';

async function main() {
  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PW), { disableLosslessIntegers: true });
  const session = driver.session({ database: 'neo4j' });

  console.log('── 拉 Neo4j 全量 :RuleCheckAudit + :HAS_FLAG → :RuleCheckFlag ──');
  const r = await session.run(`
    MATCH (a:RuleCheckAudit)
    OPTIONAL MATCH (a)-[:HAS_FLAG]->(f:RuleCheckFlag)
    WITH a, collect(f) AS flags
    RETURN a, flags
    ORDER BY a.created_at
  `);

  let migratedAudits = 0;
  let migratedFlags = 0;
  let skipped = 0;
  let errors = 0;

  for (const rec of r.records) {
    const a = rec.get('a').properties as Record<string, unknown>;
    const flags = (rec.get('flags') as Array<{ properties: Record<string, unknown> }> | null) ?? [];

    const audit_id = String(a.audit_id ?? '');
    if (!audit_id) {
      skipped++;
      continue;
    }

    // 检查 Prisma 是否已有
    const exists = await prisma.ruleCheckAudit.findUnique({ where: { audit_id } });
    if (exists) {
      console.log(`  ○ skip ${audit_id.slice(0, 50)} (Prisma 已有)`);
      skipped++;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.ruleCheckAudit.create({
          data: {
            audit_id,
            run_id: String(a.run_id ?? `legacy_${audit_id}`),
            scenario_id: (a.scenario_id as string) ?? null,
            trace_id: (a.trace_id as string) ?? null,
            upload_id: String(a.upload_id ?? ''),
            candidate_id: String(a.candidate_id ?? ''),
            resume_id: String(a.resume_id ?? ''),
            job_requisition_id: String(a.job_requisition_id ?? ''),
            client_name: (a.client_name as string) ?? null,
            business_group: (a.business_group as string) ?? null,
            studio: (a.studio as string) ?? null,
            decision: String(a.decision ?? 'FAIL'),
            llm_decision: String(a.llm_decision ?? 'UNKNOWN'),
            failure_reasons: JSON.stringify(Array.isArray(a.failure_reasons) ? a.failure_reasons : []),
            llm_model: String(a.llm_model ?? 'unknown'),
            llm_duration_ms: typeof a.llm_duration_ms === 'number' ? Math.round(a.llm_duration_ms) : 0,
            llm_prompt_tokens: typeof a.llm_prompt_tokens === 'number' ? a.llm_prompt_tokens : null,
            llm_completion_tokens: typeof a.llm_completion_tokens === 'number' ? a.llm_completion_tokens : null,
            parse_error: (a.parse_error as string) ?? null,
            rules_evaluated: typeof a.rules_evaluated === 'number' ? a.rules_evaluated : 0,
            rules_total_in_ontology:
              typeof a.rules_total_in_ontology === 'number' ? a.rules_total_in_ontology : 0,
            rule_source: String(a.rule_source ?? 'unknown'),
            partial_resume_fields: JSON.stringify(Array.isArray(a.partial_resume_fields) ? a.partial_resume_fields : []),
            parsed_resume_json: (a.parsed_resume_json as string) ?? null,
            job_requisition_json: (a.job_requisition_json as string) ?? null,
            user_prompt: (a.user_prompt as string) ?? null,
            system_prompt: (a.system_prompt as string) ?? null,
            llm_raw_text: (a.llm_raw_text as string) ?? null,
            resume_augmentation: (a.resume_augmentation as string) ?? null,
            parent_audit_id: (a.parent_audit_id as string) ?? null,
            created_at: a.created_at ? new Date(String(a.created_at)) : new Date(),
          },
        });

        if (flags.length > 0) {
          await tx.ruleCheckFlag.createMany({
            data: flags
              .filter((f) => f && f.properties)
              .map((f) => {
                const p = f.properties;
                return {
                  flag_id: String(p.flag_id ?? `${audit_id}::${p.rule_id}`),
                  audit_id,
                  rule_id: String(p.rule_id ?? ''),
                  rule_name_snapshot: String(p.rule_name_snapshot ?? ''),
                  severity: String(p.severity ?? 'flag_only'),
                  applicable_client: (p.applicable_client as string) ?? null,
                  applicable: Boolean(p.applicable),
                  result: String(p.result ?? 'NOT_APPLICABLE'),
                  evidence: (p.evidence as string) ?? null,
                  next_action: (p.next_action as string) ?? null,
                };
              }),
          });
        }
      });
      migratedAudits++;
      migratedFlags += flags.length;
      console.log(`  ✓ ${audit_id.slice(0, 50)} (${flags.length} flags)`);
    } catch (e) {
      console.log(`  ✗ ${audit_id.slice(0, 50)}: ${(e as Error).message.slice(0, 100)}`);
      errors++;
    }
  }

  await session.close();
  await driver.close();
  await prisma.$disconnect();

  console.log();
  console.log(`── 迁移结果 ──`);
  console.log(`  迁移: ${migratedAudits} audit / ${migratedFlags} flag`);
  console.log(`  跳过: ${skipped} (Prisma 已有)`);
  console.log(`  错误: ${errors}`);
}

main().catch((e) => {
  console.error('migration error:', e);
  process.exit(1);
});
