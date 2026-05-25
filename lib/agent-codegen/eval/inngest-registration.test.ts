import { describe, it, expect } from 'vitest';
import { checkInngestRegistration } from './inngest-registration';
import type { AgentFormFields } from '../spec-types';

const FORM: AgentFormFields = {
  slug: 'demo-foo-agent',
  displayName: 'Demo Foo Agent',
  stage: 'system',
  ownerTeam: 'AO·UI',
  triggerEvent: 'DEMO_TRIGGERED',
  emitEvents: ['DEMO_DONE'],
  retries: 2,
  errorHandling: 'retry',
};

function passingSource(opts?: {
  id?: string;
  name?: string;
  retries?: number;
  event?: string;
}): string {
  const id = opts?.id ?? FORM.slug;
  const name = opts?.name ?? FORM.displayName;
  const retries = opts?.retries ?? FORM.retries;
  const event = opts?.event ?? FORM.triggerEvent;
  return [
    "import { NonRetriableError } from 'inngest';",
    "import { inngest } from '@/server/inngest/client';",
    '',
    `const AGENT_ID = '${id}';`,
    `const AGENT_NAME = 'demoFoo';`,
    '',
    'export const demoFooAgent = inngest.createFunction(',
    `  { id: AGENT_ID, name: '${name}', retries: ${retries} },`,
    `  { event: '${event}' },`,
    '  async ({ event, step, logger }) => {',
    "    await step.run('one', async () => { logger.info('x'); return 1; });",
    "    await inngest.send({ name: 'DEMO_DONE', data: {} });",
    '  },',
    ');',
    '',
  ].join('\n');
}

describe('checkInngestRegistration — happy path', () => {
  it('clean source matching form: passed=true, no drift', () => {
    const r = checkInngestRegistration({ source: passingSource(), form: FORM });
    expect(r.loadedOk).toBe(true);
    expect(r.captured).not.toBeNull();
    expect(r.captured!.hasHandler).toBe(true);
    expect(r.captured!.id).toBe(FORM.slug);
    expect(r.captured!.name).toBe(FORM.displayName);
    expect(r.captured!.retries).toBe(FORM.retries);
    expect(r.captured!.triggerEvent).toBe(FORM.triggerEvent);
    expect(r.drift).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('formMatches reports all true when nothing drifts', () => {
    const r = checkInngestRegistration({ source: passingSource(), form: FORM });
    expect(r.formMatches).toEqual({
      idMatchesSlug: true,
      nameMatchesDisplay: true,
      retriesMatch: true,
      triggerEventMatches: true,
    });
  });
});

describe('checkInngestRegistration — drift detection', () => {
  it('reports drift on mismatched id', () => {
    const r = checkInngestRegistration({
      source: passingSource({ id: 'completely-different-agent' }),
      form: FORM,
    });
    expect(r.passed).toBe(false);
    const idDrift = r.drift.find((d) => d.field === 'id');
    expect(idDrift).toBeDefined();
    expect(idDrift!.expected).toBe(FORM.slug);
    expect(idDrift!.actual).toBe('completely-different-agent');
  });

  it('reports drift on mismatched name', () => {
    const r = checkInngestRegistration({
      source: passingSource({ name: 'Wrong Display' }),
      form: FORM,
    });
    expect(r.passed).toBe(false);
    expect(r.drift.find((d) => d.field === 'name')).toBeDefined();
  });

  it('reports drift on mismatched retries', () => {
    const r = checkInngestRegistration({
      source: passingSource({ retries: 5 }),
      form: FORM,
    });
    expect(r.passed).toBe(false);
    const retriesDrift = r.drift.find((d) => d.field === 'retries');
    expect(retriesDrift!.expected).toBe('2');
    expect(retriesDrift!.actual).toBe('5');
  });

  it('reports drift on mismatched trigger event (LLM typo)', () => {
    const r = checkInngestRegistration({
      source: passingSource({ event: 'DEMO_TIRGGERED' }), // typo
      form: FORM,
    });
    expect(r.passed).toBe(false);
    const evDrift = r.drift.find((d) => d.field === 'triggerEvent');
    expect(evDrift!.expected).toBe('DEMO_TRIGGERED');
    expect(evDrift!.actual).toBe('DEMO_TIRGGERED');
  });
});

describe('checkInngestRegistration — load failures', () => {
  it('captures load error when source has a top-level throw', () => {
    const src =
      "import { inngest } from '@/server/inngest/client';\n" +
      "throw new Error('boom at module top level');\n" +
      "export const a = inngest.createFunction({ id: 'a' }, { event: 'X' }, async () => {});\n";
    const r = checkInngestRegistration({ source: src, form: FORM });
    expect(r.loadedOk).toBe(false);
    expect(r.loadError).toContain('boom');
    expect(r.passed).toBe(false);
  });

  it('captures null when no createFunction in source', () => {
    const src = `export const _x = 1;`;
    const r = checkInngestRegistration({ source: src, form: FORM });
    expect(r.loadedOk).toBe(true);
    expect(r.captured).toBeNull();
    expect(r.passed).toBe(false);
  });
});

describe('checkInngestRegistration — static await lint', () => {
  it('flags step.run(...) not preceded by await', () => {
    const src = passingSource().replace(
      "await step.run('one', async () => { logger.info('x'); return 1; });",
      "step.run('one', async () => { logger.info('x'); return 1; });",
    );
    const r = checkInngestRegistration({ source: src, form: FORM });
    const w = r.warnings.find((s) => s.includes('step.run'));
    expect(w).toBeDefined();
    expect(w).toMatch(/not preceded by `await`/);
  });

  it('does NOT flag step.run preceded by `const x = await`', () => {
    const src = passingSource().replace(
      "await step.run('one', async () => { logger.info('x'); return 1; });",
      "const x = await step.run('one', async () => { logger.info('x'); return 1; });",
    );
    const r = checkInngestRegistration({ source: src, form: FORM });
    const w = r.warnings.find((s) => s.includes('step.run'));
    expect(w).toBeUndefined();
  });

  it('does NOT flag step.run with explicit `void` prefix', () => {
    const src = passingSource().replace(
      "await step.run('one', async () => { logger.info('x'); return 1; });",
      "void step.run('one', async () => { logger.info('x'); return 1; });",
    );
    const r = checkInngestRegistration({ source: src, form: FORM });
    const w = r.warnings.find((s) => s.includes('step.run'));
    expect(w).toBeUndefined();
  });

  it('flags multiple createFunction calls as a warning', () => {
    const src =
      passingSource() +
      "\nexport const second = inngest.createFunction({ id: 'second' }, { event: 'Y' }, async () => {});\n";
    const r = checkInngestRegistration({ source: src, form: FORM });
    const w = r.warnings.find((s) => s.includes('createFunction'));
    expect(w).toBeDefined();
  });
});
