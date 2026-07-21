// scripts/migrate-rules-v0-1-002.ts
//
// 一次性迁移脚本:把 neo4j_data/rules_v0_1_002.json 灌进:
//   1. lib/rule-check/rules.json  (本地 fallback,覆盖)
//   2. Neo4j :Rule 节点          (DETACH DELETE + UNWIND 重建)
//
// 跑法: npx tsx --env-file=.env.local scripts/migrate-rules-v0-1-002.ts
//
// GOVERNS 关系会随 DETACH DELETE 丢失 — 详见 spec §4.3。

import fs from 'node:fs';
import path from 'node:path';
import neo4j from 'neo4j-driver';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(PROJECT_ROOT, 'neo4j_data', 'rules_v0_1_002.json');
const TARGET_JSON = path.join(PROJECT_ROOT, 'lib', 'rule-check', 'rules.json');

interface RawRule {
  id: string;
  specificScenarioStage: string;
  businessLogicRuleName: string;
  applicableClient: string;
  applicableDepartment: string;
  submissionCriteria: string;
  standardizedLogicRule: string;
  relatedEntities: string[];
  businessBackgroundReason: string;
  ruleSource: string;
  executor: 'Agent' | 'Human';
  enforcementLevel: 'mandatory' | 'optional';
  failurePolicy: 'block' | 'warn';
}

interface RulesFile {
  metadata: { project_name: string; document_type: string; version: string; last_updated: string; description: string };
  rules: RawRule[];
}

async function main() {
  // 1. 读 + 验证源文件
  const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8')) as RulesFile;
  if (raw.metadata.version !== '0.2') {
    throw new Error(`Expected version 0.2, got ${raw.metadata.version}`);
  }
  if (!Array.isArray(raw.rules) || raw.rules.length !== 248) {
    throw new Error(`Expected 248 rules, got ${raw.rules?.length}`);
  }
  for (const r of raw.rules) {
    if (!r.enforcementLevel || !r.failurePolicy) {
      throw new Error(`Rule ${r.id} missing enforcementLevel or failurePolicy`);
    }
  }
  console.log(`[migrate] source OK: 248 rules, version=${raw.metadata.version}`);

  // 2. Neo4j 操作
  const uri = process.env.NEO4J_INSTANCE_URI ?? 'bolt://localhost:7688';
  const user = process.env.NEO4J_INSTANCE_USER ?? 'neo4j';
  const pw = process.env.NEO4J_INSTANCE_PASSWORD ?? 'testpassword123';
  const db = process.env.NEO4J_INSTANCE_DATABASE ?? 'neo4j';
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pw));

  try {
    const session = driver.session({ database: db });
    try {
      // 2a. 记录现存 GOVERNS 关系数(post-check 用)
      const preGoverns = await session.run(
        `MATCH (:Rule)-[g:GOVERNS]->(:ActionStep) RETURN count(g) AS cnt`,
      );
      const preGovernsCount = preGoverns.records[0]?.get('cnt')?.toNumber() ?? 0;
      console.log(`[migrate] pre-flight: ${preGovernsCount} GOVERNS relationships exist`);

      // 2b. DETACH DELETE 全部 :Rule
      await session.run(`MATCH (r:Rule) DETACH DELETE r`);
      console.log(`[migrate] deleted Rule nodes`);

      // 2c. UNWIND 写入新 rules
      const insertResult = await session.run(
        `UNWIND $rules AS row
         CREATE (r:Rule)
         SET r = row, r.imported_at = datetime()
         RETURN count(r) AS inserted`,
        { rules: raw.rules },
      );
      const inserted = insertResult.records[0]?.get('inserted')?.toNumber() ?? 0;
      console.log(`[migrate] inserted ${inserted} Rule nodes`);

      // 2d. post-check
      const postCheck = await session.run(
        `MATCH (n:Rule) WHERE n.enforcementLevel IS NULL RETURN count(n) AS missing`,
      );
      const missing = postCheck.records[0]?.get('missing')?.toNumber() ?? 0;
      if (missing !== 0) throw new Error(`${missing} rules still missing enforcementLevel`);

      const sample = await session.run(
        `MATCH (n:Rule {id: '10-25'}) RETURN n.enforcementLevel AS el, n.failurePolicy AS fp, n.businessLogicRuleName AS name`,
      );
      const row = sample.records[0];
      console.log(
        `[migrate] sample rule 10-25: enforcementLevel=${row?.get('el')} ` +
          `failurePolicy=${row?.get('fp')} ` +
          `name="${row?.get('name')}"`,
      );
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }

  // 3. 覆盖本地 JSON
  fs.copyFileSync(SOURCE, TARGET_JSON);
  console.log(`[migrate] wrote ${TARGET_JSON}`);

  console.log('[migrate] ✅ complete. NOTE: GOVERNS relationships dropped — run restore script if needed.');
}

main().catch((e) => {
  console.error('[migrate] ❌ failed:', e);
  process.exit(1);
});
