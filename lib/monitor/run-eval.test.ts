import { describe, it, expect } from 'vitest';
import { runEvalSample, type JudgeFn, type MonitorEvalRecord } from './run-eval';
import { resolveMonitorConfig } from './monitor-config';
import type { GroundednessSample } from './groundedness';
import type { CaptureInput } from '@/server/notifications/derive';

const defaults = resolveMonitorConfig(null, '招聘-v1');

function judge(verdict: 'grounded' | 'not_grounded', score = 0.5): JudgeFn {
  return async () => ({ verdict, score, rationale: 'r', model: 'openai/gpt-4o', family: 'openai' });
}
const gatewayDown: JudgeFn = async () => null;

function sample(id: string, anchors: Record<string, string> = {}): GroundednessSample {
  return {
    sampledFrom: id,
    domain: '招聘-v1',
    agent: 'Matcher',
    runId: id,
    auditId: null,
    anchors,
    output: 'o',
    context: 'c',
  };
}

function memStore() {
  const rows: MonitorEvalRecord[] = [];
  return { rows, store: { upsertEval: async (r: MonitorEvalRecord) => void rows.push(r) } };
}

describe('runEvalSample', () => {
  it('judges sampled outputs and stores one eval per sample', async () => {
    const { rows, store } = memStore();
    const r = await runEvalSample({
      samples: [sample('a'), sample('b')],
      config: { ...defaults, samplingPct: 100, autonomy: 'notify' },
      primaryJudge: judge('grounded', 0.9),
      store,
    });
    expect(r.evaluated).toBe(2);
    expect(rows.length).toBe(2);
    expect(rows[0].verdict).toBe('grounded');
    expect(rows[0].judgePromptVersion).toBeTruthy();
    expect(rows[0].aiSource).toBe('llm');
  });

  it('emits a candidate notification for not_grounded when autonomy != read_only', async () => {
    const { store } = memStore();
    const recorded: CaptureInput[] = [];
    const r = await runEvalSample({
      samples: [sample('c', { candidate_id: 'C1' })],
      config: { ...defaults, samplingPct: 100, autonomy: 'notify' },
      primaryJudge: judge('not_grounded', 0.3),
      store,
      record: async (f) => void recorded.push(f),
    });
    expect(r.flagged).toBe(1);
    expect(recorded.length).toBe(1);
    expect(recorded[0].anchors).toEqual({ candidate_id: 'C1' });
    expect(recorded[0].dedupeHint).toBe('groundedness.c');
    expect(recorded[0].eventName ?? null).toBeNull(); // anchors-driven candidate, not event
  });

  it('suppresses notifications under read_only autonomy', async () => {
    const { store } = memStore();
    const recorded: CaptureInput[] = [];
    const r = await runEvalSample({
      samples: [sample('d', { candidate_id: 'C2' })],
      config: { ...defaults, samplingPct: 100, autonomy: 'read_only' },
      primaryJudge: judge('not_grounded', 0.3),
      store,
      record: async (f) => void recorded.push(f),
    });
    expect(r.flagged).toBe(1);
    expect(recorded.length).toBe(0);
  });

  it('skips (no store, no throw) when the gateway is down', async () => {
    const store = {
      upsertEval: async () => {
        throw new Error('should not store on gateway-down');
      },
    };
    const r = await runEvalSample({
      samples: [sample('e')],
      config: { ...defaults, samplingPct: 100 },
      primaryJudge: gatewayDown,
      store,
    });
    expect(r.evaluated).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('escalates a contested case to the jury (primaryAgreed=false, jury majority wins)', async () => {
    const { rows, store } = memStore();
    const r = await runEvalSample({
      samples: [sample('f')],
      config: { ...defaults, samplingPct: 100, autonomy: 'read_only' },
      primaryJudge: judge('grounded', 0.9),
      juryJudges: [judge('not_grounded', 0.2), judge('not_grounded', 0.2)],
      store,
    });
    expect(r.contested).toBe(1);
    expect(rows[0].primaryAgreed).toBe(false);
    expect(rows[0].verdict).toBe('not_grounded'); // 2 not_grounded vs 1 grounded
    expect(JSON.parse(rows[0].juryVotesJson!).length).toBe(3);
  });
});
