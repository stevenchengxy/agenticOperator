import { describe, it, expect } from 'vitest';
import { reviewCode } from './code-reviewer';
import type { AgentSpec } from '../spec-types';
import type { ToolRegistryEntry } from '../registries';

const MINIMAL_SPEC: AgentSpec = {
  slug: 'demo-foo-agent',
  displayName: 'Demo Foo',
  stage: 'system',
  ownerTeam: 'AO·UI',
  triggerEvent: 'DEMO_TRIGGERED',
  emitEvents: ['DEMO_DONE'],
  retries: 2,
  errorHandling: 'retry',
  steps: [
    { id: 'fetch-thing', description: 'fetch', callsLib: 'partner-pg.getRequirement' },
    { id: 'persist-thing', description: 'persist' },
  ],
};

const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    id: 'partner-pg.getRequirement',
    importFrom: '@/lib/partner-pg/requirements',
    importName: 'getRequirementDetail',
    signature: 'getRequirementDetail(id: string): Promise<X>',
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

function passingSource() {
  return [
    "import { NonRetriableError } from 'inngest';",
    "import { getRequirementDetail } from '@/lib/partner-pg/requirements';",
    "import { inngest } from '@/server/inngest/client';",
    "",
    "const AGENT_ID = 'demo-foo-agent';",
    "const AGENT_NAME = 'demoFoo';",
    "",
    "export const demoFooAgent = inngest.createFunction(",
    "  { id: AGENT_ID, retries: 2 },",
    "  { event: 'DEMO_TRIGGERED' },",
    "  async ({ event, step, logger }) => {",
    "    const thing = await step.run('fetch-thing', async () => {",
    "      const r = await getRequirementDetail(event.data.id);",
    "      if (!r) throw new NonRetriableError('missing');",
    "      logger.info('fetched');",
    "      return r;",
    "    });",
    "    await step.run('persist-thing', async () => {",
    "      logger.info('persisting');",
    "      return { ok: true };",
    "    });",
    "    await inngest.send({ name: 'DEMO_DONE', data: { thing } });",
    "  },",
    ");",
    "",
  ].join('\n');
}

describe('reviewCode', () => {
  it('clean code passes with zero errors', () => {
    const r = reviewCode({ source: passingSource(), spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    expect(r.passed).toBe(true);
    expect(r.errorCount).toBe(0);
  });

  it('flags missing AGENT_ID + AGENT_NAME as warnings (not errors)', () => {
    const src = passingSource()
      .replace("const AGENT_ID = 'demo-foo-agent';", '')
      .replace("const AGENT_NAME = 'demoFoo';", '');
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const ids = r.issues.map((i) => i.ruleId);
    expect(ids).toContain('agent-id-constant-present');
    expect(ids).toContain('agent-name-constant-present');
  });

  it('flags wrong trigger event as an error', () => {
    const src = passingSource().replace("event: 'DEMO_TRIGGERED'", "event: 'WRONG_EVENT'");
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const err = r.issues.find((i) => i.ruleId === 'trigger-event-wired');
    expect(err).toBeDefined();
    expect(err!.severity).toBe('error');
    expect(r.passed).toBe(false);
  });

  it('flags missing emit event as an error', () => {
    const src = passingSource().replace("'DEMO_DONE'", "'NOT_THE_EMIT_NAME'");
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const err = r.issues.find((i) => i.ruleId === 'emits-wired');
    expect(err).toBeDefined();
    expect(err!.severity).toBe('error');
  });

  it('flags import outside the tool registry as a warning', () => {
    const src = passingSource().replace(
      "import { getRequirementDetail } from '@/lib/partner-pg/requirements';",
      "import { somethingElse } from '@/lib/not-registered-anywhere';",
    );
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const issue = r.issues.find((i) => i.ruleId === 'imports-are-allowed');
    expect(issue).toBeDefined();
    expect(issue!.message).toMatch(/not in the tool registry/);
  });

  it('flags an unwrapped external HTTP call as a warning', () => {
    const src = passingSource().replace(
      "await step.run('persist-thing', async () => {",
      "await step.run('persist-thing', async () => {\n      const jd = await generateJdDirect({ prompt: 'x' });",
    ) + "\nimport { generateJdDirect } from '@/lib/robohire-client';\n";
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const issue = r.issues.find((i) => i.ruleId === 'external-calls-try-catch');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
  });

  it('flags step.run callback without logger as an info', () => {
    const src = passingSource().replace(
      "logger.info('persisting');\n      return { ok: true };",
      "return { ok: true };",
    );
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const issue = r.issues.find((i) => i.ruleId === 'steps-have-logger' && i.message.includes('persist-thing'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('info');
  });

  // ── Bundle J: allmeta canonical fields ───────────────────────────

  it('flags a writeCandidateInstance call using a non-canonical field (e.g. full_name)', () => {
    const src =
      "import { writeCandidateInstance } from '@/lib/allmeta-writers';\n" +
      "import { inngest } from '@/server/inngest/client';\n" +
      "export const a = inngest.createFunction({ id: 'a' }, { event: 'X' }, async () => {\n" +
      "  await writeCandidateInstance({\n" +
      "    candidate_id: 'cand_1',\n" +
      "    full_name: 'Wrong Field Name',\n" +     // ← not canonical (canonical is 'name')
      "    email: 'ok@x.com',\n" +
      "  });\n" +
      "});\n";
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const issue = r.issues.find(
      (i) => i.ruleId === 'allmeta-canonical-fields-only' && i.message.includes('full_name'),
    );
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
  });

  it('does NOT flag the parsed wrapper key (writer normalizes internally)', () => {
    const src =
      "import { writeCandidateInstance } from '@/lib/allmeta-writers';\n" +
      "import { inngest } from '@/server/inngest/client';\n" +
      "export const a = inngest.createFunction({ id: 'a' }, { event: 'X' }, async () => {\n" +
      "  await writeCandidateInstance({\n" +
      "    candidate_id: 'cand_1',\n" +
      "    parsed: { name: 'X', phone: 'Y' },\n" +
      "  });\n" +
      "});\n";
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const issue = r.issues.find((i) => i.ruleId === 'allmeta-canonical-fields-only');
    expect(issue).toBeUndefined();
  });

  it('does NOT flag canonical fields (candidate_id, name, email)', () => {
    const src =
      "import { writeCandidateInstance } from '@/lib/allmeta-writers';\n" +
      "import { inngest } from '@/server/inngest/client';\n" +
      "export const a = inngest.createFunction({ id: 'a' }, { event: 'X' }, async () => {\n" +
      "  await writeCandidateInstance({\n" +
      "    candidate_id: 'cand_1',\n" +
      "    name: 'A',\n" +
      "    email: 'a@b.com',\n" +
      "    phone: '12345',\n" +
      "  });\n" +
      "});\n";
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const issue = r.issues.find((i) => i.ruleId === 'allmeta-canonical-fields-only');
    expect(issue).toBeUndefined();
  });

  it('flags long step callback without return / throw', () => {
    const src = passingSource().replace(
      "await step.run('persist-thing', async () => {\n      logger.info('persisting');\n      return { ok: true };\n    });",
      "await step.run('persist-thing', async () => {\n      logger.info('one log line so the body is long enough to count');\n      logger.info('another so we definitely exceed thirty chars');\n    });",
    );
    const r = reviewCode({ source: src, spec: MINIMAL_SPEC, toolRegistry: TOOL_REGISTRY });
    const issue = r.issues.find((i) => i.ruleId === 'step-runs-have-return');
    expect(issue).toBeDefined();
  });
});
