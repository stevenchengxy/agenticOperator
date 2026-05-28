// GET /api/inngest-admin/agents/[slug]/summary   → returns cached summary OR generates
// POST /api/inngest-admin/agents/[slug]/summary  → force regenerate

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
    const cfg = await prisma.agentConfig.findUnique({
      where: { id: slug },
      select: { tuningNotes: true, lastAdvisedAt: true },
    });
    if (cfg?.tuningNotes) {
      const parsed = JSON.parse(cfg.tuningNotes) as Partial<CachedEntry>;
      return {
        text: parsed.text ?? '',
        model: parsed.model ?? 'unknown',
        durationMs: parsed.durationMs ?? 0,
        promptContextChars: parsed.promptContextChars ?? 0,
        generatedAt: cfg.lastAdvisedAt?.toISOString() ?? new Date().toISOString(),
      };
    }
  } catch {
    /* soft fail */
  }
  return null;
}

async function saveCached(slug: string, entry: Omit<CachedEntry, 'generatedAt'>): Promise<void> {
  try {
    const payload = JSON.stringify(entry);
    await prisma.agentConfig.upsert({
      where: { id: slug },
      update: { tuningNotes: payload, lastAdvisedAt: new Date() },
      create: {
        id: slug,
        enabled: true,
        description: `Inngest function ${slug}`,
        tuningNotes: payload,
        lastAdvisedAt: new Date(),
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
