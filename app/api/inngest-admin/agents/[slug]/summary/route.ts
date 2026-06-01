// GET /api/inngest-admin/agents/[slug]/summary   → returns cached summary OR generates
// POST /api/inngest-admin/agents/[slug]/summary  → force regenerate
//
// Cache storage: prisma.runAiSummary with trigger_path='agent-tuning',
// function_slug=<slug>, run_id=null, last_activity_at=null. Cache key is
// time-based (30 min TTL) — we read the most recent row for this slug and
// honor it if it's still fresh. We previously squatted on
// AgentConfig.tuningNotes (a free-form JSON column) which conflated agent
// configuration with cached LLM output; this route no longer touches that
// column. The column itself is still in the schema for future config use.

import { NextResponse } from 'next/server';
import {
  listFunctions,
  listRunsWithEvents,
  getRunHistory,
} from '@/lib/inngest-source';
import {
  generateAgentSummary,
  staticSummaryFor,
  KNOWN_DESCRIPTIONS,
} from '@/lib/agent-summary-llm';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

type CachedEntry = {
  text: string;
  model: string;
  durationMs: number;
  promptContextChars: number;
  generatedAt: string;
};

async function loadCached(slug: string): Promise<CachedEntry | null> {
  try {
    const row = await prisma.runAiSummary.findFirst({
      where: { function_slug: slug, trigger_path: 'agent-tuning' },
      orderBy: { generated_at: 'desc' },
    });
    if (!row) return null;
    return {
      text: row.summary_text,
      model: row.llm_model ?? 'unknown',
      durationMs: row.llm_duration_ms ?? 0,
      promptContextChars: row.prompt_context_chars ?? 0,
      generatedAt: row.generated_at.toISOString(),
    };
  } catch {
    /* soft fail */
    return null;
  }
}

async function saveCached(slug: string, entry: Omit<CachedEntry, 'generatedAt'>): Promise<void> {
  try {
    await prisma.runAiSummary.create({
      data: {
        run_id: null,
        last_activity_at: null,
        function_slug: slug,
        trigger_path: 'agent-tuning',
        summary_text: entry.text,
        source: entry.model === 'static-fallback' ? 'static-fallback' : 'llm',
        llm_model: entry.model,
        llm_duration_ms: entry.durationMs,
        prompt_context_chars: entry.promptContextChars,
      },
    });
  } catch {
    /* soft fail */
  }
}

async function build(slug: string): Promise<{ text: string; model: string; durationMs: number; cached: boolean; generatedAt: string; promptContextChars: number }> {
  // 1) Function meta
  const allFns = await listFunctions();
  const fn = allFns.find((f) => f.slug === slug);
  if (!fn) {
    throw new Error(`agent ${slug} not registered`);
  }

  // 2) Recent runs (last 24h) with event payloads
  const runs = await listRunsWithEvents(slug, { limit: 60, sinceHours: 24 });
  const total = runs.length;
  const completed = runs.filter((r) => r.status === 'Completed').length;
  const failed = runs.filter((r) => r.status === 'Failed').length;
  const successRate = total > 0 ? Math.round((completed / total) * 100) : null;
  const durations = runs.filter((r) => r.durationMs != null).map((r) => r.durationMs as number);
  const avgDurationMs = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  // 3) For richer LLM context: fetch step history of a representative successful run
  const exampleRun = runs.find((r) => r.status === 'Completed') ?? runs[0];
  let exampleStepNames: string[] = [];
  if (exampleRun) {
    try {
      const hist = await getRunHistory(exampleRun.runId);
      // V2 trace gives us per-step structure directly; drop the function-
      // lifecycle marker spans ("function success" / "function failure")
      // that aren't real user steps.
      const stepNames = (hist.steps ?? [])
        .filter((s) => s.status.toUpperCase() === 'COMPLETED' && s.stepOp === 'RUN' && s.name)
        .map((s) => s.name);
      exampleStepNames = Array.from(new Set(stepNames)); // dedupe in order
    } catch {
      /* soft */
    }
  }

  // 4) Recent failure reason (if any)
  let recentFailureReason: string | undefined;
  const failedRun = runs.find((r) => r.status === 'Failed');
  if (failedRun) {
    try {
      const hist = await getRunHistory(failedRun.runId);
      const out = hist.output as { error?: { message?: string } } | string | null;
      if (typeof out === 'object' && out?.error?.message) {
        recentFailureReason = out.error.message.slice(0, 200);
      } else if (typeof out === 'string') {
        recentFailureReason = out.slice(0, 200);
      }
    } catch {
      /* soft */
    }
  }

  // 5) Output events for this agent — inferred from STATIC descriptions naming convention.
  //    (Inngest dev server doesn't expose this directly; we approximate from runs' downstream events.)
  const downstreamGuess: Record<string, string[]> = {
    'agentic-operator-main-resume-parser-agent': ['RESUME_PROCESSED'],
    'agentic-operator-main-create-jd-agent': ['JD_GENERATED'],
    'agentic-operator-main-match-resume-agent': ['MATCH_PASSED_NEED_INTERVIEW', 'MATCH_PASSED_NO_INTERVIEW', 'MATCH_FAILED'],
  };

  // 6) Build LLM input with all the rich context
  const input = {
    name: fn.name,
    slug: fn.slug,
    triggers: fn.triggers.map((t) => t.value),
    outputEvents: downstreamGuess[slug],
    stats: { total, completed, failed, successRate },
    avgDurationMs,
    exampleEventName: exampleRun?.eventName,
    exampleEventPayload: exampleRun?.eventPayload ?? null,
    exampleStepNames,
    knownDescription: KNOWN_DESCRIPTIONS[slug],
    recentFailureReason,
  };

  const result = await generateAgentSummary(input);
  const promptContextChars =
    (input.knownDescription?.length ?? 0) +
    JSON.stringify(input.exampleEventPayload ?? {}).length +
    input.exampleStepNames.join(' ').length;

  return { ...result, cached: false, generatedAt: new Date().toISOString(), promptContextChars };
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    // Cached?
    const cached = await loadCached(slug);
    if (cached) {
      const age = Date.now() - new Date(cached.generatedAt).getTime();
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({ ...cached, cached: true, ageMs: age });
      }
    }
    // Generate fresh
    const fresh = await build(slug);
    await saveCached(slug, {
      text: fresh.text,
      model: fresh.model,
      durationMs: fresh.durationMs,
      promptContextChars: fresh.promptContextChars,
    });
    return NextResponse.json(fresh);
  } catch (err) {
    // Final fallback: static
    return NextResponse.json({
      text: staticSummaryFor({
        name: slug,
        slug,
        triggers: [],
        stats: { total: 0, completed: 0, failed: 0, successRate: null },
      }),
      model: 'static-fallback',
      durationMs: 0,
      cached: false,
      generatedAt: new Date().toISOString(),
      error: (err as Error).message,
    });
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const fresh = await build(slug);
    await saveCached(slug, {
      text: fresh.text,
      model: fresh.model,
      durationMs: fresh.durationMs,
      promptContextChars: fresh.promptContextChars,
    });
    return NextResponse.json(fresh);
  } catch (err) {
    return NextResponse.json(
      { error: 'summary-generate-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
