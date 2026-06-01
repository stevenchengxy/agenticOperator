// Shared run-summary synthesizer.
//
// Single entry point used by:
//   - app/api/runs/[id]/summary/route.ts (lazy-on-view, GET handler)
//   - Inngest synthesis worker (eager-on-fail, triggered when a run reaches
//     a terminal status — see Phase 2 of the run-summary spec)
//
// Behavior contract:
//   1. Empty run (no steps + no activity) → write a `static-fallback` row
//      with emptyRunNotice text. Never calls the LLM (it would hallucinate).
//   2. LLM gateway not configured → write a `fallback` row with
//      deterministicSummary text.
//   3. LLM call throws GatewayUnavailableError → same fallback as (2).
//   4. LLM call throws anything else → re-throw (so Inngest can retry).
//   5. LLM call succeeds → write an `llm` row with all observability fields.
//
// Idempotency: upserts on the unique (run_id, last_activity_at) key — if
// the eager path already wrote a row for the same last_activity_at, lazy
// callers return the existing row instead of overwriting.

import type { RunAiSummary } from "@prisma/client";
import { prisma } from "@/server/db";
import { resolveAgentMeta } from "@/lib/agent-mapping";
import {
  chatComplete,
  GatewayUnavailableError,
  isGatewayConfigured,
} from "@/server/llm/gateway";
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  type AgentBreakdownRow,
} from "./prompt";
import { deterministicSummary, emptyRunNotice } from "./fallback";

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

export type TriggerPath = "eager-on-fail" | "lazy-on-view" | "agent-tuning";

export type SynthesizeArgs = {
  runId: string;
  triggerPath: TriggerPath;
  /** When triggerPath === 'eager-on-fail', the terminal status that caused
   *  the eager synthesis (e.g. 'failed' | 'timed_out'). Threaded into the
   *  user prompt so the LLM leads with the failure root cause. */
  terminalStatus?: string;
};

/** Normalized run + steps shape consumed by the prompt builder + breakdown
 *  helper. Either pulled from the AO-native WorkflowRun table or adapted
 *  from an InngestRunArchive row (with steps from InngestStepArchive). */
export type NormalizedRun = {
  id: string;
  triggerEvent: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  lastActivityAt: Date;
  suspendedReason: string | null;
  triggerData: string;
  steps: Array<{
    nodeId: string;
    status: string;
    error: string | null;
    durationMs: number | null;
  }>;
};

/** Load a run snapshot from either WorkflowRun (AO-native, populated by the
 *  workflow runtime in server/inngest/agents/*) or InngestRunArchive
 *  (populated by lib/inngest-archive/, mirroring the Inngest dashboard).
 *  Most /monitor runs are Inngest archive rows; AO-native WorkflowRun rows
 *  are rarer and used by the legacy /workflow path. */
export async function loadRunSnapshot(runId: string): Promise<NormalizedRun | null> {
  const native = await prisma.workflowRun.findUnique({
    where: { id: runId },
    include: { steps: true },
  });
  if (native) {
    return {
      id: native.id,
      triggerEvent: native.triggerEvent,
      status: native.status,
      startedAt: native.startedAt,
      completedAt: native.completedAt,
      lastActivityAt: native.lastActivityAt,
      suspendedReason: native.suspendedReason,
      triggerData: native.triggerData,
      steps: native.steps.map((s) => ({
        nodeId: s.nodeId,
        status: s.status,
        error: s.error,
        durationMs: s.durationMs,
      })),
    };
  }
  // Fall back to Inngest archive.
  const archive = await prisma.inngestRunArchive.findUnique({
    where: { runId },
    include: { steps: true },
  });
  if (!archive) return null;
  // Best-effort triggerEvent — prefer the explicit eventName, fall back to
  // the function name (display) or the function slug.
  const triggerEvent =
    archive.eventName ?? archive.functionName ?? archive.functionSlug ?? "(unknown)";
  // Map archive status → WorkflowRun-style lowercase used by the prompt.
  const status = archive.status.toLowerCase();
  // Inngest archive doesn't track suspendedReason — leave null.
  // triggerData → use the archived event payload JSON, or "{}".
  const triggerData = archive.eventPayload ?? "{}";
  return {
    id: archive.runId,
    triggerEvent,
    status,
    startedAt: archive.startedAt ?? archive.archivedAt,
    completedAt: archive.endedAt,
    // lastActivityAt drives the cache key — use lastSyncedAt so the cache
    // invalidates as the archiver picks up more activity.
    lastActivityAt: archive.lastSyncedAt,
    suspendedReason: null,
    triggerData,
    steps: archive.steps.map((s) => ({
      // Inngest steps don't have an AO wsId/nodeId; use the function slug
      // so byShortFromWs has a stable key (won't match AGENT_MAP, but the
      // breakdown helper still groups + counts correctly).
      nodeId: archive.functionSlug,
      status: s.status ?? "unknown",
      error: s.error,
      durationMs: s.durationMs,
    })),
  };
}

export async function synthesizeRunSummary(
  args: SynthesizeArgs,
): Promise<RunAiSummary> {
  // (a) Load run — AO-native first, Inngest archive fallback.
  const run = await loadRunSnapshot(args.runId);
  if (!run) throw new RunNotFoundError(args.runId);

  // (b) Recent activity — capped at 200; the prompt uses last 20.
  const activities = await prisma.agentActivity.findMany({
    where: { runId: args.runId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  // Re-order ascending for prompt readability (oldest → newest).
  activities.reverse();

  // (c) Per-agent breakdown
  const breakdown = computeAgentBreakdown(run.steps, activities);

  const stepsTotal = run.steps.length;
  const stepsFailed = run.steps.filter((s) => s.status === "failed").length;
  const errorsExcerpt = buildErrorsExcerpt(run.steps);

  // Base row fields shared across all three write paths. Null defaults for
  // every LLM-observability column so the partial-spread in static/fallback
  // paths still satisfies the full `Omit<RunAiSummary, "id"|"generated_at">`
  // shape that upsertSummary expects.
  const baseRow: Omit<RunAiSummary, "id" | "generated_at" | "summary_text" | "source"> = {
    run_id: run.id,
    trace_id: null,
    function_slug: null,
    trigger_event: run.triggerEvent,
    terminal_status: run.status,
    last_activity_at: run.lastActivityAt,
    trigger_path: args.triggerPath,
    agents_touched: breakdown.length,
    steps_total: stepsTotal,
    steps_failed: stepsFailed,
    activity_count: activities.length,
    errors_excerpt: errorsExcerpt,
    llm_model: null,
    llm_duration_ms: null,
    llm_prompt_tokens: null,
    llm_completion_tokens: null,
    system_prompt: null,
    user_prompt: null,
    llm_raw_text: null,
    prompt_context_chars: null,
    parse_error: null,
  };

  // (d) Empty-run guard
  const hasAnyAgentData = breakdown.length > 0 || activities.length > 0;
  if (!hasAnyAgentData) {
    return upsertSummary({
      ...baseRow,
      summary_text: emptyRunNotice(run),
      source: "static-fallback",
    });
  }

  // (e) Gateway check
  if (!isGatewayConfigured()) {
    return upsertSummary({
      ...baseRow,
      summary_text: deterministicSummary(run, breakdown, run.steps, activities),
      source: "fallback",
    });
  }

  // (f) Build prompt
  const userPrompt = buildUserPrompt(run, breakdown, run.steps, activities, {
    eagerTriggerStatus:
      args.triggerPath === "eager-on-fail" ? args.terminalStatus : undefined,
  });
  const promptContextChars = userPrompt.length;

  // (g) Call gateway
  try {
    const result = await chatComplete({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      temperature: 0.2,
      maxTokens: 900,
    });
    // (j) Success — write `llm` row
    return upsertSummary({
      ...baseRow,
      summary_text:
        result.text ||
        deterministicSummary(run, breakdown, run.steps, activities),
      source: result.text ? "llm" : "fallback",
      llm_model: result.modelUsed,
      llm_duration_ms: result.durationMs,
      llm_prompt_tokens: result.usage?.promptTokens ?? null,
      llm_completion_tokens: result.usage?.completionTokens ?? null,
      system_prompt: SYSTEM_PROMPT,
      user_prompt: userPrompt,
      llm_raw_text: result.text,
      prompt_context_chars: promptContextChars,
    });
  } catch (e) {
    // (h) Gateway unavailable → fallback row
    if (e instanceof GatewayUnavailableError) {
      return upsertSummary({
        ...baseRow,
        summary_text: deterministicSummary(
          run,
          breakdown,
          run.steps,
          activities,
        ),
        source: "fallback",
      });
    }
    // (i) Other errors → re-throw so Inngest can retry
    throw e;
  }
}

// ── Upsert keyed on (run_id, last_activity_at). If a row already exists for
//    this key (e.g. eager-on-fail already wrote it), the existing row is
//    returned unchanged — we don't blow over previous LLM output with a
//    fresh fallback or vice versa. Callers that want to force regeneration
//    must delete the row first.
async function upsertSummary(
  data: Omit<RunAiSummary, "id" | "generated_at">,
): Promise<RunAiSummary> {
  // synthesizeRunSummary always passes non-null run_id + last_activity_at
  // (agent-tuning rows write directly without going through here). The
  // schema marks both nullable to support agent-tuning, but the compound
  // unique key is only meaningful when both are present.
  if (data.run_id === null || data.last_activity_at === null) {
    return prisma.runAiSummary.create({ data });
  }
  const compoundKey = {
    run_id: data.run_id,
    last_activity_at: data.last_activity_at,
  };
  const existing = await prisma.runAiSummary.findUnique({
    where: { run_id_last_activity_at: compoundKey },
  });
  if (existing) return existing;
  try {
    return await prisma.runAiSummary.create({ data });
  } catch (e) {
    // Race: another worker won the upsert. Re-read and return that row.
    const reread = await prisma.runAiSummary.findUnique({
      where: {
        run_id_last_activity_at: compoundKey,
      },
    });
    if (reread) return reread;
    throw e;
  }
}

// Shared breakdown computation. nodeId → AGENT_MAP.short when possible,
// fall back to raw nodeId so the row is still useful.
export function computeAgentBreakdown(
  steps: Array<{
    nodeId: string;
    status: string;
    durationMs: number | null;
  }>,
  activities: Array<{
    agentName: string;
    narrative: string;
    createdAt: Date;
  }>,
): AgentBreakdownRow[] {
  const map = new Map<string, AgentBreakdownRow>();

  for (const s of steps) {
    // s.nodeId may be a canonical short OR an app-prefixed Inngest slug
    // (archive runs). Resolve to the canonical short so the row groups
    // correctly and never leaks a raw slug into the prompt / summary.
    const agentName = resolveAgentMeta(s.nodeId)?.short ?? s.nodeId;
    const row = map.get(agentName) ?? {
      agentName,
      steps: 0,
      failed: 0,
      totalDurationMs: 0,
      lastNarrative: null,
    };
    row.steps += 1;
    if (s.status === "failed") row.failed += 1;
    if (typeof s.durationMs === "number") row.totalDurationMs += s.durationMs;
    map.set(agentName, row);
  }

  // Splice in the latest narrative per agent (so the LLM has a real quote
  // from the agent rather than just a count).
  const lastByAgent = new Map<string, string>();
  for (const a of activities) {
    // Normalize to the same canonical short used for step rows so slug-form
    // and short-form activity names collapse onto one breakdown row.
    const key = resolveAgentMeta(a.agentName)?.short ?? a.agentName;
    lastByAgent.set(key, a.narrative);
  }
  for (const [name, narrative] of lastByAgent) {
    const row = map.get(name) ?? {
      agentName: name,
      steps: 0,
      failed: 0,
      totalDurationMs: 0,
      lastNarrative: null,
    };
    row.lastNarrative = narrative;
    map.set(name, row);
  }
  return Array.from(map.values()).sort((a, b) => b.steps - a.steps);
}

function buildErrorsExcerpt(
  steps: Array<{ nodeId: string; status: string; error: string | null }>,
): string | null {
  const failed = steps.filter((s) => s.error || s.status === "failed");
  if (failed.length === 0) return null;
  // Cap at first 5 errors, each line truncated — keeps the row small but
  // makes /monitor failure lists meaningful at a glance.
  const lines = failed.slice(0, 5).map((s) => {
    const msg = s.error ?? `step ${s.nodeId} failed`;
    return `${s.nodeId}: ${msg.length > 200 ? msg.slice(0, 199) + "…" : msg}`;
  });
  return lines.join("\n");
}
