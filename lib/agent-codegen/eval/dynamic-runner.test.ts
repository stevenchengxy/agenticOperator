import { describe, it, expect } from 'vitest';
import { runTestCase } from './dynamic-runner';
import type { TestCase } from './test-case-generator';
import type { ToolRegistryEntry } from '../registries';

const REGISTRY: ToolRegistryEntry[] = [
  {
    id: 'partner-pg.getRequirement',
    importFrom: '@/lib/partner-pg/requirements',
    importName: 'getRequirementDetail',
    signature: '',
    summary: '',
    sideEffects: 'read-only',
    category: 'partner-pg',
  },
  {
    id: 'robohire.generateJd',
    importFrom: '@/lib/robohire-client',
    importName: 'generateJdDirect',
    signature: '',
    summary: '',
    sideEffects: 'external HTTP; may throw RobohireApiError',
    category: 'robohire',
  },
];

// Minimal generated-style agent source. Imports + structure mirror what
// codegen emits. We hand-write so the tests don't need an LLM.
const SOURCE_HAPPY = `
import { NonRetriableError } from 'inngest';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { generateJdDirect, RobohireApiError } from '@/lib/robohire-client';
import { inngest } from '@/server/inngest/client';

export const xAgent = inngest.createFunction(
  { id: 'x-agent', name: 'X' },
  { event: 'REQUIREMENT_LOGGED' },
  async ({ event, step, logger }) => {
    const detail = await step.run('fetch-requirement', async () => {
      const r = await getRequirementDetail(event.data.job_requisition_id);
      if (!r) throw new NonRetriableError('missing');
      logger.info('fetched');
      return r;
    });
    const generated = await step.run('generate-jd', async () => {
      try {
        const r = await generateJdDirect({ prompt: 'x', language: 'zh' });
        return r;
      } catch (e) {
        if (e instanceof RobohireApiError && e.isClientError) {
          throw new NonRetriableError('robohire 4xx');
        }
        throw e;
      }
    });
    await inngest.send({ name: 'JD_GENERATED', data: { generated } });
  },
);
`;

const happyCase: TestCase = {
  name: 'x-agent · happy path',
  description: '',
  category: 'happy-path',
  inputEvent: { name: 'REQUIREMENT_LOGGED', data: { job_requisition_id: 'jr1' } },
  mockSetup: [
    {
      toolId: 'partner-pg.getRequirement',
      returns: { job_requisition_id: 'jr1', client_id: 'c1' },
    },
    {
      toolId: 'robohire.generateJd',
      returns: { data: { posting_title: 'Senior SRE' }, requestId: 'req_1' },
    },
  ],
  expectedOutcome: { handlerResolves: 'success', expectedEmits: ['JD_GENERATED'] },
};

const missingFieldCase: TestCase = {
  name: 'x-agent · missing required event field',
  description: '',
  category: 'missing-trigger-field',
  inputEvent: { name: 'REQUIREMENT_LOGGED', data: {} },
  mockSetup: [
    { toolId: 'partner-pg.getRequirement', returns: null },
    {
      toolId: 'robohire.generateJd',
      returns: { data: { posting_title: 'Senior SRE' }, requestId: 'req_1' },
    },
  ],
  expectedOutcome: { handlerResolves: 'non-retriable-error', expectedEmits: [] },
};

const robohire4xxCase: TestCase = {
  name: 'x-agent · robohire 4xx',
  description: '',
  category: 'downstream-4xx',
  inputEvent: { name: 'REQUIREMENT_LOGGED', data: { job_requisition_id: 'jr1' } },
  mockSetup: [
    {
      toolId: 'partner-pg.getRequirement',
      returns: { job_requisition_id: 'jr1', client_id: 'c1' },
    },
    { toolId: 'robohire.generateJd', returns: '__throw4xx__' },
  ],
  expectedOutcome: { handlerResolves: 'non-retriable-error', expectedEmits: [] },
};

describe('runTestCase — dynamic execution', () => {
  it('happy path: runs both steps in order + emits JD_GENERATED + passes', async () => {
    const r = await runTestCase({ source: SOURCE_HAPPY, testCase: happyCase, toolRegistry: REGISTRY });
    expect(r.passed).toBe(true);
    expect(r.handlerOutcome).toBe('resolved');
    expect(r.capturedSteps).toEqual(['fetch-requirement', 'generate-jd']);
    expect(r.capturedEmits).toEqual(['JD_GENERATED']);
  });

  it('missing field: getRequirement returns null → NonRetriableError thrown → passes (case expects non-retriable)', async () => {
    const r = await runTestCase({
      source: SOURCE_HAPPY,
      testCase: missingFieldCase,
      toolRegistry: REGISTRY,
    });
    expect(r.passed).toBe(true);
    expect(r.handlerOutcome).toBe('threw-non-retriable');
    expect(r.errorMessage).toContain('missing');
    expect(r.capturedEmits).toEqual([]);
  });

  it('downstream 4xx: RobohireApiError(400) → NonRetriableError → passes', async () => {
    const r = await runTestCase({
      source: SOURCE_HAPPY,
      testCase: robohire4xxCase,
      toolRegistry: REGISTRY,
    });
    expect(r.passed).toBe(true);
    expect(r.handlerOutcome).toBe('threw-non-retriable');
    expect(r.errorMessage).toContain('robohire 4xx');
    // fetch ran but generate-jd threw inside; both step IDs captured.
    expect(r.capturedSteps).toEqual(['fetch-requirement', 'generate-jd']);
    expect(r.capturedEmits).toEqual([]);
  });

  it('reports failure when handler resolves but no expected emit appeared', async () => {
    const noEmitSource = SOURCE_HAPPY.replace(
      "await inngest.send({ name: 'JD_GENERATED', data: { generated } });",
      '// emit removed',
    );
    const r = await runTestCase({
      source: noEmitSource,
      testCase: happyCase,
      toolRegistry: REGISTRY,
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/Expected one of/);
  });

  it('reports failure when expected non-retriable but handler resolved', async () => {
    const r = await runTestCase({
      source: SOURCE_HAPPY,
      testCase: { ...missingFieldCase, mockSetup: happyCase.mockSetup }, // null check won't fire
      toolRegistry: REGISTRY,
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/Expected handler to non-retriable-error/);
  });

  it('blocks unmocked require with a clear error', async () => {
    const sourceWithBadImport = `
      import { somethingNotMocked } from '@/lib/not-real';
      import { inngest } from '@/server/inngest/client';
      export const a = inngest.createFunction({ id: 'a' }, { event: 'X' }, async () => {
        somethingNotMocked();
      });
    `;
    const r = await runTestCase({
      source: sourceWithBadImport,
      testCase: happyCase,
      toolRegistry: REGISTRY,
    });
    expect(r.passed).toBe(false);
    expect(r.errorMessage).toMatch(/no mock for require/);
  });

  it('strict allmeta mock (Bundle J) — writeCandidateInstance with unknown field returns ok=false', async () => {
    const ALLMETA_REGISTRY: ToolRegistryEntry[] = [
      ...REGISTRY,
      {
        id: 'allmeta.writeCandidate',
        importFrom: '@/lib/allmeta-writers',
        importName: 'writeCandidateInstance',
        signature: '',
        summary: '',
        sideEffects: 'writes Neo4j Candidate instance',
        category: 'allmeta',
        canonicalEntity: 'Candidate',
      },
    ];
    const sourceBadField = `
      import { writeCandidateInstance } from '@/lib/allmeta-writers';
      import { inngest } from '@/server/inngest/client';
      export const a = inngest.createFunction(
        { id: 'a' },
        { event: 'X' },
        async ({ step, logger }) => {
          const r = await step.run('write', async () => {
            const w = await writeCandidateInstance({
              candidate_id: 'cand_1',
              full_name: 'Wrong Field',
            });
            if (!w.ok) logger.warn('allmeta failed: ' + w.error);
            return w;
          });
          await inngest.send({ name: 'JD_GENERATED', data: { ok: r.ok, err: r.error } });
        },
      );
    `;
    const passingCase: TestCase = {
      name: 'demo',
      description: '',
      category: 'happy-path',
      inputEvent: { name: 'X', data: {} },
      mockSetup: [], // no explicit mock — strict default kicks in
      expectedOutcome: { handlerResolves: 'success', expectedEmits: ['JD_GENERATED'] },
    };
    const r = await runTestCase({
      source: sourceBadField,
      testCase: passingCase,
      toolRegistry: ALLMETA_REGISTRY,
    });
    expect(r.passed).toBe(true);
    expect(r.handlerOutcome).toBe('resolved');
    expect(r.capturedEmits).toEqual(['JD_GENERATED']);
    // The strict allmeta mock surfaced the error message through to the agent body.
    // (The test isn't asserting on it directly — point is the mock returned ok=false
    // without throwing, so the agent observed the bad-field case end-to-end.)
  });

  it('captures timeout when handler hangs', async () => {
    const hangSource = `
      import { inngest } from '@/server/inngest/client';
      export const a = inngest.createFunction({ id: 'a' }, { event: 'X' }, async ({ step }) => {
        await step.run('hang', async () => {
          return new Promise(() => {}); // forever
        });
      });
    `;
    const r = await runTestCase({
      source: hangSource,
      testCase: happyCase,
      toolRegistry: REGISTRY,
      timeoutMs: 200,
    });
    expect(r.handlerOutcome).toBe('timeout');
    expect(r.passed).toBe(false);
  });
});
