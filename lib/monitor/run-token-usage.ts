// Per-run token usage aggregator.
//
// Sums tokens captured for a set of Inngest run IDs from two sources:
//
//  1. AgentStepEvidence.output_json — the rule-check pipeline in
//     match-resume-agent writes `output.llm.{prompt_tokens, completion_tokens}`
//     here. This is the only LLM call the 3 deployed agents make locally
//     today (the rest is delegated to RAAS).
//
//  2. AgentActivity.metadata — server/llm/instrumented.ts withLlmTelemetry()
//     writes top-level camelCase `{promptTokens, completionTokens, totalTokens}`
//     for any OpenAI-compatible call. Picked up automatically when future
//     LLM call sites are added.
//
// Both sources are tolerant of partial / malformed JSON; never throws.

import { prisma } from '@/server/db';

export type RunTokenUsage = {
  prompt: number;
  completion: number;
  total: number;
};

const ZERO: RunTokenUsage = { prompt: 0, completion: 0, total: 0 };

export async function getRunTokenUsage(
  runIds: string[],
): Promise<Record<string, RunTokenUsage>> {
  const out: Record<string, RunTokenUsage> = {};
  if (runIds.length === 0) return out;

  const [evidence, activities] = await Promise.all([
    prisma.agentStepEvidence
      .findMany({
        where: { run_id: { in: runIds } },
        select: { run_id: true, output_json: true },
      })
      .catch(() => [] as Array<{ run_id: string; output_json: string | null }>),
    prisma.agentActivity
      .findMany({
        where: { runId: { in: runIds }, type: 'tool' },
        select: { runId: true, metadata: true },
      })
      .catch(() => [] as Array<{ runId: string | null; metadata: string | null }>),
  ]);

  for (const row of evidence) {
    const tu = extractFromEvidenceOutput(row.output_json);
    if (tu.total === 0 && tu.prompt === 0 && tu.completion === 0) continue;
    add(out, row.run_id, tu);
  }
  for (const row of activities) {
    if (!row.runId) continue;
    const tu = extractFromActivityMetadata(row.metadata);
    if (tu.total === 0 && tu.prompt === 0 && tu.completion === 0) continue;
    add(out, row.runId, tu);
  }

  return out;
}

function add(acc: Record<string, RunTokenUsage>, runId: string, tu: RunTokenUsage) {
  const prev = acc[runId] ?? { ...ZERO };
  acc[runId] = {
    prompt: prev.prompt + tu.prompt,
    completion: prev.completion + tu.completion,
    total: prev.total + tu.total,
  };
}

function extractFromEvidenceOutput(json: string | null): RunTokenUsage {
  if (!json) return ZERO;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return ZERO; }
  const llm = (parsed as { llm?: unknown })?.llm;
  if (!llm || typeof llm !== 'object') return ZERO;
  const pt = numericOrZero((llm as Record<string, unknown>).prompt_tokens);
  const ct = numericOrZero((llm as Record<string, unknown>).completion_tokens);
  if (pt === 0 && ct === 0) return ZERO;
  return { prompt: pt, completion: ct, total: pt + ct };
}

function extractFromActivityMetadata(json: string | null): RunTokenUsage {
  if (!json) return ZERO;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(json); } catch { return ZERO; }
  const pt = numericOrZero(parsed.promptTokens);
  const ct = numericOrZero(parsed.completionTokens);
  const tt = numericOrZero(parsed.totalTokens);
  if (pt === 0 && ct === 0 && tt === 0) return ZERO;
  return { prompt: pt, completion: ct, total: tt || (pt + ct) };
}

function numericOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
