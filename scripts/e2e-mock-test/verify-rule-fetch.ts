// 验证 rule fetch 的正确性 — 4 层校验:
//
//   层 1:Source of truth(ontology JSON)
//          → 我们的"原始规则集"在 event_manager/Action_and_Event_Manager/data/rules_*.json
//   层 2:Neo4j 存储
//          → schema loader 灌入 248 个 :Rule 节点(其中 51 个是 matchResume)
//   层 3:Fetch & Filter
//          → fetchRulesForMatchResume() 用 Cypher 拉 51 条
//          → applyClientFilter(dims) 按 (client × business_group × studio) 过滤
//   层 4:End-to-End Trace
//          → 跑一个真实 scenario,把 LLM prompt 里实际看到的 rule_ids
//            和 audit.rules_evaluated 拉出来对比
//
// 每层之间的"一致性"被 print 出来,任何漂移立刻可见。
//
// 用法:
//   tsx scripts/e2e-mock-test/verify-rule-fetch.ts                  # 默认场景
//   tsx scripts/e2e-mock-test/verify-rule-fetch.ts --client=腾讯 --bg=IEG --studio=天美

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '.env.local') });

process.env.NEO4J_INSTANCE_URI = process.env.NEO4J_INSTANCE_URI ?? 'bolt://localhost:7688';
process.env.NEO4J_INSTANCE_USER = process.env.NEO4J_INSTANCE_USER ?? 'neo4j';
process.env.NEO4J_INSTANCE_PASSWORD = process.env.NEO4J_INSTANCE_PASSWORD ?? 'testpassword123';

import neo4j from 'neo4j-driver';

import { applyClientFilter, classifyRules } from '../../lib/rule-check/ontology';
import { fetchRulesForMatchResume } from '../../lib/rule-check/ontology-source';
import type { OntologyDims, Rule } from '../../lib/rule-check/types';

interface CliArgs {
  client: string;
  business_group: string | null;
  studio: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { client: '腾讯', business_group: 'IEG', studio: '天美' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--client=')) args.client = a.slice('--client='.length);
    else if (a?.startsWith('--bg=')) args.business_group = a.slice('--bg='.length) || null;
    else if (a?.startsWith('--studio=')) args.studio = a.slice('--studio='.length) || null;
  }
  return args;
}

function header(title: string) {
  /* eslint-disable no-console */
  console.log('');
  console.log('━'.repeat(80));
  console.log(' ' + title);
  console.log('━'.repeat(80));
}

function section(title: string) {
  console.log('\n📋 ' + title);
  console.log('─'.repeat(78));
}

// ─── 层 1:Source of truth ───

interface JsonRuleRoot {
  rules?: Array<{ id: string; applicableClient?: string; applicableDepartment?: string; executor?: string }>;
}

function inspectSource(): { totalRules: number; matchResumeRules: string[]; jsonPath: string } {
  const jsonPath = resolve(
    process.cwd(),
    'event_manager/Action_and_Event_Manager/data/rules_20260324 (1).json',
  );
  const root = JSON.parse(readFileSync(jsonPath, 'utf-8')) as JsonRuleRoot;
  const allRules = root.rules ?? [];
  const matchResumeIds = allRules
    .filter((r) => r.id.startsWith('10-'))
    .map((r) => r.id)
    .sort();
  return { totalRules: allRules.length, matchResumeRules: matchResumeIds, jsonPath };
}

// ─── 层 2:Neo4j 存储 ───

async function inspectNeo4j(): Promise<{
  totalRuleNodes: number;
  matchResumeRuleIds: string[];
  hasActionLink: boolean;
  hasRuleRelCount: number;
}> {
  const driver = neo4j.driver(
    process.env.NEO4J_INSTANCE_URI!,
    neo4j.auth.basic(process.env.NEO4J_INSTANCE_USER!, process.env.NEO4J_INSTANCE_PASSWORD!),
    { connectionTimeout: 10_000, disableLosslessIntegers: true },
  );
  const s = driver.session({ database: 'neo4j' });
  try {
    const r1 = await s.run('MATCH (r:Rule) RETURN count(r) AS n');
    const totalRuleNodes = Number(r1.records[0]!.get('n'));

    const r2 = await s.run(
      `MATCH (act:Action) WHERE act.name = 'matchResume' OR act.id = '10'
       MATCH (act)-[:HAS_RULE]->(rule:Rule)
       RETURN rule.id AS id ORDER BY rule.id`,
    );
    const matchResumeRuleIds = r2.records.map((rec) => rec.get('id') as string);

    const r3 = await s.run(
      `MATCH (act:Action {name: 'matchResume'}) RETURN count(act) AS n`,
    );
    const hasActionLink = Number(r3.records[0]!.get('n')) > 0;

    const r4 = await s.run(
      `MATCH (act:Action)-[:HAS_RULE]->(r:Rule) WHERE act.name='matchResume' OR act.id='10'
       RETURN count(r) AS n`,
    );
    const hasRuleRelCount = Number(r4.records[0]!.get('n'));

    return { totalRuleNodes, matchResumeRuleIds, hasActionLink, hasRuleRelCount };
  } finally {
    await s.close();
    await driver.close();
  }
}

// ─── 层 3:fetchRulesForMatchResume + applyClientFilter ───

async function inspectFetchAndFilter(dims: OntologyDims): Promise<{
  fetchSource: string;
  totalFetched: number;
  fetchedIds: string[];
  filteredIds: string[];
  excludedExplanations: Array<{ id: string; reason: string }>;
  classified: { general: string[]; client_level: string[]; department_level: string[] };
}> {
  const sourceResult = await fetchRulesForMatchResume();
  const fetchedIds = sourceResult.rules.map((r) => r.id).sort();
  const filtered = applyClientFilter(sourceResult.rules, dims);
  const filteredIds = filtered.map((r) => r.id).sort();
  const filteredSet = new Set(filteredIds);

  const excludedExplanations: Array<{ id: string; reason: string }> = [];
  for (const r of sourceResult.rules) {
    if (filteredSet.has(r.id)) continue;
    excludedExplanations.push({ id: r.id, reason: explainExclusion(r, dims) });
  }

  const classified = classifyRules(filtered);

  return {
    fetchSource: sourceResult.source,
    totalFetched: fetchedIds.length,
    fetchedIds,
    filteredIds,
    excludedExplanations,
    classified: {
      general: classified.general.map((r) => r.id),
      client_level: classified.client_level.map((r) => r.id),
      department_level: classified.department_level.map((r) => r.id),
    },
  };
}

function explainExclusion(r: Rule, dims: OntologyDims): string {
  if (r.executor !== 'Agent') return `executor=${r.executor}(非 Agent 类规则,跳过)`;
  if (r.applicableClient !== '通用' && r.applicableClient !== dims.client_id) {
    return `applicableClient=${r.applicableClient} ≠ ${dims.client_id}`;
  }
  const dept = r.applicableDepartment;
  if (dept && dept !== 'N/A' && dept !== '通用') {
    const allowed = dept.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
    if (!dims.business_group || !allowed.includes(dims.business_group)) {
      return `applicableDepartment=${dept} 不包含 ${dims.business_group ?? '(空)'}`;
    }
  }
  return '(unknown reason)';
}

// ─── 层 4:End-to-end audit cross-check ───

async function inspectAuditCrossCheck(): Promise<{
  audits: Array<{
    scenario: string;
    audit_rules_evaluated: number;
    audit_flag_count: number;
    audit_flag_ids: string[];
  }>;
}> {
  const driver = neo4j.driver(
    process.env.NEO4J_INSTANCE_URI!,
    neo4j.auth.basic(process.env.NEO4J_INSTANCE_USER!, process.env.NEO4J_INSTANCE_PASSWORD!),
    { disableLosslessIntegers: true },
  );
  const s = driver.session({ database: 'neo4j' });
  try {
    const r = await s.run(
      `MATCH (a:RuleCheckAudit) WHERE a.scenario_id IS NOT NULL
       OPTIONAL MATCH (a)-[:HAS_FLAG]->(f:RuleCheckFlag)
       WITH a, collect(f.rule_id) AS flag_ids
       RETURN a.scenario_id AS sid, a.rules_evaluated AS re, flag_ids
       ORDER BY a.scenario_id`,
    );
    return {
      audits: r.records.map((rec) => ({
        scenario: rec.get('sid') as string,
        audit_rules_evaluated: Number(rec.get('re')),
        audit_flag_count: (rec.get('flag_ids') as string[]).length,
        audit_flag_ids: (rec.get('flag_ids') as string[]).sort(),
      })),
    };
  } finally {
    await s.close();
    await driver.close();
  }
}

// ─── Main ───

async function main() {
  const args = parseArgs(process.argv);
  const dims: OntologyDims = {
    client_id: args.client,
    business_group: args.business_group,
    studio: args.studio,
  };

  header('Rule Fetch 4-层验证 demo');
  console.log(`场景:client="${dims.client_id}" business_group="${dims.business_group ?? '(none)'}" studio="${dims.studio ?? '(none)'}"`);

  // 层 1
  section('层 1:Source of truth — ontology JSON');
  const src = inspectSource();
  console.log(`  路径: ${src.jsonPath.split('/').slice(-3).join('/')}`);
  console.log(`  总规则数: ${src.totalRules}`);
  console.log(`  matchResume (id="10-*") 规则数: ${src.matchResumeRules.length}`);
  console.log(`  rule_ids 头部: [${src.matchResumeRules.slice(0, 10).join(', ')}, ...]`);

  // 层 2
  section('层 2:Neo4j 存储');
  const neo = await inspectNeo4j();
  console.log(`  :Rule 总节点数: ${neo.totalRuleNodes}`);
  console.log(`  :Action {matchResume} 是否存在: ${neo.hasActionLink ? '✓' : '✗'}`);
  console.log(`  (:Action)-[:HAS_RULE]->(:Rule) 关系数: ${neo.hasRuleRelCount}`);
  console.log(`  matchResume 关联 rule_ids 数: ${neo.matchResumeRuleIds.length}`);
  console.log(`  rule_ids 头部: [${neo.matchResumeRuleIds.slice(0, 10).join(', ')}, ...]`);

  // 一致性 layer1 vs layer2
  const setSrc = new Set(src.matchResumeRules);
  const setNeo = new Set(neo.matchResumeRuleIds);
  const onlyInSrc = src.matchResumeRules.filter((id) => !setNeo.has(id));
  const onlyInNeo = neo.matchResumeRuleIds.filter((id) => !setSrc.has(id));
  console.log(`\n  📐 一致性 (JSON ↔ Neo4j):`);
  if (onlyInSrc.length === 0 && onlyInNeo.length === 0) {
    console.log(`     ✓ 完全一致 (${src.matchResumeRules.length} 条 rule_ids 两边都有)`);
  } else {
    console.log(`     ⚠ 不一致! JSON 独有 ${onlyInSrc.length} 条,Neo4j 独有 ${onlyInNeo.length} 条`);
    if (onlyInSrc.length > 0) console.log(`        JSON only: ${onlyInSrc.join(', ')}`);
    if (onlyInNeo.length > 0) console.log(`        Neo4j only: ${onlyInNeo.join(', ')}`);
  }

  // 层 3
  section('层 3:Fetch + Filter');
  const fetched = await inspectFetchAndFilter(dims);
  console.log(`  fetch source: ${fetched.fetchSource}`);
  console.log(`  fetch 拉到 ${fetched.totalFetched} 条 (跟层 2 一致: ${fetched.totalFetched === neo.matchResumeRuleIds.length ? '✓' : '✗'})`);
  console.log(`  applyClientFilter(dims) 过滤后: ${fetched.filteredIds.length} 条`);
  console.log(`  ├─ §3.1 通用规则 (applicableClient="通用"): ${fetched.classified.general.length} 条`);
  console.log(`  │   [${fetched.classified.general.slice(0, 12).join(', ')}${fetched.classified.general.length > 12 ? ', ...' : ''}]`);
  console.log(`  ├─ §3.2 客户级 (applicableClient="${dims.client_id}", 部门 N/A): ${fetched.classified.client_level.length} 条`);
  console.log(`  │   [${fetched.classified.client_level.join(', ') || '(none)'}]`);
  console.log(`  └─ §3.3 部门级 (BG=${dims.business_group}): ${fetched.classified.department_level.length} 条`);
  console.log(`      [${fetched.classified.department_level.join(', ') || '(none)'}]`);
  console.log('');
  console.log(`  📋 被排除的 ${fetched.excludedExplanations.length} 条 + 排除原因:`);
  for (const ex of fetched.excludedExplanations.slice(0, 12)) {
    console.log(`     - ${ex.id}: ${ex.reason}`);
  }
  if (fetched.excludedExplanations.length > 12) {
    console.log(`     ... (还有 ${fetched.excludedExplanations.length - 12} 条)`);
  }

  // 层 4
  section('层 4:End-to-end audit cross-check (各 scenario LLM 实际看到的规则)');
  const auditX = await inspectAuditCrossCheck();
  if (auditX.audits.length === 0) {
    console.log('  (no audits — 跑过 e2e test 后再来)');
  } else {
    console.log(`  found ${auditX.audits.length} audit records:`);
    console.log('');
    console.log('  | scenario                          | audit.rules_evaluated | actual flag count | match? |');
    console.log('  |---|---|---|---|');
    for (const a of auditX.audits) {
      const matches = a.audit_rules_evaluated === a.audit_flag_count;
      console.log(
        `  | ${a.scenario.padEnd(33)} | ${String(a.audit_rules_evaluated).padStart(2)} ` +
          `| ${String(a.audit_flag_count).padStart(2)} | ${matches ? '✓' : '✗'} |`,
      );
    }
    console.log('');
    console.log('  说明:audit.rules_evaluated = filtered.length(LLM 看到的规则数);');
    console.log('       flag_count = LLM 输出 rule_flags[] 里 applicable=true 的条数(写进 :RuleCheckFlag)');
    console.log('       两者**应该 ≤ 等于**(LLM 可能漏某些规则不输出 — 这是 LLM 行为问题,不是 fetch 问题)');
  }

  header('✓ 4 层验证完成。任意层的差异都会在上面 print 出来。');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FATAL:', e);
  process.exit(1);
});
