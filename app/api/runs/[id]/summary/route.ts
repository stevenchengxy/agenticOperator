// /api/runs/:id/summary
//
// Returns an LLM-generated summary of a workflow run: what each agent did,
// what the run produced, where things went wrong (if anywhere). Falls back
// to a deterministic statistical render when no LLM gateway is configured
// or when the LLM call fails.
//
// Cache is now Postgres-resident (RunAiSummary table); see
// server/run-summary/synthesize.ts. Read path:
//   1. Look up `RunAiSummary` row keyed on (run_id, last_activity_at).
//   2. If hit, return it (cheap — no LLM call). Stamp `isStale` if the run
//      has new activity since the row was generated.
//   3. Miss → call `synthesizeRunSummary({ triggerPath: 'lazy-on-view' })`
//      which writes a row and returns it.
//   4. `?fresh=1` bypasses the cache lookup and re-synthesizes.
//
// Discriminated-union response shape mirrors
// /api/rule-check-audits/[auditId]/verify (ok: true | ok: false).

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import {
  synthesizeRunSummary,
  RunNotFoundError,
} from "@/server/run-summary/synthesize";
import { deterministicSummary } from "@/server/run-summary/fallback";
import { computeAgentBreakdown } from "@/server/run-summary/synthesize";
import type { AgentBreakdownRow } from "@/server/run-summary/prompt";
import type { RunAiSummary, WorkflowRun } from "@prisma/client";

type RouteCtx = { params: Promise<{ id: string }> };

export type RunSummaryResponse =
  | {
      ok: true;
      runId: string;
      terminalStatus: string | null;
      triggerEvent: string | null;
      summaryText: string;
      source: string;
      triggerPath: string;
      generatedAt: string;
      generatedAgainstActivityAt: string | null;
      isStale: boolean;
      llmModel: string | null;
      llmDurationMs: number | null;
      llmPromptTokens: number | null;
      llmCompletionTokens: number | null;
      agentsTouched: number | null;
      stepsTotal: number | null;
      stepsFailed: number | null;
      // Legacy aliases + run stats — kept so existing /live UI compiles. The
      // text/modelUsed/durationLLMms/status fields duplicate their new-shape
      // siblings for backward compat; the run-level stats (breakdown,
      // activityCount, errorCount, durationMs, startedAt, completedAt) are
      // recomputed at read time from live Prisma data, not cached on the row.
      text: string;
      modelUsed: string | null;
      durationLLMms: number | null;
      status: string;
      agentBreakdown: AgentBreakdownRow[];
      activityCount: number;
      errorCount: number;
      durationMs: number | null;
      startedAt: string;
      completedAt: string | null;
    }
  | {
      ok: false;
      reason: "not_found" | "gateway_unavailable" | "llm_error" | "error";
      message?: string;
      fallback?: string;
    };

async function toResponse(
  row: RunAiSummary,
  run: WorkflowRun,
): Promise<RunSummaryResponse> {
  const generatedAgainstActivityAt = row.last_activity_at;
  const isStale =
    generatedAgainstActivityAt !== null &&
    run.lastActivityAt.getTime() > generatedAgainstActivityAt.getTime();
  // Recompute live stats so the legacy /live UI sees current data even when
  // the cached row is older. Cheap (~50ms total).
  const [steps, activities] = await Promise.all([
    prisma.workflowStep.findMany({
      where: { runId: run.id },
      orderBy: { startedAt: "asc" },
    }),
    prisma.agentActivity.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const agentBreakdown = computeAgentBreakdown(steps, activities);
  const errorCount = steps.filter((s) => s.status === "failed").length;
  const durationMs =
    run.completedAt && run.startedAt
      ? run.completedAt.getTime() - run.startedAt.getTime()
      : null;
  return {
    ok: true,
    runId: run.id,
    terminalStatus: row.terminal_status,
    triggerEvent: row.trigger_event,
    summaryText: row.summary_text,
    source: row.source,
    triggerPath: row.trigger_path,
    generatedAt: row.generated_at.toISOString(),
    generatedAgainstActivityAt:
      generatedAgainstActivityAt?.toISOString() ?? null,
    isStale,
    llmModel: row.llm_model,
    llmDurationMs: row.llm_duration_ms,
    llmPromptTokens: row.llm_prompt_tokens,
    llmCompletionTokens: row.llm_completion_tokens,
    agentsTouched: row.agents_touched ?? agentBreakdown.length,
    stepsTotal: row.steps_total ?? steps.length,
    stepsFailed: row.steps_failed ?? errorCount,
    // Legacy + run-stats fields.
    text: row.summary_text,
    modelUsed: row.llm_model,
    durationLLMms: row.llm_duration_ms,
    status: run.status,
    agentBreakdown,
    activityCount: activities.length,
    errorCount,
    durationMs,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

export async function GET(req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const force = url.searchParams.get("fresh") === "1";

  const run = await prisma.workflowRun.findUnique({ where: { id } });
  if (!run) {
    return NextResponse.json<RunSummaryResponse>(
      {
        ok: false,
        reason: "not_found",
        message: `run ${id} not found`,
      },
      { status: 404 },
    );
  }

  // Cache lookup keyed on (run_id, last_activity_at). If lastActivityAt has
  // advanced since the cached row was generated, we still serve it but mark
  // `isStale: true` — the UI can offer "regenerate".
  if (!force) {
    const cached = await prisma.runAiSummary.findFirst({
      where: {
        run_id: id,
        last_activity_at: run.lastActivityAt,
      },
      orderBy: { generated_at: "desc" },
    });
    if (cached) {
      return NextResponse.json<RunSummaryResponse>(await toResponse(cached, run));
    }
  }

  // Cache miss (or fresh=1) → synthesize.
  try {
    const row = await synthesizeRunSummary({
      runId: id,
      triggerPath: "lazy-on-view",
    });
    return NextResponse.json<RunSummaryResponse>(await toResponse(row, run));
  } catch (e) {
    if (e instanceof RunNotFoundError) {
      return NextResponse.json<RunSummaryResponse>(
        { ok: false, reason: "not_found", message: e.message },
        { status: 404 },
      );
    }
    // Try to render a deterministic fallback for the UI to display.
    let fallbackText: string | undefined;
    try {
      const [steps, activities] = await Promise.all([
        prisma.workflowStep.findMany({
          where: { runId: id },
          orderBy: { startedAt: "asc" },
        }),
        prisma.agentActivity.findMany({
          where: { runId: id },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      const breakdown: AgentBreakdownRow[] = computeAgentBreakdown(
        steps,
        activities,
      );
      fallbackText = deterministicSummary(run, breakdown, steps, activities);
    } catch {
      // ignore — we'll just omit the fallback field
    }
    return NextResponse.json<RunSummaryResponse>(
      {
        ok: false,
        reason: "llm_error",
        message: (e as Error).message,
        fallback: fallbackText,
      },
      { status: 502 },
    );
  }
}

export async function DELETE(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const { count } = await prisma.runAiSummary.deleteMany({
    where: { run_id: id },
  });
  return NextResponse.json({ ok: true, cleared: count });
}
