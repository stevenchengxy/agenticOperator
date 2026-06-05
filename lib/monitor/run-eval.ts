// AI fact-monitor orchestrator — samples recent business outputs, judges each
// for groundedness with the primary (cross-family) judge, escalates contested
// cases to a jury, writes a MonitorEval row per sample, and emits a candidate/
// job notification on not_grounded (unless autonomy=read_only). Off-Inngest;
// fired fire-and-forget by the sweeper and POST /api/monitor/eval. The judge is
// injected (JudgeFn → null when the gateway is down → skip, never throw); the
// authoritative deterministic rule-check is untouched.

import type { CaptureInput } from '@/server/notifications/derive';
import { sampleByPct } from './sampling';
import type { GroundednessSample } from './groundedness';
import { tallyJury, type JuryVote, type Verdict } from './judge';
import { JUDGE_PROMPT_VERSION, RUBRIC_VERSION, type ResolvedMonitorConfig } from './monitor-config';

export interface JudgeOutcome {
  verdict: Verdict;
  score: number | null;
  rationale: string | null;
  model: string;
  family: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
}

/** Judge one sample. Returns null when the gateway is unavailable (→ skip). */
export type JudgeFn = (sample: GroundednessSample) => Promise<JudgeOutcome | null>;

export interface MonitorEvalRecord {
  kind: string;
  domain: string;
  agent: string | null;
  runId: string | null;
  auditId: string | null;
  anchorsJson: string | null;
  score: number | null;
  verdict: Verdict;
  juryVotesJson: string | null;
  rationale: string | null;
  judgeModel: string | null;
  judgeFamily: string | null;
  judgePromptVersion: string;
  rubricVersion: string;
  primaryAgreed: boolean | null;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
  llmDurationMs: number | null;
  sampledFrom: string;
  sweepWindow: string | null;
  autonomyMode: string;
  suppressed: boolean;
  aiSource: string;
}

export interface EvalStore {
  upsertEval(rec: MonitorEvalRecord): Promise<void>;
}

export interface RunEvalDeps {
  samples: GroundednessSample[];
  config: ResolvedMonitorConfig;
  primaryJudge: JudgeFn;
  juryJudges?: JudgeFn[];
  store: EvalStore;
  record?: (input: CaptureInput) => Promise<unknown>;
  sweepWindow?: string;
}

export interface EvalReport {
  evaluated: number;
  contested: number;
  flagged: number;
  skipped: number;
}

export async function runEvalSample(deps: RunEvalDeps): Promise<EvalReport> {
  const picked = sampleByPct(deps.samples, deps.config.samplingPct);
  let evaluated = 0;
  let contested = 0;
  let flagged = 0;
  let skipped = 0;

  for (const s of picked) {
    const primary = await deps.primaryJudge(s);
    if (!primary) {
      skipped++; // gateway down → deterministic rule-check stays authoritative
      continue;
    }
    evaluated++;

    let finalVerdict = primary.verdict;
    let primaryAgreed: boolean | null = null;
    let votesJson: string | null = null;

    if (deps.juryJudges && deps.juryJudges.length > 0) {
      const outcomes = (await Promise.all(deps.juryJudges.map((j) => j(s)))).filter(
        Boolean,
      ) as JudgeOutcome[];
      if (outcomes.length > 0) {
        primaryAgreed = outcomes.every((o) => o.verdict === primary.verdict);
        if (!primaryAgreed) {
          contested++;
          finalVerdict = tallyJury([primary.verdict, ...outcomes.map((o) => o.verdict)]).verdict;
        }
        const votes: JuryVote[] = [
          { model: primary.model, family: primary.family, verdict: primary.verdict },
          ...outcomes.map((o) => ({ model: o.model, family: o.family, verdict: o.verdict })),
        ];
        votesJson = JSON.stringify(votes);
      }
    }

    const suppressed = deps.config.autonomy === 'read_only';
    await deps.store.upsertEval({
      kind: 'groundedness',
      domain: s.domain,
      agent: s.agent,
      runId: s.runId,
      auditId: s.auditId,
      anchorsJson: Object.keys(s.anchors).length ? JSON.stringify(s.anchors) : null,
      score: primary.score,
      verdict: finalVerdict,
      juryVotesJson: votesJson,
      rationale: primary.rationale,
      judgeModel: primary.model,
      judgeFamily: primary.family,
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      rubricVersion: RUBRIC_VERSION,
      primaryAgreed,
      llmPromptTokens: primary.promptTokens ?? null,
      llmCompletionTokens: primary.completionTokens ?? null,
      llmDurationMs: primary.durationMs ?? null,
      sampledFrom: s.sampledFrom,
      sweepWindow: deps.sweepWindow ?? null,
      autonomyMode: deps.config.autonomy,
      suppressed,
      aiSource: 'llm',
    });

    if (finalVerdict === 'not_grounded') {
      flagged++;
      if (!suppressed && deps.record) {
        // anchors-driven candidate/job classification (NO eventName); auditId
        // lights the rule_check deep-link when present.
        await deps.record({
          level: 'warn',
          category: 'agent_lifecycle',
          source: s.agent ?? '事实监控',
          agent: s.agent ?? undefined,
          message: `事实审查存疑:${s.agent ?? '产出'} 的结论未被依据充分支持`,
          dedupeHint: `groundedness.${s.sampledFrom}`,
          domain: s.domain,
          runId: s.runId,
          auditId: s.auditId ?? undefined,
          anchors: s.anchors,
        });
      }
    }
  }

  return { evaluated, contested, flagged, skipped };
}
