import { describe, it, expect } from 'vitest';
import { renderAgent } from './render-agent';
import type { AgentSpec } from '../spec-types';

const SPEC: AgentSpec = {
  slug: 'demo-foo-agent',
  displayName: 'Demo Foo Agent',
  stage: 'system',
  ownerTeam: 'AO·UI',
  triggerEvent: 'DEMO_TRIGGERED',
  emitEvents: ['DEMO_DONE'],
  retries: 2,
  steps: [
    {
      id: 'fetch-thing',
      description: 'fetch the thing',
      callsLib: 'partner-pg.getRequirement',
      outputs: ['thing'],
    },
    {
      id: 'persist-thing',
      description: 'persist the thing',
    },
  ],
  errorHandling: 'retry',
};

describe('renderAgent (deterministic template)', () => {
  it('emits the suggested path under server/inngest/agents', () => {
    const r = renderAgent({ spec: SPEC });
    expect(r.suggestedPath).toBe('server/inngest/agents/demo-foo-agent.ts');
  });

  it('emits a banner with stage, trigger, emits', () => {
    const r = renderAgent({ spec: SPEC });
    expect(r.content).toContain('Stage: system');
    expect(r.content).toContain('Trigger: DEMO_TRIGGERED');
    expect(r.content).toContain('Emits:   DEMO_DONE');
  });

  it("derives camel-case export name from slug (strips '-agent', adds 'Agent')", () => {
    const r = renderAgent({ spec: SPEC });
    expect(r.content).toContain('export const demoFooAgent = inngest.createFunction');
  });

  it('imports inngest + agent logger always', () => {
    const r = renderAgent({ spec: SPEC });
    expect(r.content).toContain("from '@/server/inngest/client'");
    expect(r.content).toContain('createAgentLogger');
    expect(r.content).toContain('runWithLogger');
  });

  it("imports the lib hinted by step.callsLib (via tool registry)", () => {
    const r = renderAgent({ spec: SPEC });
    expect(r.content).toContain("import { getRequirementDetail } from '@/lib/partner-pg/requirements';");
  });

  it('renders step.run blocks with a TODO body when no StepBody provided', () => {
    const r = renderAgent({ spec: SPEC });
    expect(r.content).toContain("await step.run('fetch-thing'");
    expect(r.content).toContain('TODO: fetch the thing');
    expect(r.content).toContain('TODO: persist the thing');
  });

  it('uses output variable as `const X = ` LHS', () => {
    const r = renderAgent({ spec: SPEC });
    expect(r.content).toContain("const thing = await step.run('fetch-thing'");
  });

  it('substitutes a provided StepBody', () => {
    const r = renderAgent({
      spec: SPEC,
      stepBodies: [{ id: 'fetch-thing', body: 'return await getRequirementDetail(event.data.id);' }],
    });
    expect(r.content).toContain('return await getRequirementDetail(event.data.id);');
    expect(r.content).not.toContain('TODO: fetch the thing');
  });

  it('emits one inngest.send per declared emit event', () => {
    const r = renderAgent({ spec: SPEC });
    expect(r.content).toContain("await inngest.send({ name: 'DEMO_DONE'");
  });
});
