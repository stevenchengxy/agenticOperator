// GET /api/monitor/run-neo4j-instances?runId=<id>
//
// 给监控页"数据写入 · Neo4j"摘要使用 —— 绕开 Inngest dev server V2 trace
// childrenSpans 不完整的问题(后面 step.run 不在 trace),直接从 run 的
// 触发事件 + RunComplete output 抽实体 ID,然后查 allmeta API 看 Neo4j
// 里实际有没有这条 instance。
//
// 输出 shape:
//   { entities: [{ label, pk, ok, exists, source }] }
//     source = "expected-from-event" | "expected-from-output"

import { NextResponse } from 'next/server';
import { getRunHistory } from '@/lib/inngest-admin-client';
import { getInstance } from '@/lib/allmeta-client';
import { query as pgQuery } from '@/lib/partner-pg/client';

function isAllmetaConfigured(): boolean {
  return !!process.env.ALLMETA_BASE_URL;
}

// Empty-string fallback (not localhost) — the listCMRsByCandidate path is
// gated by isAllmetaConfigured() before use, so this constant is only read
// when the env IS set. Removing the localhost default keeps the codebase
// from silently aiming at a wrong host in misconfigured deploys.
const ALLMETA_BASE = process.env.ALLMETA_BASE_URL ?? '';
const ALLMETA_TOKEN = process.env.ALLMETA_API_KEY ?? '';
const ALLMETA_DOMAIN = process.env.ALLMETA_DOMAIN ?? 'RAAS-v1';

/** Fallback for ruleCheck path B: list all CMRs by candidate_id via allmeta filter. */
async function listCMRsByCandidate(candidateId: string): Promise<Array<Record<string, unknown>>> {
  const url = `${ALLMETA_BASE}/api/v1/ontology/instances/Candidate_Match_Result?domain=${encodeURIComponent(
    ALLMETA_DOMAIN,
  )}&candidate_id=${encodeURIComponent(candidateId)}&limit=50`;
  const res = await fetch(url, {
    headers: ALLMETA_TOKEN ? { Authorization: `Bearer ${ALLMETA_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`allmeta list ${res.status}`);
  const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return body.items ?? [];
}

export const dynamic = 'force-dynamic';

type EntityProbe = {
  label: string;
  pk: string;
  source: 'event-input' | 'run-output';
};

type EntityResult = EntityProbe & {
  exists: boolean;
  instance?: Record<string, unknown> | null;
  error?: string;
};

/** Per-agent: derive expected entities from event payload + RunComplete data. */
function probeEntitiesForAgent(
  slug: string,
  eventName: string,
  eventPayload: Record<string, unknown>,
  runOutput: Record<string, unknown> | null,
): EntityProbe[] {
  const out: EntityProbe[] = [];
  const inputData = (eventPayload?.data ?? eventPayload) as Record<string, unknown>;

  // ── createJdAgent ──
  if (slug.includes('create-jd-agent')) {
    const jrid =
      (inputData.entity_id as string | undefined) ??
      ((inputData.payload as Record<string, unknown> | undefined)?.job_requisition_id as
        | string
        | undefined);
    if (jrid) out.push({ label: 'Job_Requisition', pk: jrid, source: 'event-input' });

    const jpId = runOutput?.job_posting_id as string | undefined;
    if (jpId) out.push({ label: 'Job_Posting', pk: jpId, source: 'run-output' });
  }

  // ── resumeParserAgent ──
  else if (slug.includes('resume-parser-agent')) {
    const candId = runOutput?.candidate_id as string | undefined;
    if (candId) out.push({ label: 'Candidate', pk: candId, source: 'run-output' });
    const resId = runOutput?.resume_id as string | undefined;
    if (resId) out.push({ label: 'Resume', pk: resId, source: 'run-output' });
    const appId = runOutput?.application_id as string | undefined;
    if (appId) out.push({ label: 'Application', pk: appId, source: 'run-output' });
  }

  // ── ruleCheckAgent ──
  else if (slug.includes('rule-check-agent')) {
    // 路径 A: 事件带 job_requisition_id → 写 1 个 CMR
    // 路径 B: 事件不带 jr_id → 内部从 partner DB 拿 claimer 名下 N 个 JR
    //         → 写 N 个 CMR(由 list-via-filter 分支处理,见下)
    const candId =
      (inputData.candidate_id as string | undefined) ??
      ((inputData.payload as Record<string, unknown> | undefined)?.candidate_id as string | undefined);
    const jrid =
      (inputData.job_requisition_id as string | undefined) ??
      ((inputData.payload as Record<string, unknown> | undefined)?.job_requisition_id as
        | string
        | undefined);
    if (candId && jrid) {
      // 路径 A
      out.push({
        label: 'Candidate_Match_Result',
        pk: `cmr_${candId}_${jrid}`,
        source: 'event-input',
      });
      out.push({ label: 'Job_Requisition', pk: jrid, source: 'event-input' });
    }
    // 路径 B 在主函数里通过 listEntitiesByFilter 补 CMRs(因为 N 个 JR
    // 是 runtime 决定的,需要查 allmeta filter)
  }

  // ── matchResumeAgent ──
  else if (slug.includes('match-resume-agent')) {
    const candId = (inputData.candidate_id as string | undefined) ?? null;
    const jrid = (inputData.job_requisition_id as string | undefined) ?? null;
    if (candId && jrid) {
      out.push({
        label: 'Candidate_Match_Result',
        pk: `cmr_${candId}_${jrid}`,
        source: 'event-input',
      });
    }
  }

  // dedupe by (label, pk)
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.label}|${e.pk}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parseRunOutput(output: unknown): Record<string, unknown> | null {
  if (!output) return null;
  // Inngest run output is an array of opcode entries; we want the RunComplete data.
  if (Array.isArray(output)) {
    for (const item of output) {
      if (
        item &&
        typeof item === 'object' &&
        (item as { op?: string }).op === 'RunComplete' &&
        typeof (item as { data?: unknown }).data === 'object' &&
        (item as { data?: Record<string, unknown> }).data
      ) {
        return (item as { data: Record<string, unknown> }).data;
      }
    }
    return null;
  }
  if (typeof output === 'string') {
    try {
      return parseRunOutput(JSON.parse(output));
    } catch {
      return null;
    }
  }
  if (typeof output === 'object') {
    return output as Record<string, unknown>;
  }
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const runId = (url.searchParams.get('runId') ?? '').trim();
  if (!runId) {
    return NextResponse.json(
      { error: 'missing-runId' },
      { status: 400 },
    );
  }

  if (!isAllmetaConfigured()) {
    return NextResponse.json({ entities: [], reason: 'allmeta-not-configured' });
  }

  let run;
  try {
    run = await getRunHistory(runId);
  } catch (e) {
    return NextResponse.json(
      { error: 'inngest-fetch-failed', message: (e as Error).message.slice(0, 240) },
      { status: 502 },
    );
  }
  if (!run) {
    return NextResponse.json({ error: 'run-not-found' }, { status: 404 });
  }

  // Parse event payload
  let eventPayload: Record<string, unknown> = {};
  if (run.event?.payload) {
    try {
      eventPayload = JSON.parse(run.event.payload) as Record<string, unknown>;
    } catch {
      eventPayload = {};
    }
  }
  const eventName = run.event?.name ?? '';
  const slug = run.function?.slug ?? '';
  const runOutput = parseRunOutput(run.output);

  const probes = probeEntitiesForAgent(slug, eventName, eventPayload, runOutput);

  // Query allmeta in parallel for known PKs
  const results: EntityResult[] = await Promise.all(
    probes.map(async (p): Promise<EntityResult> => {
      try {
        const instance = await getInstance<Record<string, unknown>>(p.label, p.pk);
        return { ...p, exists: !!instance, instance };
      } catch (e) {
        return { ...p, exists: false, error: (e as Error).message.slice(0, 200) };
      }
    }),
  );

  // 路径 B 兜底:ruleCheck 在 path B 时(claimer 名下 N 个 JR)无法从事件
  // 拿全部 jr_id —— 用 allmeta filter by candidate_id 反查实际写入的 CMR。
  if (slug.includes('rule-check-agent') && probes.length === 0) {
    const candId =
      (eventPayload.candidate_id as string | undefined) ??
      ((eventPayload.data as Record<string, unknown> | undefined)?.candidate_id as
        | string
        | undefined);
    if (candId) {
      try {
        const listed = await listCMRsByCandidate(candId);
        for (const cmr of listed) {
          results.push({
            label: 'Candidate_Match_Result',
            pk: (cmr.candidate_match_result_id as string) ?? '?',
            source: 'run-output',
            exists: true,
            instance: cmr,
          });
        }
      } catch (e) {
        results.push({
          label: 'Candidate_Match_Result',
          pk: `cmr_${candId}_*`,
          source: 'run-output',
          exists: false,
          error: `list failed: ${(e as Error).message.slice(0, 120)}`,
        });
      }
    }
  }

  // 同时 live-probe partner Postgres for the same entities — bypassing
  // Inngest trace which may drop step records. UI uses postgres_entities
  // for the left column (Postgres) the same way it uses entities for Neo4j.
  const pgResults: EntityResult[] = await Promise.all(
    probes.map(async (p): Promise<EntityResult> => {
      try {
        const exists = await probePartnerPg(p.label, p.pk);
        return { ...p, exists };
      } catch (e) {
        return { ...p, exists: false, error: (e as Error).message.slice(0, 200) };
      }
    }),
  );
  // 路径 B 兜底 for ruleCheck partner Postgres CMRs(同 Neo4j 那块逻辑)
  if (slug.includes('rule-check-agent') && probes.length === 0) {
    const candId =
      (eventPayload.candidate_id as string | undefined) ??
      ((eventPayload.data as Record<string, unknown> | undefined)?.candidate_id as
        | string
        | undefined);
    if (candId) {
      try {
        const r = await pgQuery<{ candidate_match_result_id: string }>(
          `SELECT candidate_match_result_id FROM candidate_match_result
            WHERE candidate_id = $1 ORDER BY updated_at DESC LIMIT 50`,
          [candId],
        );
        for (const row of r.rows) {
          pgResults.push({
            label: 'Candidate_Match_Result',
            pk: row.candidate_match_result_id,
            source: 'run-output',
            exists: true,
          });
        }
      } catch (e) {
        pgResults.push({
          label: 'Candidate_Match_Result',
          pk: `cmr_${candId}_*`,
          source: 'run-output',
          exists: false,
          error: `pg list failed: ${(e as Error).message.slice(0, 120)}`,
        });
      }
    }
  }

  return NextResponse.json({
    runId,
    agent_slug: slug,
    event_name: eventName,
    entities: results,
    postgres_entities: pgResults,
  });
}

/** Probe partner Postgres for the given entity.
 *
 * Special case: Candidate_Match_Result 的 PK 在 Neo4j 是 synthesized
 * `cmr_<candidate>_<jr>`,而 partner Postgres 用 `randomUUID()` 生成 UUID。
 * 所以 CMR 不能用 pk 直查,要按 (candidate_id, job_requisition_id) 反查。
 */
async function probePartnerPg(label: string, pk: string): Promise<boolean> {
  if (label === 'Candidate_Match_Result') {
    // pk shape: cmr_<candidate_id>_<jr_id>
    const m = /^cmr_([^_]+(?:-[^_]+)*)_(.+)$/.exec(pk);
    if (m) {
      const candidateId = m[1];
      const jrId = m[2];
      const r = await pgQuery(
        `SELECT 1 FROM candidate_match_result
          WHERE candidate_id = $1 AND job_requisition_id = $2
          LIMIT 1`,
        [candidateId, jrId],
      );
      return r.rows.length > 0;
    }
    // Fallback:可能是 partner 直接传的 Postgres UUID PK
    const r = await pgQuery(
      `SELECT 1 FROM candidate_match_result WHERE candidate_match_result_id = $1 LIMIT 1`,
      [pk],
    );
    return r.rows.length > 0;
  }

  const { table, pkColumn } = pgTableForLabel(label);
  if (!table) return false;
  const r = await pgQuery(
    `SELECT 1 FROM ${table} WHERE ${pkColumn} = $1 LIMIT 1`,
    [pk],
  );
  return r.rows.length > 0;
}

/** label → partner Postgres table + primary key column name. */
function pgTableForLabel(label: string): { table: string | null; pkColumn: string } {
  switch (label) {
    case 'Job_Requisition':
      return { table: 'job_requisition', pkColumn: 'job_requisition_id' };
    case 'Job_Posting':
      return { table: 'job_posting', pkColumn: 'job_posting_id' };
    case 'Candidate':
      return { table: 'candidate', pkColumn: 'candidate_id' };
    case 'Resume':
      return { table: 'resume', pkColumn: 'resume_id' };
    case 'Application':
      return { table: 'application', pkColumn: 'application_id' };
    case 'Candidate_Match_Result':
      return { table: 'candidate_match_result', pkColumn: 'candidate_match_result_id' };
    default:
      return { table: null, pkColumn: 'id' };
  }
}
