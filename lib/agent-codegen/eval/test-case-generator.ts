// Test case generator — declarative test cases derived from an AgentSpec
// + tool registry.
//
// For each spec we synthesize 4 cases:
//   1. happy-path           — well-formed event, all tools succeed
//   2. missing-trigger-field — event missing a key data field
//   3. downstream-4xx       — first external-HTTP tool returns 4xx
//   4. idempotency          — same event delivered twice
//
// Output is DECLARATIVE (not runnable). It describes input + mock setup
// + expected outcome, suitable for:
//   - human inspection during a codegen review
//   - mapping into a vitest test scaffold (future Bundle F)
//
// We deliberately don't try to execute these — that requires sandboxed
// dynamic import + mock injection, which is a separate phase.

import type { AgentSpec } from '../spec-types';
import type { ToolRegistryEntry } from '../registries';

export type TestCase = {
  name: string;
  description: string;
  category: 'happy-path' | 'missing-trigger-field' | 'downstream-4xx' | 'idempotency';
  /** Synthetic event payload to feed the agent. */
  inputEvent: { name: string; data: Record<string, unknown> };
  /** Tool mocks the test would set up before invoking the agent. */
  mockSetup: Array<{
    toolId: string;
    /** What the mock returns. `__throw4xx__` is a sentinel — runtime would
     *  throw RobohireApiError(400, 'CLIENT', ...). */
    returns: unknown | '__throw4xx__' | '__throw5xx__';
  }>;
  /** What the agent should do. The behavioral analyzer can't verify these
   *  end-to-end (we don't run code) — they're for hand review or vitest. */
  expectedOutcome: {
    /** Should the handler succeed, or throw a NonRetriableError? */
    handlerResolves: 'success' | 'non-retriable-error' | 'retriable-error';
    /** Which events the handler should emit (any of these, in order). */
    expectedEmits: string[];
  };
};

export function generateTestCases(
  spec: AgentSpec,
  toolRegistry: ReadonlyArray<ToolRegistryEntry>,
  /** When provided (Bundle N), the happy-path case uses this real payload
   *  instead of a synthetic one. Other cases stay synthetic (their job is
   *  to exercise specific failure modes, not realistic shapes). */
  realEventPayload?: Record<string, unknown> | null,
): TestCase[] {
  const cases: TestCase[] = [];

  // ── 1. Happy path ────────────────────────────────────────────────
  // Bundle N: prefer real EventInstance payload when available; falls
  // back to the heuristic synthesizer.
  const happyEventData = realEventPayload ?? synthesizeEvent(spec, null).data;
  const happyEvent = { name: spec.triggerEvent, data: happyEventData };
  const happyMocks = spec.steps
    .filter((s) => !!s.callsLib)
    .map((s) => ({
      toolId: s.callsLib!,
      returns: synthesizeReturnFor(s.callsLib!, toolRegistry),
    }));
  cases.push({
    name: `${spec.slug} · happy path`,
    description: `Deliver a well-formed ${spec.triggerEvent} event; expect the handler to walk all steps and emit ${spec.emitEvents.join(' / ')}.`,
    category: 'happy-path',
    inputEvent: happyEvent,
    mockSetup: happyMocks,
    expectedOutcome: {
      handlerResolves: 'success',
      expectedEmits: spec.emitEvents,
    },
  });

  // ── 2. Missing trigger field ─────────────────────────────────────
  // Pick the first input declared by step 1 (proxy for "required key in event.data").
  const firstStepInputs = spec.steps[0]?.inputs ?? [];
  const missingKey = firstStepInputs[0] ?? 'id';
  cases.push({
    name: `${spec.slug} · missing required event field`,
    description: `Deliver a ${spec.triggerEvent} event missing data.${missingKey}; expect the agent to throw NonRetriableError (no retries waste compute).`,
    category: 'missing-trigger-field',
    inputEvent: { name: spec.triggerEvent, data: {} },
    mockSetup: happyMocks,
    expectedOutcome: {
      handlerResolves: 'non-retriable-error',
      expectedEmits: [],
    },
  });

  // ── 3. First external HTTP call fails 4xx ────────────────────────
  const firstExternalStep = spec.steps.find((s) => {
    if (!s.callsLib) return false;
    const t = toolRegistry.find((r) => r.id === s.callsLib);
    return t ? t.sideEffects.startsWith('external HTTP') : false;
  });
  if (firstExternalStep) {
    const failingMocks = happyMocks.map((m) =>
      m.toolId === firstExternalStep.callsLib
        ? { ...m, returns: '__throw4xx__' as const }
        : m,
    );
    cases.push({
      name: `${spec.slug} · ${firstExternalStep.callsLib} 4xx`,
      description: `Deliver a valid ${spec.triggerEvent} event but have ${firstExternalStep.callsLib} throw RobohireApiError 400. Expect NonRetriableError + emit any -FAILED event when declared.`,
      category: 'downstream-4xx',
      inputEvent: happyEvent,
      mockSetup: failingMocks,
      expectedOutcome: {
        handlerResolves: 'non-retriable-error',
        expectedEmits: spec.emitEvents.filter((e) => e.includes('FAILED') || e.includes('REJECTED')),
      },
    });
  }

  // ── 4. Idempotency check ─────────────────────────────────────────
  cases.push({
    name: `${spec.slug} · idempotency on repeated event`,
    description: `Deliver the same ${spec.triggerEvent} event twice. Expect the second invocation to be safe (step.run keys must be input-derived; allmeta + partner-pg writes must upsert).`,
    category: 'idempotency',
    inputEvent: happyEvent,
    mockSetup: happyMocks,
    expectedOutcome: {
      handlerResolves: 'success',
      expectedEmits: spec.emitEvents,
    },
  });

  return cases;
}

// ────────────────────────────────────────────────────────────────────────
// Synthesis helpers (cheap; we just want plausible payload shape, not real data)
// ────────────────────────────────────────────────────────────────────────

function synthesizeEvent(spec: AgentSpec, missingField: string | null): TestCase['inputEvent'] {
  // Common AO recruitment event shapes — best guess from event name.
  const data: Record<string, unknown> = {};
  if (spec.triggerEvent.includes('REQUIREMENT')) data.job_requisition_id = 'jr_fixture_001';
  if (spec.triggerEvent.includes('RESUME'))
    Object.assign(data, {
      candidate_id: 'cand_fixture_001',
      upload_id: 'upload_fixture_001',
      minio_object_key: 'resumes/fixture-001.pdf',
      filename: 'fixture.pdf',
    });
  if (spec.triggerEvent.includes('MATCH'))
    Object.assign(data, {
      job_requisition_id: 'jr_fixture_001',
      candidate_id: 'cand_fixture_001',
      parsed_resume_json: { name: 'Fixture Candidate', skills: ['typescript'] },
    });
  if (spec.triggerEvent.includes('INTERVIEW'))
    Object.assign(data, {
      candidate_id: 'cand_fixture_001',
      job_requisition_id: 'jr_fixture_001',
      candidate_email: 'fixture@example.com',
    });
  if (spec.triggerEvent === 'JD_APPROVED' || spec.triggerEvent === 'JD_REJECTED')
    data.job_posting_id = 'jp_fixture_001';
  // Default fallback.
  if (Object.keys(data).length === 0) data.id = 'fixture_001';

  if (missingField && missingField in data) delete data[missingField];
  return { name: spec.triggerEvent, data };
}

function synthesizeReturnFor(toolId: string, registry: ReadonlyArray<ToolRegistryEntry>): unknown {
  const t = registry.find((r) => r.id === toolId);
  if (!t) return { ok: true };
  // Domain-aware stubs for common return shapes.
  if (t.id === 'partner-pg.getRequirement')
    return {
      job_requisition_id: 'jr_fixture_001',
      client_id: 'client_fixture',
      client_job_title: 'Senior SRE',
      must_have_skills: ['typescript'],
      specification: null,
    };
  if (t.id === 'partner-pg.getParsedResume')
    return { candidate_id: 'cand_fixture_001', parsed_resume_json: { name: 'Fixture' } };
  if (t.id === 'robohire.parseResume')
    return { data: { name: 'Fixture', skills: ['ts'] }, requestId: 'req_fixture' };
  if (t.id === 'robohire.matchResume')
    return { data: { matchScore: 78, recommendation: 'GOOD_MATCH' }, requestId: 'req_fixture' };
  if (t.id === 'robohire.generateJd')
    return { data: { posting_title: 'Senior SRE', posting_description: 'JD body' }, requestId: 'req_fixture' };
  if (t.id === 'robohire.inviteCandidate')
    return { data: { success: true, invite_url: 'https://gohire.example/invite' }, requestId: 'req_fixture' };
  if (t.id === 'partner-pg.syncJd')
    return { synced: true, job_posting_id: 'jp_fixture_001' };
  if (t.id === 'partner-pg.saveCandidate')
    return { candidate_id: 'cand_fixture_001', created: true };
  if (t.id === 'partner-pg.saveMatchResults')
    return { candidate_match_result_id: 'cmr_fixture', created: true };
  if (t.category === 'allmeta') return { ok: true };
  if (t.id === 'rule-check.run')
    return { verdict: 'pass', dims: [], auditId: 'audit_fixture' };
  return { ok: true };
}
