// Agent step evidence capture.
//
// Each step.run callback in the 3 PRA agents wraps its critical operations
// with captureStepEvidence(), which writes a row to AgentStepEvidence in
// Prisma. The /monitor/flows/[flowId] page reads these rows to render the
// complete evidence trail:
//
//   ┌─ Step: save-candidate ──────────────────────────────┐
//   │ kind: persist · 110ms                               │
//   │ External call: RAAS POST /api/v1/candidates         │
//   │ Input:  { upload_id, parsed: { name: "张明", ... } } │
//   │ Output: { candidate_id: "c_xxx", resume_id: ... }   │
//   └─────────────────────────────────────────────────────┘
//
// This decouples evidence capture from Inngest's step history (which in
// dev mode batches multiple step.run into one history entry).

import { prisma } from '@/server/db';
import { ulid } from 'ulid';
import { writeInstance } from '@/lib/allmeta-client';

// 12K was the original safety cap, but rule-check evidence (LLM raw_text +
// 51 rule_flags + system/user prompts) routinely exceeds it — when truncated,
// the resulting string is no longer valid JSON, safeParse returns the raw
// string, the UI panel can't read `out.decision` and shows dashes. SQLite
// TEXT has no practical limit; 256K is plenty for our richest payloads
// (full rule-check audit is ~50-80K).
const MAX_JSON_CHARS = 256_000;

export type StepKind =
  | 'guard'
  | 'fetch'
  | 'compute'
  | 'persist'
  | 'audit'
  | 'subsystem'
  | 'emit'
  | 'allmeta_write';

export type EvidenceCaptureArgs = {
  runId: string;
  functionSlug: string;
  flowId: string;
  stepName: string;
  stepKind: StepKind;
  externalCall?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
  allmeta?: {
    label: string;
    pkValue: string;
    neo4jHint?: string;
  };
};

function safeStringify(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > MAX_JSON_CHARS ? s.slice(0, MAX_JSON_CHARS) + '...[truncated]' : s;
  } catch {
    return '[unserializable]';
  }
}

export async function captureStepEvidence(args: EvidenceCaptureArgs): Promise<void> {
  try {
    await prisma.agentStepEvidence.create({
      data: {
        id: ulid(),
        run_id: args.runId,
        function_slug: args.functionSlug,
        flow_id: args.flowId,
        step_name: args.stepName,
        step_kind: args.stepKind,
        external_call: args.externalCall,
        input_json: safeStringify(args.input),
        output_json: safeStringify(args.output),
        error_message: args.error,
        duration_ms: args.durationMs,
        allmeta_label: args.allmeta?.label,
        allmeta_pk_value: args.allmeta?.pkValue,
        allmeta_neo4j: args.allmeta?.neo4jHint,
      },
    });
  } catch (err) {
    // Observability-only: never throw. But surface to dev-server stderr so
    // we can diagnose silent breakage during development.
    console.error('[agent-step-evidence] capture failed:', (err as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────
// Convenience: Allmeta-write + evidence in one call.
//
// Usage inside an agent's step.run:
//   await writeAllmetaWithEvidence({
//     label: 'Candidate',
//     payload: toAllmetaCandidate(nested, candidate_id),
//     runId, functionSlug, flowId, stepName: 'write-allmeta-candidate',
//   });
// ─────────────────────────────────────────────────────────────

export async function writeAllmetaWithEvidence(args: {
  label: string;
  payload: Record<string, unknown>;
  runId: string;
  functionSlug: string;
  flowId: string;
  stepName: string;
}): Promise<{ ok: boolean; response?: unknown; error?: string }> {
  const startedAt = Date.now();
  const externalCall = `Allmeta POST /api/v1/ontology/instances/${args.label}?domain=RAAS-v1`;
  const pkField = inferPkField(args.label);
  const pkValue = String(args.payload[pkField] ?? '<unknown>');
  try {
    const response = await writeInstance(args.label, args.payload);
    const durationMs = Date.now() - startedAt;
    await captureStepEvidence({
      runId: args.runId,
      functionSlug: args.functionSlug,
      flowId: args.flowId,
      stepName: args.stepName,
      stepKind: 'allmeta_write',
      externalCall,
      input: args.payload,
      output: response,
      durationMs,
      allmeta: {
        label: args.label,
        pkValue,
        // Single-statement, paste-and-run Cypher for verifying the upsert.
        // No `;` (Neo4j Browser treats trailing `;` as multi-statement and
        // strips the second clause on paste — we hit that earlier). No MERGE
        // either — Allmeta already wrote the node, the user just wants to
        // read it back. Paste this whole line into http://localhost:7475/browser/
        // and hit Run.
        neo4jHint:
          `MATCH (n:${args.label} {${pkField}: "${pkValue}", domainId: "RAAS-v1"}) RETURN n`,
      },
    });
    return { ok: true, response };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = (err as Error).message;
    await captureStepEvidence({
      runId: args.runId,
      functionSlug: args.functionSlug,
      flowId: args.flowId,
      stepName: args.stepName,
      stepKind: 'allmeta_write',
      externalCall,
      input: args.payload,
      output: null,
      error: message,
      durationMs,
      allmeta: {
        label: args.label,
        pkValue,
      },
    });
    return { ok: false, error: message };
  }
}

function inferPkField(label: string): string {
  // Allmeta DataObject PK conventions (v0_1_010)
  const m: Record<string, string> = {
    Candidate: 'candidate_id',
    Candidate_Expectation: 'candidate_expectation_id',
    Resume: 'resume_id',
    Job_Requisition: 'job_requisition_id',
    Candidate_Match_Result: 'candidate_match_result_id',
  };
  return m[label] ?? `${label.toLowerCase()}_id`;
}

// ─────────────────────────────────────────────────────────────
// Convenience: wrap a RAAS call with evidence capture.
// ─────────────────────────────────────────────────────────────

export async function captureRaasCall<T>(args: {
  runId: string;
  functionSlug: string;
  flowId: string;
  stepName: string;
  externalCall: string;       // e.g. "RAAS POST /api/v1/candidates"
  input?: unknown;
  fn: () => Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();
  try {
    const output = await args.fn();
    const durationMs = Date.now() - startedAt;
    await captureStepEvidence({
      runId: args.runId,
      functionSlug: args.functionSlug,
      flowId: args.flowId,
      stepName: args.stepName,
      stepKind: 'fetch',
      externalCall: args.externalCall,
      input: args.input,
      output,
      durationMs,
    });
    return output;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    await captureStepEvidence({
      runId: args.runId,
      functionSlug: args.functionSlug,
      flowId: args.flowId,
      stepName: args.stepName,
      stepKind: 'fetch',
      externalCall: args.externalCall,
      input: args.input,
      error: (err as Error).message,
      durationMs,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Derive flowId from event payload (matches inngest-admin-client logic).
// ─────────────────────────────────────────────────────────────

export function flowIdFromEvent(eventData: Record<string, unknown>): string {
  const uploadId =
    (eventData.upload_id as string | undefined) ??
    ((eventData.payload as Record<string, unknown> | undefined)?.upload_id as string | undefined);
  if (uploadId) return `upload:${uploadId}`;
  const jrId =
    (eventData.job_requisition_id as string | undefined) ??
    (eventData.entity_id as string | undefined) ??
    ((eventData.payload as Record<string, unknown> | undefined)?.job_requisition_id as
      | string
      | undefined);
  if (jrId) return `jr:${jrId}`;
  return `evt:unknown`;
}
