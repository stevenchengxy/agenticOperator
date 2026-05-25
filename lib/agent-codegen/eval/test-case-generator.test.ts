import { describe, it, expect } from 'vitest';
import { generateTestCases } from './test-case-generator';
import type { AgentSpec } from '../spec-types';
import type { ToolRegistryEntry } from '../registries';

const SPEC: AgentSpec = {
  slug: 'demo-jd-agent',
  displayName: 'Demo',
  stage: 'jd',
  ownerTeam: 'HSM·交付',
  triggerEvent: 'REQUIREMENT_LOGGED',
  emitEvents: ['JD_GENERATED'],
  retries: 2,
  errorHandling: 'retry',
  steps: [
    { id: 'fetch', description: 'fetch', callsLib: 'partner-pg.getRequirement', inputs: ['job_requisition_id'] },
    { id: 'generate', description: 'gen', callsLib: 'robohire.generateJd' },
  ],
};

const REG: ToolRegistryEntry[] = [
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

describe('generateTestCases', () => {
  it('returns one happy-path, one missing-field, one 4xx, one idempotency', () => {
    const cases = generateTestCases(SPEC, REG);
    const cats = cases.map((c) => c.category);
    expect(cats).toContain('happy-path');
    expect(cats).toContain('missing-trigger-field');
    expect(cats).toContain('downstream-4xx');
    expect(cats).toContain('idempotency');
  });

  it('happy path event has populated data fields', () => {
    const happy = generateTestCases(SPEC, REG).find((c) => c.category === 'happy-path')!;
    expect(happy.inputEvent.name).toBe('REQUIREMENT_LOGGED');
    expect((happy.inputEvent.data as Record<string, unknown>).job_requisition_id).toBeDefined();
  });

  it('happy path has a return mock for every step that calls a registered tool', () => {
    const happy = generateTestCases(SPEC, REG).find((c) => c.category === 'happy-path')!;
    expect(happy.mockSetup.length).toBe(2);
    const tools = happy.mockSetup.map((m) => m.toolId);
    expect(tools).toContain('partner-pg.getRequirement');
    expect(tools).toContain('robohire.generateJd');
  });

  it('downstream-4xx case makes the FIRST external HTTP tool throw 4xx', () => {
    const c = generateTestCases(SPEC, REG).find((c) => c.category === 'downstream-4xx')!;
    const failing = c.mockSetup.find((m) => m.returns === '__throw4xx__');
    expect(failing).toBeDefined();
    expect(failing!.toolId).toBe('robohire.generateJd');
    expect(c.expectedOutcome.handlerResolves).toBe('non-retriable-error');
  });

  it('missing-trigger-field case sends empty data and expects non-retriable', () => {
    const c = generateTestCases(SPEC, REG).find((c) => c.category === 'missing-trigger-field')!;
    expect(c.inputEvent.data).toEqual({});
    expect(c.expectedOutcome.handlerResolves).toBe('non-retriable-error');
  });
});
