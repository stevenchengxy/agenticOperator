import { describe, it, expect } from 'vitest';
import {
  extractTrace,
  diffAgainstGroundTruth,
  scoreBehavioralDiff,
  verdictOf,
} from './behavioral-analyzer';
import type { GroundTruth } from './ground-truth';
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
    sideEffects: 'external HTTP',
    category: 'robohire',
  },
];

const PRODUCTION_LIKE = `
import { NonRetriableError } from 'inngest';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { generateJdDirect } from '@/lib/robohire-client';
import { inngest } from '@/server/inngest/client';

export const x = inngest.createFunction(
  { id: 'create-jd-agent' },
  { event: 'REQUIREMENT_LOGGED' },
  async ({ event, step, logger }) => {
    const detail = await step.run(\`fetch-requirement-\${event.data.id}\`, async () => {
      const r = await getRequirementDetail(event.data.id);
      if (!r) throw new NonRetriableError('missing');
      logger.info('got it');
      return r;
    });
    const gen = await step.run('generate', async () => {
      try {
        return await generateJdDirect({ prompt: 'x' });
      } catch (e) { throw e; }
    });
    await inngest.send({ name: 'JD_GENERATED', data: { gen } });
  },
);
`;

const GROUND_TRUTH: GroundTruth = {
  fixtureName: 'test',
  productionPath: 'irrelevant',
  expectedSteps: [
    { id: 'fetch-requirement', tool: 'partner-pg.getRequirement' },
    { id: 'generate', tool: 'robohire.generateJd' },
  ],
  expectedEmits: [{ name: 'JD_GENERATED' }],
  conventions: { nonRetriableUsed: true, tryCatchUsed: true, minLoggerCalls: 1 },
  replacementVerdict: 'test',
};

describe('extractTrace', () => {
  it('finds step.run blocks in source order', () => {
    const t = extractTrace(PRODUCTION_LIKE, REGISTRY);
    expect(t.steps.length).toBe(2);
    expect(t.steps[0].id).toBe('fetch-requirement'); // template-literal suffix stripped
    expect(t.steps[1].id).toBe('generate');
  });

  it('resolves call sites in step callbacks to tool registry ids', () => {
    const t = extractTrace(PRODUCTION_LIKE, REGISTRY);
    expect(t.steps[0].toolsCalled).toContain('partner-pg.getRequirement');
    expect(t.steps[1].toolsCalled).toContain('robohire.generateJd');
  });

  it('finds inngest.send and extracts the event name', () => {
    const t = extractTrace(PRODUCTION_LIKE, REGISTRY);
    expect(t.emits.length).toBe(1);
    expect(t.emits[0].name).toBe('JD_GENERATED');
    expect(t.emits[0].viaInngestSend).toBe(true);
  });

  it('also recognizes step.sendEvent', () => {
    const src = `await step.sendEvent('k', { name: 'FOO_BAR', data: {} });`;
    const t = extractTrace(src, REGISTRY);
    expect(t.emits[0].name).toBe('FOO_BAR');
    expect(t.emits[0].viaInngestSend).toBe(false);
  });
});

describe('diffAgainstGroundTruth', () => {
  it('matches all expected steps when trace fully covers ground truth', () => {
    const t = extractTrace(PRODUCTION_LIKE, REGISTRY);
    const d = diffAgainstGroundTruth(t, GROUND_TRUTH, PRODUCTION_LIKE);
    expect(d.matchedSteps.length).toBe(2);
    expect(d.missingSteps.length).toBe(0);
  });

  it('flags an expected step as missing when its tool is not called', () => {
    const t = extractTrace(PRODUCTION_LIKE, REGISTRY);
    const gtWithExtra: GroundTruth = {
      ...GROUND_TRUTH,
      expectedSteps: [...GROUND_TRUTH.expectedSteps, { id: 'never-here', tool: 'robohire.generateJd' }],
    };
    const d = diffAgainstGroundTruth(t, gtWithExtra, PRODUCTION_LIKE);
    expect(d.missingSteps.map((s) => s.id)).toContain('never-here');
  });

  it('honors optional expected steps (counts as matched when absent)', () => {
    const t = extractTrace(PRODUCTION_LIKE, REGISTRY);
    const gtWithOpt: GroundTruth = {
      ...GROUND_TRUTH,
      expectedSteps: [...GROUND_TRUTH.expectedSteps, { id: 'optional-step', optional: true }],
    };
    const d = diffAgainstGroundTruth(t, gtWithOpt, PRODUCTION_LIKE);
    expect(d.missingSteps).toEqual([]);
  });

  it('honors alternativeOf on emits', () => {
    const t = extractTrace(PRODUCTION_LIKE, REGISTRY);
    const gtAlt: GroundTruth = {
      ...GROUND_TRUTH,
      expectedEmits: [
        { name: 'JD_GENERATED' },
        { name: 'JD_FAILED', alternativeOf: 'JD_GENERATED' }, // alt of an emit that DID fire
      ],
    };
    const d = diffAgainstGroundTruth(t, gtAlt, PRODUCTION_LIKE);
    expect(d.missingEmits).toEqual([]);
  });

  it('detects convention violations (no NonRetriable, low logger count)', () => {
    const lean = `
      import { inngest } from '@/server/inngest/client';
      export const x = inngest.createFunction({}, { event: 'X' }, async ({ step }) => {
        await step.run('only', async () => {
          return 1;
        });
      });
    `;
    const t = extractTrace(lean, REGISTRY);
    const d = diffAgainstGroundTruth(t, GROUND_TRUTH, lean);
    expect(d.conventionsMet.nonRetriable).toBe(false);
    expect(d.conventionsMet.tryCatch).toBe(false);
    expect(d.conventionsMet.loggerCallsMet).toBe(false);
  });
});

describe('scoreBehavioralDiff + verdictOf', () => {
  it('full match yields FULL verdict', () => {
    const t = extractTrace(PRODUCTION_LIKE, REGISTRY);
    const d = diffAgainstGroundTruth(t, GROUND_TRUTH, PRODUCTION_LIKE);
    const score = scoreBehavioralDiff(d, GROUND_TRUTH);
    expect(score).toBeCloseTo(1, 3);
    expect(verdictOf(score, d)).toBe('FULL');
  });

  it('partial — many missing → DRAFT', () => {
    const lean = `
      import { inngest } from '@/server/inngest/client';
      export const x = inngest.createFunction({}, { event: 'X' }, async ({ step }) => {
        await step.run('different', async () => { return 1; });
      });
    `;
    const t = extractTrace(lean, REGISTRY);
    const d = diffAgainstGroundTruth(t, GROUND_TRUTH, lean);
    const score = scoreBehavioralDiff(d, GROUND_TRUTH);
    expect(verdictOf(score, d)).toBe('DRAFT');
  });
});
