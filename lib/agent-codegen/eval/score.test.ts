import { describe, it, expect } from 'vitest';
import {
  extractFeatures,
  scoreCandidate,
  scoreImportOverlap,
  scoreStepOverlap,
  scorePatternAdherence,
  scoreLocRatio,
} from './score';

const PRODUCTION_SAMPLE = `
import { NonRetriableError } from 'inngest';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { writeJobRequisitionInstance } from '@/lib/allmeta-writers';
import { inngest } from '@/server/inngest/client';

export const createJdAgent = inngest.createFunction(
  { id: 'create-jd-agent', name: 'Create JD Agent', retries: 2 },
  { event: 'REQUIREMENT_LOGGED' },
  async ({ event, step, logger }) => {
    const detail = await step.run('fetch-requirement', async () => {
      const r = await getRequirementDetail(event.data.id);
      if (!r) throw new NonRetriableError('not found');
      logger.info('fetched ' + r.id);
      return r;
    });

    await step.run('write-jr-neo4j', async () => {
      const r = await writeJobRequisitionInstance({ requirement: detail });
      if (!r.ok) logger.warn('allmeta write failed');
      return r;
    });

    try {
      await step.run('emit', async () => {
        await inngest.send({ name: 'JD_GENERATED', data: {} });
      });
    } catch (e) {
      logger.error('emit failed');
    }
  },
);
`;

describe('extractFeatures', () => {
  it('pulls imports, step IDs, pattern flags', () => {
    const f = extractFeatures(PRODUCTION_SAMPLE);
    expect(f.importedNames.has('getRequirementDetail')).toBe(true);
    expect(f.importedNames.has('NonRetriableError')).toBe(true);
    expect(f.importPaths.has('@/lib/partner-pg/requirements')).toBe(true);
    expect(f.stepIds.has('fetch-requirement')).toBe(true);
    expect(f.stepIds.has('write-jr-neo4j')).toBe(true);
    expect(f.hasNonRetriable).toBe(true);
    expect(f.tryCatchCount).toBeGreaterThan(0);
    expect(f.loggerCallCount).toBeGreaterThan(0);
  });

  it('strips template-literal suffixes from step IDs for fair compare', () => {
    const f = extractFeatures("await step.run(`fetch-requirement-${id}`, async () => {});");
    expect(f.stepIds.has('fetch-requirement')).toBe(true);
  });

  it('tool references require usage beyond the import line', () => {
    // No leading indentation — IMPORT_RE matches lines starting with 'import'.
    const src =
      "import { used, unused } from '@/lib/foo';\n" +
      "console.log(used);\n";
    const f = extractFeatures(src);
    expect(f.toolReferences.has('used')).toBe(true);
    expect(f.toolReferences.has('unused')).toBe(false);
  });
});

describe('scorers', () => {
  it('importOverlap = 1 when identical, 0 when disjoint', () => {
    const a = extractFeatures(PRODUCTION_SAMPLE);
    const same = extractFeatures(PRODUCTION_SAMPLE);
    expect(scoreImportOverlap(a, same)).toBe(1);

    const empty = extractFeatures("export const x = 1;");
    expect(scoreImportOverlap(a, empty)).toBe(0);
  });

  it('stepOverlap counts production IDs found in candidate', () => {
    const prod = extractFeatures(PRODUCTION_SAMPLE);
    const candidate = extractFeatures(`
      await step.run('fetch-requirement', async () => {});
      await step.run('different-step', async () => {});
    `);
    // 1 of 3 prod step IDs ('emit' / 'write-jr-neo4j' / 'fetch-requirement')
    const s = scoreStepOverlap(prod, candidate);
    expect(s).toBeCloseTo(1 / 3, 5);
  });

  it('patternAdherence rewards try/catch + NonRetriableError + logger', () => {
    const prod = extractFeatures(PRODUCTION_SAMPLE);
    const naked = extractFeatures("export const x = 1;");
    expect(scorePatternAdherence(prod, naked)).toBe(0);

    const full = extractFeatures(PRODUCTION_SAMPLE);
    expect(scorePatternAdherence(prod, full)).toBe(1);
  });

  it('locRatio = 1 within 1.5x, 0 beyond 4x', () => {
    const prod = extractFeatures('a\nb\nc\nd\ne\nf\ng\nh\ni\nj'); // 10 LOC
    expect(scoreLocRatio(prod, extractFeatures('a\nb\nc'))).toBe(1);
    expect(scoreLocRatio(prod, extractFeatures('x\n'.repeat(15)))).toBe(1); // exactly 1.5x
    expect(scoreLocRatio(prod, extractFeatures('x\n'.repeat(50)))).toBe(0); // > 4x
  });

  it('composite score on identical input is 1.0', () => {
    const br = scoreCandidate(PRODUCTION_SAMPLE, PRODUCTION_SAMPLE);
    expect(br.composite).toBeCloseTo(1, 3);
    expect(br.imports).toBe(1);
    expect(br.steps).toBe(1);
    expect(br.details.missingImports).toEqual([]);
    expect(br.details.missingSteps).toEqual([]);
  });

  it('composite reports missing/extra in details', () => {
    const br = scoreCandidate(
      PRODUCTION_SAMPLE,
      "import { onlyMine } from 'x'; await step.run('different-id', async () => {});",
    );
    expect(br.details.missingImports.length).toBeGreaterThan(0);
    expect(br.details.extraImports).toContain('onlyMine');
    expect(br.details.missingSteps).toContain('fetch-requirement');
    expect(br.details.extraSteps).toContain('different-id');
  });
});
