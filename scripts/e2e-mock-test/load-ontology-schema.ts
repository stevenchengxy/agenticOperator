// Load ontology schema JSON files into Neo4j as :Action / :Rule / :Event /
// :DataObject / :Workflow / :ObjectLink nodes + relationships.
//
// 数据来源:event_manager/Action_and_Event_Manager/data/*.json
//   - actions_20260323 (1).json     → :Action
//   - rules_20260324 (1).json       → :Rule + (:Action)-[:HAS_RULE]->(:Rule)
//   - events_20260423.json          → :Event + (:Action)-[:TRIGGERS_EVENT]->(:Event)
//   - dataobjects_20260408 (1).json → :DataObject
//   - workflow_20260330 (1).json    → :Workflow
//   - links_20260417.json           → (:DataObject)-[:LINKS_TO]->(:DataObject)
//
// 用法:
//   tsx scripts/e2e-mock-test/load-ontology-schema.ts                # Docker 7688
//   NEO4J_INSTANCE_URI=bolt://localhost:7687 ... tsx ... # 本机 7687
//
// 行为:
//   - 每个 label 用 MERGE,可重复跑
//   - 字段都从 JSON 直接 copy(没有 transformation),用户说"schema 数据有改动但
//     不太对齐业务"——我们存了它就是它,后续业务侧再校准

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: resolve(process.cwd(), '.env.local') });

// 默认连 Docker test instance(用户没给本机 7687 密码)
process.env.NEO4J_INSTANCE_URI = process.env.NEO4J_INSTANCE_URI ?? 'bolt://localhost:7688';
process.env.NEO4J_INSTANCE_USER = process.env.NEO4J_INSTANCE_USER ?? 'neo4j';
process.env.NEO4J_INSTANCE_PASSWORD = process.env.NEO4J_INSTANCE_PASSWORD ?? 'testpassword123';
process.env.NEO4J_INSTANCE_DATABASE = process.env.NEO4J_INSTANCE_DATABASE ?? 'neo4j';

import neo4j, { type Driver } from 'neo4j-driver';

const DATA_DIR = resolve(process.cwd(), 'event_manager/Action_and_Event_Manager/data');

interface Counts {
  actions: number;
  rules: number;
  events: number;
  dataobjects: number;
  workflows: number;
  links: number;
  rels_action_rule: number;
  rels_action_event: number;
  rels_event_target: number;
  rels_object_link: number;
}

const NULL_COUNTS: Counts = {
  actions: 0,
  rules: 0,
  events: 0,
  dataobjects: 0,
  workflows: 0,
  links: 0,
  rels_action_rule: 0,
  rels_action_event: 0,
  rels_event_target: 0,
  rels_object_link: 0,
};

function readJson(filename: string): unknown {
  const p = resolve(DATA_DIR, filename);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

// ─── DataObjects ───

interface DataObjectsRoot {
  metadata?: Record<string, unknown>;
  objects?: Array<Record<string, unknown>>;
}

async function loadDataObjects(driver: Driver, database: string): Promise<number> {
  const root = readJson('dataobjects_20260408 (1).json') as DataObjectsRoot;
  const objs = root.objects ?? [];
  const s = driver.session({ database });
  try {
    // 每条 MERGE,字段全部存为节点属性
    await s.run(
      `UNWIND $objs AS o
       MERGE (do:DataObject {id: o.id})
       SET do.name = o.name,
           do.description = o.description,
           do.primary_key = o.primary_key,
           do.properties_json = o.properties_json,
           do.imported_at = datetime()`,
      {
        objs: objs.map((o) => ({
          id: String(o.id ?? ''),
          name: String(o.name ?? ''),
          description: String(o.description ?? ''),
          primary_key: String((o as Record<string, unknown>).primary_key ?? ''),
          // properties 是嵌套数组,直接 stringify 存 — 后续查询用 apoc.convert.fromJsonList
          properties_json: JSON.stringify((o as Record<string, unknown>).properties ?? []),
        })),
      },
    );
    return objs.length;
  } finally {
    await s.close();
  }
}

// ─── Actions ───

async function loadActions(driver: Driver, database: string): Promise<number> {
  const arr = readJson('actions_20260323 (1).json') as Array<Record<string, unknown>>;
  const s = driver.session({ database });
  try {
    await s.run(
      `UNWIND $actions AS a
       MERGE (act:Action {id: a.id})
       SET act.name = a.name,
           act.description = a.description,
           act.submission_criteria = a.submission_criteria,
           act.actor = a.actor,
           act.trigger = a.trigger,
           act.target_objects = a.target_objects,
           act.imported_at = datetime()`,
      {
        actions: arr.map((a) => ({
          id: String(a.id ?? ''),
          name: String(a.name ?? ''),
          description: String(a.description ?? ''),
          submission_criteria: String((a as Record<string, unknown>).submission_criteria ?? ''),
          actor: ((a as Record<string, unknown>).actor as string[]) ?? [],
          trigger: ((a as Record<string, unknown>).trigger as string[]) ?? [],
          target_objects: ((a as Record<string, unknown>).target_objects as string[]) ?? [],
        })),
      },
    );
    return arr.length;
  } finally {
    await s.close();
  }
}

// ─── Rules ───

interface RulesRoot {
  metadata?: Record<string, unknown>;
  rules?: Array<Record<string, unknown>>;
}

async function loadRules(driver: Driver, database: string): Promise<{ rules: number; rels: number }> {
  const root = readJson('rules_20260324 (1).json') as RulesRoot;
  const rules = root.rules ?? [];
  const s = driver.session({ database });
  try {
    await s.run(
      `UNWIND $rules AS r
       MERGE (rule:Rule {id: r.id})
       SET rule.specificScenarioStage = r.specificScenarioStage,
           rule.businessLogicRuleName = r.businessLogicRuleName,
           rule.applicableClient = r.applicableClient,
           rule.applicableDepartment = r.applicableDepartment,
           rule.submissionCriteria = r.submissionCriteria,
           rule.standardizedLogicRule = r.standardizedLogicRule,
           rule.relatedEntities = r.relatedEntities,
           rule.businessBackgroundReason = r.businessBackgroundReason,
           rule.ruleSource = r.ruleSource,
           rule.executor = r.executor,
           rule.imported_at = datetime()`,
      {
        rules: rules.map((r) => ({
          id: String(r.id ?? ''),
          specificScenarioStage: String((r as Record<string, unknown>).specificScenarioStage ?? ''),
          businessLogicRuleName: String((r as Record<string, unknown>).businessLogicRuleName ?? ''),
          applicableClient: String((r as Record<string, unknown>).applicableClient ?? '通用'),
          applicableDepartment: String((r as Record<string, unknown>).applicableDepartment ?? 'N/A'),
          submissionCriteria: String((r as Record<string, unknown>).submissionCriteria ?? ''),
          standardizedLogicRule: String((r as Record<string, unknown>).standardizedLogicRule ?? ''),
          relatedEntities: ((r as Record<string, unknown>).relatedEntities as string[]) ?? [],
          businessBackgroundReason: String(
            (r as Record<string, unknown>).businessBackgroundReason ?? '',
          ),
          ruleSource: String((r as Record<string, unknown>).ruleSource ?? ''),
          executor: String((r as Record<string, unknown>).executor ?? 'Agent'),
        })),
      },
    );

    // 建 Action -> Rule 关系。rule.id 形如 "10-25",前缀 "10" 即对应 Action id
    const relRes = await s.run(
      `MATCH (rule:Rule)
       WITH rule, split(rule.id, '-')[0] AS action_id_prefix
       MATCH (act:Action {id: action_id_prefix})
       MERGE (act)-[r:HAS_RULE]->(rule)
       RETURN count(r) AS n`,
      {},
    );
    const relCount = Number(relRes.records[0]?.get('n') ?? 0);
    return { rules: rules.length, rels: relCount };
  } finally {
    await s.close();
  }
}

// ─── Events ───

async function loadEvents(driver: Driver, database: string): Promise<{ events: number; rels_action: number; rels_target: number }> {
  const arr = readJson('events_20260423.json') as Array<Record<string, unknown>>;
  const s = driver.session({ database });
  try {
    await s.run(
      `UNWIND $events AS e
       MERGE (ev:Event {name: e.name})
       SET ev.description = e.description,
           ev.source_action = e.source_action,
           ev.payload_json = e.payload_json,
           ev.imported_at = datetime()`,
      {
        events: arr.map((e) => ({
          name: String(e.name ?? ''),
          description: String(e.description ?? ''),
          source_action: String(
            ((e as Record<string, unknown>).payload as Record<string, unknown> | undefined)
              ?.source_action ?? '',
          ),
          payload_json: JSON.stringify((e as Record<string, unknown>).payload ?? {}),
        })),
      },
    );

    // (Action)-[:TRIGGERS_EVENT]->(Event) via event.source_action == action.name
    const r1 = await s.run(
      `MATCH (ev:Event)
       WHERE ev.source_action IS NOT NULL AND ev.source_action <> ''
       MATCH (act:Action {name: ev.source_action})
       MERGE (act)-[rel:TRIGGERS_EVENT]->(ev)
       RETURN count(rel) AS n`,
      {},
    );
    const rels_action = Number(r1.records[0]?.get('n') ?? 0);

    // (Event)-[:TARGETS_OBJECT]->(DataObject) via event_data[i].target_object
    // payload_json 存的是 JSON 字符串,Cypher 直接 parse 比较麻烦,用应用层先抽出
    let rels_target = 0;
    for (const e of arr) {
      const payload = (e as Record<string, unknown>).payload as
        | { event_data?: Array<{ name?: string; target_object?: string | null }> }
        | undefined;
      const targets = new Set<string>();
      for (const f of payload?.event_data ?? []) {
        if (f.target_object && typeof f.target_object === 'string') targets.add(f.target_object);
      }
      if (targets.size === 0) continue;
      const rr = await s.run(
        `MATCH (ev:Event {name: $eventName})
         UNWIND $targets AS targetId
         MATCH (do:DataObject {id: targetId})
         MERGE (ev)-[rel:TARGETS_OBJECT]->(do)
         RETURN count(rel) AS n`,
        { eventName: String(e.name ?? ''), targets: [...targets] },
      );
      rels_target += Number(rr.records[0]?.get('n') ?? 0);
    }

    return { events: arr.length, rels_action, rels_target };
  } finally {
    await s.close();
  }
}

// ─── Workflows ───

async function loadWorkflows(driver: Driver, database: string): Promise<number> {
  // workflow_20260330 (1).json 顶层是数组,每条 = 一个 workflow node (跟 action
  // 有 id 但 schema 略不同)。我们就存为独立 :Workflow 节点。
  const arr = readJson('workflow_20260330 (1).json') as Array<Record<string, unknown>>;
  const s = driver.session({ database });
  try {
    await s.run(
      `UNWIND $wfs AS w
       MERGE (wf:Workflow {id: w.id})
       SET wf.name = w.name,
           wf.description = w.description,
           wf.actor = w.actor,
           wf.trigger = w.trigger,
           wf.actions_json = w.actions_json,
           wf.imported_at = datetime()`,
      {
        wfs: arr.map((w) => ({
          id: String(w.id ?? ''),
          name: String(w.name ?? ''),
          description: String(w.description ?? ''),
          actor: ((w as Record<string, unknown>).actor as string[]) ?? [],
          trigger: ((w as Record<string, unknown>).trigger as string[]) ?? [],
          actions_json: JSON.stringify((w as Record<string, unknown>).actions ?? []),
        })),
      },
    );
    return arr.length;
  } finally {
    await s.close();
  }
}

// ─── DataObject Links ───

async function loadLinks(driver: Driver, database: string): Promise<number> {
  const arr = readJson('links_20260417.json') as Array<Record<string, unknown>>;
  const s = driver.session({ database });
  try {
    const r = await s.run(
      `UNWIND $links AS l
       MATCH (src:DataObject {id: l.sourceObject})
       MATCH (tgt:DataObject {id: l.targetObject})
       MERGE (src)-[rel:LINKS_TO {api_name: l.apiName}]->(tgt)
       SET rel.cardinality = l.cardinality,
           rel.display_name_source = l.displayNameSource,
           rel.display_name_target = l.displayNameTarget,
           rel.imported_at = datetime()
       RETURN count(rel) AS n`,
      {
        links: arr.map((l) => ({
          sourceObject: String((l as Record<string, unknown>).sourceObject ?? ''),
          targetObject: String((l as Record<string, unknown>).targetObject ?? ''),
          apiName: String((l as Record<string, unknown>).apiName ?? ''),
          cardinality: String((l as Record<string, unknown>).cardinality ?? ''),
          displayNameSource: String((l as Record<string, unknown>).displayNameSource ?? ''),
          displayNameTarget: String((l as Record<string, unknown>).displayNameTarget ?? ''),
        })),
      },
    );
    return Number(r.records[0]?.get('n') ?? 0);
  } finally {
    await s.close();
  }
}

// ─── Main ───

async function main() {
  const uri = process.env.NEO4J_INSTANCE_URI!;
  const user = process.env.NEO4J_INSTANCE_USER!;
  const password = process.env.NEO4J_INSTANCE_PASSWORD!;
  const database = process.env.NEO4J_INSTANCE_DATABASE!;

  // eslint-disable-next-line no-console
  console.log(`[loader] target: ${uri} (db=${database})`);
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    connectionTimeout: 10_000,
    disableLosslessIntegers: true,
  });

  try {
    const info = await driver.getServerInfo();
    // eslint-disable-next-line no-console
    console.log(`[loader] connected: ${info.address} (${info.protocolVersion})`);

    const counts: Counts = { ...NULL_COUNTS };

    /* eslint-disable no-console */
    console.log('[loader] loading DataObjects ...');
    counts.dataobjects = await loadDataObjects(driver, database);
    console.log(`         ${counts.dataobjects} DataObject nodes`);

    console.log('[loader] loading Actions ...');
    counts.actions = await loadActions(driver, database);
    console.log(`         ${counts.actions} Action nodes`);

    console.log('[loader] loading Rules + Action↔Rule rels ...');
    const rulesRes = await loadRules(driver, database);
    counts.rules = rulesRes.rules;
    counts.rels_action_rule = rulesRes.rels;
    console.log(`         ${counts.rules} Rule nodes,${counts.rels_action_rule} HAS_RULE rels`);

    console.log('[loader] loading Events + rels ...');
    const evRes = await loadEvents(driver, database);
    counts.events = evRes.events;
    counts.rels_action_event = evRes.rels_action;
    counts.rels_event_target = evRes.rels_target;
    console.log(
      `         ${counts.events} Event nodes,` +
        `${counts.rels_action_event} TRIGGERS_EVENT rels,${counts.rels_event_target} TARGETS_OBJECT rels`,
    );

    console.log('[loader] loading Workflows ...');
    counts.workflows = await loadWorkflows(driver, database);
    console.log(`         ${counts.workflows} Workflow nodes`);

    console.log('[loader] loading DataObject Links ...');
    counts.links = await loadLinks(driver, database);
    console.log(`         ${counts.links} LINKS_TO rels`);

    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify(counts, null, 2));
    /* eslint-enable no-console */
  } finally {
    await driver.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[loader] FATAL:', e);
  process.exit(1);
});
