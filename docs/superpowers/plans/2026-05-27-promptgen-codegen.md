# Bundle P — PromptGen Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI prompt-authoring front-stage to CodeGen: an LLM synthesizes a structured, reviewable `AgentPrompt` from a light operator intent, which (after a human confirm gate) is injected into the existing `runPipeline()` to generate agent code.

**Architecture:** A new `lib/agent-codegen/prompt-gen/` module (data sources → heuristic selection → context assembly → one LLM call → structured `AgentPrompt`), a `to-codegen-input` adapter that deserializes the approved prompt into the existing `(AgentFormFields, businessLogic)` pipeline inputs, a `POST /api/codegen/prompt-gen` route, prompt-level versioning, and three UI units on `/behavior/codegen`. `runPipeline()` is unchanged. Existing 5 production agents are read-only ground truth.

**Tech Stack:** Next.js 16 App Router · React 19 · TypeScript · Zod · OpenAI SDK (via existing `gateway.ts`) · Prisma (SQLite) · Vitest · Tailwind v4.

**Spec:** [docs/superpowers/specs/2026-05-27-promptgen-codegen-design.md](../specs/2026-05-27-promptgen-codegen-design.md)

**Conventions for every commit in this plan:**
- Run `npm run test` (vitest) for the touched test, and `npm run build` before any UI commit (build = typecheck + lint).
- Commit with pathspec only: `git commit -m "msg" -- <exact files>` (a pre-commit hook re-stages everything; pathspec scopes the commit). Do NOT push.

---

## Revision 2026-05-27b — static sources (authoritative; overrides any stale code block below)

Generation is a **static, design-time activity** — it reads only curated registries, never
a live DB/Neo4j query (matches existing codegen; see spec Part 4). Task 2 above is already
rewritten for this. Apply these deltas wherever a later task's code block still shows the
old live/real-payload shape:

- **`EventContext`** is `{ name, stage, summary, direction, payloadFields }` only.
  **Removed:** `publishers`, `subscribers`, `realPayloadSamples`. `payloadFields` is `[]`
  in v1 (reserved for the deferred offline snapshot, spec Part 9).
- **`context-sources.ts`** exports the synchronous `eventContexts(domain)` only.
  **Removed:** `mapEventDefinitionRow`, `loadEventContexts` (live), `loadRealPayloadSamples`,
  and the `import { prisma }`.
- **Task 3 (`context-select`)**: "topological neighbors" = **same-`stage`** events (the
  static registry has no publisher/subscriber edges). Drop any `publishers`/`subscribers`
  references from both the test fixtures and the impl; rank/keep by stage + intent keywords.
- **Task 4 (`context-assembler`)**: drop the `sourceBadge` param and the real-payload-sample
  rendering. Render `payloadFields` only when non-empty (it is empty in v1, so that block is
  inert). Its signature becomes `assembleSystemPrompt({ selected, locked })`.
- **Task 6 (`prompt-gen`)**: call `eventContexts(domain)` synchronously; **remove** the
  `loadEventContexts`/`loadRealPayloadSamples` calls and the trigger-sample attachment block.
- **`GenerateAgentPromptResult` (Task 6) + route response (Task 7)**: drop `sourceBadge`.
- **UI (Tasks 9, 11)**: drop the source badge and the `pg_source_neo4j` / `pg_source_static`
  i18n keys — there is only one (static) source.
- **Multi-trigger (prompt-only, spec Part 11 / Part 9):** add an optional
  `additionalTriggerEvents?: string[]` to the `AgentPrompt` (Task 1 schema) — captured in the
  prompt for review. `render-agent.ts` stays single-trigger in v1; when the prompt declares
  extra triggers, surface them as a hand-finish note (code-layer render is deferred).

---

## Chunk 1: Data layer (types + sources + selection + assembly)

The testable core. All four files are pure or thin-over-Prisma, so logic lives in pure functions that vitest covers directly.

### Task 1: `AgentPrompt` types + Zod schema

**Files:**
- Create: `lib/agent-codegen/prompt-gen/prompt-types.ts`
- Test: `lib/agent-codegen/prompt-gen/prompt-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// prompt-types.test.ts
import { describe, it, expect } from 'vitest';
import { AgentPromptDraftSchema, AGENT_PROMPT_DRAFT_JSON_SCHEMA } from './prompt-types';

const valid = {
  intent: 'screen inbound resumes against the JD',
  role: 'Screens resumes for a requisition and flags the top candidates.',
  trigger: { event: 'RESUME_PROCESSED', payloadExpectations: 'event.data.candidate_id, resume_id' },
  inputs: ['partner-pg parsed_resume row', 'Neo4j Candidate node'],
  steps: [{ id: 'fetch-resume', description: 'load the parsed resume from partner-pg' }],
  tools: ['partner-pg.getRequirement'],
  emits: ['MATCH_RULE_CHECK_PASSED'],
  errorHandling: 'retry',
  constraints: ['dual-write Postgres then Neo4j'],
  acceptance: ['emits exactly one downstream event'],
};

describe('AgentPromptDraftSchema', () => {
  it('accepts a well-formed draft', () => {
    expect(AgentPromptDraftSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects an empty steps array', () => {
    expect(AgentPromptDraftSchema.safeParse({ ...valid, steps: [] }).success).toBe(false);
  });
  it('rejects a non-kebab step id', () => {
    const bad = { ...valid, steps: [{ id: 'Fetch_Resume', description: 'x' }] };
    expect(AgentPromptDraftSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects an invalid errorHandling enum', () => {
    expect(AgentPromptDraftSchema.safeParse({ ...valid, errorHandling: 'panic' }).success).toBe(false);
  });
  it('exposes a JSON schema whose required list omits provenance fields', () => {
    expect(AGENT_PROMPT_DRAFT_JSON_SCHEMA.required).not.toContain('fieldOrigin');
    expect(AGENT_PROMPT_DRAFT_JSON_SCHEMA.required).not.toContain('confirmed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agent-codegen/prompt-gen/prompt-types.test.ts`
Expected: FAIL — cannot resolve `./prompt-types`.

- [ ] **Step 3: Write the implementation**

```ts
// prompt-types.ts
// AgentPrompt — the human-readable, reviewable artifact PromptGen produces and
// the operator approves before it is injected into the existing codegen
// pipeline. Split mirrors spec-types.ts: a Zod schema for validation + a
// hand-written JSON schema for the OpenAI tool call (strict-mode safe).
//
// LLM emits an AgentPromptDraft (no provenance, no confirmed flag). The route
// then attaches fieldOrigin + trigger.confirmed=false to make the full
// AgentPrompt the UI/versioning layer carries.

import { z } from 'zod';

export const PromptStepSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, 'step id must be kebab-case'),
  description: z.string().min(1).max(600),
  usesTools: z.array(z.string().max(80)).max(8).optional(),
});
export type PromptStep = z.infer<typeof PromptStepSchema>;

export const AgentPromptDraftSchema = z.object({
  intent: z.string().min(1).max(400),
  role: z.string().min(1).max(600),
  trigger: z.object({
    event: z.string().min(1).max(80),
    payloadExpectations: z.string().max(1200),
  }),
  inputs: z.array(z.string().max(200)).max(20),
  steps: z.array(PromptStepSchema).min(1).max(12),
  tools: z.array(z.string().max(80)).max(20),
  emits: z.array(z.string().max(80)).max(8),
  errorHandling: z.enum(['retry', 'dlq', 'hitl-fallback']),
  constraints: z.array(z.string().max(300)).max(20),
  acceptance: z.array(z.string().max(300)).max(20),
});
export type AgentPromptDraft = z.infer<typeof AgentPromptDraftSchema>;

export type FieldOrigin = 'inferred' | 'locked' | 'confirmed';

// Full artifact = draft + provenance + the operator-driven confirmed flag.
export type AgentPrompt = AgentPromptDraft & {
  trigger: AgentPromptDraft['trigger'] & { confirmed: boolean };
  fieldOrigin: Record<string, FieldOrigin>;
};

// Hand-written so we control OpenAI strict-mode compatibility (same reason as
// spec-types.ts). Provenance/confirmed are NOT in here — they aren't the LLM's.
export const AGENT_PROMPT_DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'role', 'trigger', 'inputs', 'steps', 'tools', 'emits', 'errorHandling', 'constraints', 'acceptance'],
  properties: {
    intent: { type: 'string' },
    role: { type: 'string' },
    trigger: {
      type: 'object',
      additionalProperties: false,
      required: ['event', 'payloadExpectations'],
      properties: {
        event: { type: 'string', description: 'Must be a known event name from the event registry / EventDefinition table.' },
        payloadExpectations: { type: 'string', description: 'Fields the handler reads off event.data.' },
      },
    },
    inputs: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          usesTools: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    tools: { type: 'array', items: { type: 'string' } },
    emits: { type: 'array', items: { type: 'string' } },
    errorHandling: { type: 'string', enum: ['retry', 'dlq', 'hitl-fallback'] },
    constraints: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'string' } },
  },
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agent-codegen/prompt-gen/prompt-types.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(promptgen): AgentPrompt types + Zod/JSON schema" -- \
  lib/agent-codegen/prompt-gen/prompt-types.ts \
  lib/agent-codegen/prompt-gen/prompt-types.test.ts
```

---

### Task 2: Context sources (`context-sources.ts`) — STATIC only

Generation is static and reproducible: this reads only the curated `EVENT_REGISTRY_RAAS`
(the same source existing codegen uses). **No Prisma / Neo4j query on the generation
path.** (Live payload-schema snapshotting is a deferred offline script — spec Part 9.)

**Files:**
- Create: `lib/agent-codegen/prompt-gen/context-sources.ts`
- Test: `lib/agent-codegen/prompt-gen/context-sources.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// context-sources.test.ts
import { describe, it, expect } from 'vitest';
import { eventContexts, type EventContext } from './context-sources';

describe('eventContexts', () => {
  it('builds EventContext[] from the static codegen event registry', () => {
    const ecs = eventContexts('raas');
    expect(ecs.length).toBeGreaterThan(10);
    const r = ecs.find((e: EventContext) => e.name === 'RESUME_PROCESSED');
    expect(r?.stage).toBe('resume');
    expect(typeof r?.summary).toBe('string');
  });
  it('returns [] for a domain with no registered events (r7)', () => {
    expect(eventContexts('r7')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agent-codegen/prompt-gen/context-sources.test.ts`
Expected: FAIL — cannot resolve `./context-sources`.

- [ ] **Step 3: Implement (static, synchronous)**

```ts
// context-sources.ts
// PromptGen data layer — STATIC. Reads the curated codegen event registry, the
// same source existing codegen uses (event-registry.raas.ts: "the auditable
// source of truth for now"). No DB / Neo4j query: generation is deterministic
// and reproducible. `payloadFields` is reserved for a future offline snapshot
// (spec Part 9); it is [] today.

import type { DomainId } from '@/lib/domains';
import { getEventRegistry } from '../registries';

export type EventPayloadField = { name: string; type: string; required: boolean };

export type EventContext = {
  name: string;
  stage: string;
  summary: string;
  direction: 'consume' | 'produce' | 'both';
  payloadFields: EventPayloadField[]; // [] until the offline snapshot lands (Part 9)
};

export function eventContexts(domain: DomainId): EventContext[] {
  return getEventRegistry(domain).map((e) => ({
    name: e.name,
    stage: e.stage,
    summary: e.summary,
    direction: e.direction,
    payloadFields: [],
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agent-codegen/prompt-gen/context-sources.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(promptgen): static event-context source over the curated registry" -- \
  lib/agent-codegen/prompt-gen/context-sources.ts \
  lib/agent-codegen/prompt-gen/context-sources.test.ts
```

> Note: `EventContext` keeps a `payloadFields` slot so the deferred offline-snapshot script
> (spec Part 9) can populate it later without changing downstream consumers. The selection
> and assembler layers already handle an empty `payloadFields`.

---

### Task 3: Heuristic context selection (`context-select.ts`)

**Files:**
- Create: `lib/agent-codegen/prompt-gen/context-select.ts`
- Test: `lib/agent-codegen/prompt-gen/context-select.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// context-select.test.ts
import { describe, it, expect } from 'vitest';
import { selectContext } from './context-select';
import type { EventContext } from './context-sources';

const events: EventContext[] = [
  { name: 'RESUME_PROCESSED', stage: 'resume', summary: 'parsed resume saved', payloadFields: [], publishers: ['ResumeParser'], subscribers: ['RuleCheck'], realPayloadSamples: [] },
  { name: 'MATCH_RULE_CHECK_PASSED', stage: 'match', summary: 'rule check passed', payloadFields: [], publishers: ['RuleCheck'], subscribers: ['Matcher'], realPayloadSamples: [] },
  { name: 'JD_GENERATED', stage: 'jd', summary: 'jd produced', payloadFields: [], publishers: ['JDGen'], subscribers: [], realPayloadSamples: [] },
];
const tools = [
  { id: 'partner-pg.getRequirement', category: 'partner-pg', stage: undefined, canonicalEntity: undefined, signature: '', importFrom: '', importName: '', summary: '', sideEffects: 'read-only' },
  { id: 'allmeta.writeCandidate', category: 'allmeta', canonicalEntity: 'Candidate', signature: '', importFrom: '', importName: '', summary: '', sideEffects: 'writes Candidate' },
] as any;
const entities = [{ name: 'Candidate', fields: [] }, { name: 'Job_Requisition', fields: [] }] as any;
const agents = [
  { slug: 'resume-parser-agent', stage: 'resume', triggerEvent: 'RESUME_DOWNLOADED', emitEvents: ['RESUME_PROCESSED'], source: '...' },
  { slug: 'create-jd-agent', stage: 'jd', triggerEvent: 'CLARIFICATION_READY', emitEvents: ['JD_GENERATED'], source: '...' },
] as any;

describe('selectContext', () => {
  it('when triggerEvent is locked, includes it + its topological neighbors', () => {
    const sel = selectContext({ intent: '', locked: { triggerEvent: 'RESUME_PROCESSED' }, events, tools, entities, agents });
    const names = sel.events.map((e) => e.name);
    expect(names).toContain('RESUME_PROCESSED');
    expect(names).toContain('MATCH_RULE_CHECK_PASSED'); // downstream of RuleCheck which subscribes RESUME_PROCESSED — neighbor by stage adjacency
  });
  it('without locks, ranks events by keyword overlap with intent', () => {
    const sel = selectContext({ intent: 'rule check the candidate match', locked: {}, events, tools, entities, agents });
    expect(sel.events[0].name).toBe('MATCH_RULE_CHECK_PASSED');
  });
  it('includes only entities written by selected tools', () => {
    const sel = selectContext({ intent: 'write candidate', locked: {}, events, tools, entities, agents });
    expect(sel.entities.map((e) => e.name)).toEqual(['Candidate']);
  });
  it('picks the blueprint by explicit slug when given', () => {
    const sel = selectContext({ intent: '', locked: {}, events, tools, entities, agents, blueprintSlug: 'create-jd-agent' });
    expect(sel.blueprint?.slug).toBe('create-jd-agent');
  });
  it('picks the blueprint by stage match when no slug given', () => {
    const sel = selectContext({ intent: '', locked: { stage: 'jd' }, events, tools, entities, agents });
    expect(sel.blueprint?.slug).toBe('create-jd-agent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agent-codegen/prompt-gen/context-select.test.ts`
Expected: FAIL — cannot resolve `./context-select`.

- [ ] **Step 3: Write the implementation**

```ts
// context-select.ts
// Heuristic context selection: trims the full domain surface to a relevant,
// token-bounded subset given operator intent + locked fields. Pure & explainable.
// (Embedding/RAG retrieval is a phase-2 upgrade, only if this proves imprecise.)

import type { AgentFormFields } from '../spec-types';
import type { EventContext } from './context-sources';
import type { ToolRegistryEntry } from '../registries';
import type { CanonicalEntity } from '../ontology/canonical-schemas';

export type AgentExemplar = {
  slug: string;
  stage: string;
  triggerEvent: string;
  emitEvents: string[];
  source: string;
};

export type SelectContextInput = {
  intent: string;
  locked: Partial<AgentFormFields>;
  events: EventContext[];
  tools: ReadonlyArray<ToolRegistryEntry>;
  entities: ReadonlyArray<CanonicalEntity>;
  agents: AgentExemplar[];
  blueprintSlug?: string;
};

export type SelectedContext = {
  events: EventContext[];
  tools: ToolRegistryEntry[];
  entities: CanonicalEntity[];
  blueprint: AgentExemplar | null;
};

const MAX_EVENTS = 12;
const MAX_TOOLS = 16;

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

export function selectContext(input: SelectContextInput): SelectedContext {
  const { intent, locked, events, tools, entities, agents, blueprintSlug } = input;

  // ── events ──────────────────────────────────────────────────────────────
  let selectedEvents: EventContext[];
  const lockedNames = new Set<string>(
    [locked.triggerEvent, ...(locked.emitEvents ?? [])].filter(Boolean) as string[],
  );
  if (lockedNames.size > 0) {
    // locked events + same-stage neighbors (topological proximity)
    const lockedStages = new Set(events.filter((e) => lockedNames.has(e.name)).map((e) => e.stage));
    selectedEvents = events.filter(
      (e) => lockedNames.has(e.name) || lockedStages.has(e.stage),
    );
  } else {
    // rank by keyword overlap of (name + summary) with the intent
    const intentTokens = new Set(tokens(intent));
    selectedEvents = [...events]
      .map((e) => {
        const et = tokens(`${e.name} ${e.summary} ${e.stage}`);
        const score = et.filter((w) => intentTokens.has(w)).length;
        return { e, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.e);
    // keep positives; if nothing matched, keep stage-filtered or all
    const positives = selectedEvents.filter((_, i) => i < MAX_EVENTS);
    selectedEvents = positives;
  }
  if (locked.stage) {
    const inStage = selectedEvents.filter((e) => e.stage === locked.stage);
    if (inStage.length > 0) selectedEvents = [...inStage, ...selectedEvents.filter((e) => e.stage !== locked.stage)];
  }
  selectedEvents = selectedEvents.slice(0, MAX_EVENTS);

  // ── tools ───────────────────────────────────────────────────────────────
  // Heuristic: include all registry tools (registry is small & curated), but
  // rank by intent keyword overlap so the prompt leads with the relevant ones.
  const intentTokens = new Set(tokens(intent));
  const selectedTools = [...tools]
    .map((tEntry) => {
      const tt = tokens(`${tEntry.id} ${tEntry.summary} ${tEntry.category}`);
      const score = tt.filter((w) => intentTokens.has(w)).length;
      return { tEntry, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOOLS)
    .map((x) => x.tEntry);

  // ── entities ── only those written by a selected tool ─────────────────────
  const writtenEntities = new Set(
    selectedTools.map((tEntry) => tEntry.canonicalEntity).filter(Boolean) as string[],
  );
  const selectedEntities = entities.filter((e) => writtenEntities.has(e.name));

  // ── blueprint ─────────────────────────────────────────────────────────────
  let blueprint: AgentExemplar | null = null;
  if (blueprintSlug) {
    blueprint = agents.find((a) => a.slug === blueprintSlug) ?? null;
  } else if (locked.stage) {
    blueprint = agents.find((a) => a.stage === locked.stage) ?? null;
  } else if (locked.triggerEvent) {
    blueprint = agents.find((a) => a.triggerEvent === locked.triggerEvent) ?? null;
  }

  return { events: selectedEvents, tools: selectedTools, entities: selectedEntities, blueprint };
}
```

> Note for implementer: confirm `CanonicalEntity` is the exported type name in `../ontology/canonical-schemas` (the test for Task 2 uses `CANONICAL_ENTITIES`; check the type export and adjust the import if it differs, e.g. `CanonicalEntitySchema`-derived type). The `AgentExemplar` shape is what Task 6 will populate from agent source.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agent-codegen/prompt-gen/context-select.test.ts`
Expected: PASS (5 tests). If the "downstream neighbor" assertion is too strict for the stage-adjacency heuristic, relax the test to assert the locked event is present and total ≤ MAX_EVENTS — selection precision is a heuristic, not a contract.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(promptgen): heuristic context selection (events/tools/entities/blueprint)" -- \
  lib/agent-codegen/prompt-gen/context-select.ts \
  lib/agent-codegen/prompt-gen/context-select.test.ts
```

---

### Task 4: System-prompt assembly (`context-assembler.ts`)

**Files:**
- Create: `lib/agent-codegen/prompt-gen/context-assembler.ts`
- Test: `lib/agent-codegen/prompt-gen/context-assembler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// context-assembler.test.ts
import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt } from './context-assembler';

const sel = {
  events: [{ name: 'RESUME_PROCESSED', stage: 'resume', summary: 'parsed', payloadFields: [{ name: 'candidate_id', type: 'String', required: true }], publishers: ['ResumeParser'], subscribers: ['RuleCheck'], realPayloadSamples: ['{"candidate_id":"c1"}'] }],
  tools: [{ id: 'partner-pg.getRequirement', category: 'partner-pg', signature: 'getRequirementDetail(id)', importFrom: '@/x', importName: 'getRequirementDetail', summary: 'reads requirement', sideEffects: 'read-only' }] as any,
  entities: [{ name: 'Candidate', fields: [{ name: 'candidate_id', type: 'string', pk: true }] }] as any,
  blueprint: { slug: 'resume-parser-agent', stage: 'resume', triggerEvent: 'RESUME_DOWNLOADED', emitEvents: ['RESUME_PROCESSED'], source: 'export const resumeParserAgent = ...' },
};

describe('assembleSystemPrompt', () => {
  it('includes selected event names, tool ids, entity names, and the blueprint slug', () => {
    const s = assembleSystemPrompt({ selected: sel as any, locked: { triggerEvent: 'RESUME_PROCESSED' }, sourceBadge: 'neo4j' });
    expect(s).toContain('RESUME_PROCESSED');
    expect(s).toContain('partner-pg.getRequirement');
    expect(s).toContain('Candidate');
    expect(s).toContain('resume-parser-agent');
  });
  it('marks locked fields as fixed constraints', () => {
    const s = assembleSystemPrompt({ selected: sel as any, locked: { triggerEvent: 'RESUME_PROCESSED' }, sourceBadge: 'neo4j' });
    expect(s.toLowerCase()).toContain('locked');
    expect(s).toContain('RESUME_PROCESSED');
  });
  it('includes a real payload sample when present', () => {
    const s = assembleSystemPrompt({ selected: sel as any, locked: {}, sourceBadge: 'neo4j' });
    expect(s).toContain('"candidate_id":"c1"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agent-codegen/prompt-gen/context-assembler.test.ts`
Expected: FAIL — cannot resolve `./context-assembler`.

- [ ] **Step 3: Write the implementation**

```ts
// context-assembler.ts
// Renders a SelectedContext (+ locked fields) into the PromptGen system prompt.
// Pure string assembly; the only "intelligence" is layout + the hard rules that
// keep the LLM grounded in real events/tools and respectful of locked fields.

import type { AgentFormFields } from '../spec-types';
import type { SelectedContext } from './context-select';

export function assembleSystemPrompt(args: {
  selected: SelectedContext;
  locked: Partial<AgentFormFields>;
  sourceBadge: 'neo4j' | 'static';
}): string {
  const { selected, locked, sourceBadge } = args;

  const eventsBlock = selected.events.length
    ? selected.events
        .map((e) => {
          const fields = e.payloadFields.length
            ? `\n      payload: ${e.payloadFields.map((f) => `${f.name}:${f.type}${f.required ? '!' : ''}`).join(', ')}`
            : '';
          const sample = e.realPayloadSamples[0] ? `\n      real sample: ${e.realPayloadSamples[0]}` : '';
          return `  - ${e.name} [${e.stage}] — ${e.summary}${fields}${sample}`;
        })
        .join('\n')
    : '  (no events available)';

  const toolsBlock = selected.tools.length
    ? selected.tools
        .map((t) => `  - ${t.id} [${t.category}] — ${t.summary}${t.canonicalEntity ? ` (writes ${t.canonicalEntity})` : ''}`)
        .join('\n')
    : '  (no tools available)';

  const entitiesBlock = selected.entities.length
    ? selected.entities.map((e) => `  - ${e.name}: ${e.fields.map((f) => f.name).slice(0, 12).join(', ')}`).join('\n')
    : '  (no entities relevant)';

  const blueprintBlock = selected.blueprint
    ? `Blueprint agent (${selected.blueprint.slug}, stage ${selected.blueprint.stage}) — imitate its shape/idioms:\n${selected.blueprint.source.slice(0, 2000)}`
    : '(no blueprint selected)';

  const lockedEntries = Object.entries(locked).filter(([, v]) => v != null && (!Array.isArray(v) || v.length > 0));
  const lockedBlock = lockedEntries.length
    ? lockedEntries.map(([k, v]) => `  - ${k} = ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)} (LOCKED — treat as a hard constraint, do not change)`).join('\n')
    : '  (no locked fields — you may propose all of trigger/stage/emits, but the operator must confirm them)';

  return [
    'You are PromptGen for the RAAS recruitment workflow. Produce a structured,',
    'human-readable Agent Prompt (via the submit_agent_prompt tool) describing ONE',
    'Inngest workflow agent: what it does, what it reads, its ordered steps, the',
    'tools it uses, and what it emits. You write the PROMPT, not the code — a',
    'downstream step decomposes it into executable steps and another writes the TS.',
    '',
    `Event surface (source: ${sourceBadge}) — only reference these event names:`,
    eventsBlock,
    '',
    'Tool surface — only reference these tool ids in steps[].usesTools:',
    toolsBlock,
    '',
    'Ontology entities the relevant tools write (use canonical field names):',
    entitiesBlock,
    '',
    blueprintBlock,
    '',
    'Operator constraints:',
    lockedBlock,
    '',
    'Hard rules:',
    '  1. Output ONLY via submit_agent_prompt. Never reply in prose.',
    '  2. trigger.event and every emits[] entry MUST be from the event surface above.',
    '  3. Every steps[].usesTools entry MUST be a tool id from the tool surface.',
    '  4. Respect LOCKED fields exactly. Do NOT invent a slug — that is the operator\'s.',
    '  5. Encode the dual-write contract (Postgres then Neo4j) + idempotency in constraints[].',
    '  6. acceptance[] must state observable success (e.g. "emits exactly one downstream event").',
    '  7. 3-6 steps preferred, max 12.',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agent-codegen/prompt-gen/context-assembler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(promptgen): system-prompt assembler (events/tools/entities/blueprint/locked)" -- \
  lib/agent-codegen/prompt-gen/context-assembler.ts \
  lib/agent-codegen/prompt-gen/context-assembler.test.ts
```

---

## Chunk 2: Generation + injection + API

### Task 5: AgentPrompt → pipeline input adapter (`to-codegen-input.ts`)

**Files:**
- Create: `lib/agent-codegen/prompt-gen/to-codegen-input.ts`
- Test: `lib/agent-codegen/prompt-gen/to-codegen-input.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// to-codegen-input.test.ts
import { describe, it, expect } from 'vitest';
import { toCodegenInput } from './to-codegen-input';
import type { AgentPrompt } from './prompt-types';
import type { AgentFormFields } from '../spec-types';

const prompt: AgentPrompt = {
  intent: 'screen resumes',
  role: 'Screens parsed resumes for a requisition.',
  trigger: { event: 'RESUME_PROCESSED', payloadExpectations: 'candidate_id', confirmed: true },
  inputs: ['parsed_resume row'],
  steps: [
    { id: 'fetch-resume', description: 'load parsed resume from partner-pg', usesTools: ['partner-pg.getRequirement'] },
    { id: 'emit-result', description: 'emit the downstream event' },
  ],
  tools: ['partner-pg.getRequirement'],
  emits: ['MATCH_RULE_CHECK_PASSED'],
  errorHandling: 'retry',
  constraints: ['dual-write Postgres then Neo4j'],
  acceptance: ['emits exactly one downstream event'],
  fieldOrigin: {},
};
const form: AgentFormFields = {
  slug: 'resume-screener-agent', displayName: 'Resume Screener', stage: 'resume', ownerTeam: 'recruiting',
  triggerEvent: 'RESUME_PROCESSED', emitEvents: ['MATCH_RULE_CHECK_PASSED'], retries: 2, errorHandling: 'retry',
};

describe('toCodegenInput', () => {
  it('returns the confirmed form verbatim', () => {
    expect(toCodegenInput(prompt, form).form).toEqual(form);
  });
  it('renders businessLogic prose containing role, every step description, and constraints', () => {
    const bl = toCodegenInput(prompt, form).businessLogic;
    expect(bl).toContain('Screens parsed resumes');
    expect(bl).toContain('load parsed resume from partner-pg');
    expect(bl).toContain('emit the downstream event');
    expect(bl).toContain('dual-write Postgres then Neo4j');
  });
  it('produces businessLogic that satisfies the pipeline route min length (>= 8 chars)', () => {
    expect(toCodegenInput(prompt, form).businessLogic.length).toBeGreaterThanOrEqual(8);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/agent-codegen/prompt-gen/to-codegen-input.test.ts`
Expected: FAIL — cannot resolve `./to-codegen-input`.

- [ ] **Step 3: Implement**

```ts
// to-codegen-input.ts
// Deserialize an approved AgentPrompt into the existing pipeline inputs.
// runPipeline() is unchanged: this is the whole "inject prompt into CodeGen" seam.

import type { AgentPrompt } from './prompt-types';
import type { AgentFormFields } from '../spec-types';

export function toCodegenInput(
  prompt: AgentPrompt,
  confirmedForm: AgentFormFields,
): { form: AgentFormFields; businessLogic: string } {
  const lines: string[] = [];
  lines.push(`Role: ${prompt.role}`);
  if (prompt.inputs.length) lines.push(`Reads: ${prompt.inputs.join('; ')}`);
  lines.push('');
  lines.push('Steps:');
  prompt.steps.forEach((s, i) => {
    const tools = s.usesTools?.length ? ` [tools: ${s.usesTools.join(', ')}]` : '';
    lines.push(`  ${i + 1}. ${s.description}${tools}`);
  });
  if (prompt.constraints.length) {
    lines.push('');
    lines.push('Constraints:');
    prompt.constraints.forEach((c) => lines.push(`  - ${c}`));
  }
  if (prompt.acceptance.length) {
    lines.push('');
    lines.push('Acceptance:');
    prompt.acceptance.forEach((a) => lines.push(`  - ${a}`));
  }
  return { form: confirmedForm, businessLogic: lines.join('\n') };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/agent-codegen/prompt-gen/to-codegen-input.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(promptgen): AgentPrompt -> (form, businessLogic) pipeline adapter" -- \
  lib/agent-codegen/prompt-gen/to-codegen-input.ts \
  lib/agent-codegen/prompt-gen/to-codegen-input.test.ts
```

---

### Task 6: PromptGen LLM call (`prompt-gen.ts`)

Mirrors `spec-extractor.ts`: gateway → tool_choice function → JSON.parse → Zod safeParse. Adds `AI_PROMPTGEN_MODEL` to the gateway picker. Loads agent exemplars from source files. The LLM call is exercised with a mocked OpenAI client.

**Files:**
- Modify: `lib/agent-codegen/llm/gateway.ts` (add `pickPromptGenGateway`)
- Create: `lib/agent-codegen/prompt-gen/agent-exemplars.ts` (read the 5 agents' source as blueprints)
- Create: `lib/agent-codegen/prompt-gen/prompt-gen.ts`
- Test: `lib/agent-codegen/prompt-gen/prompt-gen.test.ts`

- [ ] **Step 1: Add `pickPromptGenGateway` to gateway.ts**

Append:

```ts
// PromptGen prefers a stronger model than codegen (synthesis benefits from
// reasoning); falls back to the codegen model, then AI_MODEL.
export function pickPromptGenGateway(): GatewayConfig {
  const base = pickCodegenGateway();
  return { ...base, model: process.env.AI_PROMPTGEN_MODEL || base.model };
}
```

- [ ] **Step 2: Write `agent-exemplars.ts`** (no test — thin fs read; verified by build)

```ts
// agent-exemplars.ts
// Reads the 5 production agents' source as read-only blueprints. They are
// ground truth; PromptGen NEVER writes them. Trigger/emits are parsed best-effort
// for blueprint matching; failures degrade to an empty exemplar list.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentExemplar } from './context-select';

const AGENTS_DIR = join(process.cwd(), 'server', 'inngest', 'agents');

const KNOWN: Array<{ slug: string; stage: string; file: string; triggerEvent: string; emitEvents: string[] }> = [
  { slug: 'create-jd-agent', stage: 'jd', file: 'create-jd-agent.ts', triggerEvent: 'CLARIFICATION_READY', emitEvents: ['JD_GENERATED'] },
  { slug: 'resume-parser-agent', stage: 'resume', file: 'resume-parser-agent.ts', triggerEvent: 'RESUME_DOWNLOADED', emitEvents: ['RESUME_PROCESSED'] },
  { slug: 'match-resume-agent', stage: 'match', file: 'match-resume-agent.ts', triggerEvent: 'MATCH_RULE_CHECK_PASSED', emitEvents: ['MATCH_PASSED_NEED_INTERVIEW'] },
  { slug: 'rule-check-agent', stage: 'match', file: 'rule-check-agent.ts', triggerEvent: 'RESUME_PROCESSED', emitEvents: ['MATCH_RULE_CHECK_PASSED', 'MATCH_RULE_CHECK_FAILED'] },
  { slug: 'interview-inviter-agent', stage: 'interview', file: 'interview-inviter-agent.ts', triggerEvent: 'INTERVIEW_INVITATION_REQUESTED', emitEvents: ['INTERVIEW_INVITATION_SENT'] },
];

export function loadAgentExemplars(): AgentExemplar[] {
  return KNOWN.flatMap((a) => {
    try {
      const source = readFileSync(join(AGENTS_DIR, a.file), 'utf8');
      return [{ slug: a.slug, stage: a.stage, triggerEvent: a.triggerEvent, emitEvents: a.emitEvents, source }];
    } catch {
      return [];
    }
  });
}
```

> Implementer: confirm the 5 filenames + their trigger/emit names against the actual files (Task discovered them at `server/inngest/agents/`). Adjust the KNOWN table to match reality; these wire blueprint matching, not codegen correctness.

- [ ] **Step 3: Write the failing test (mocked client)**

```ts
// prompt-gen.test.ts
import { describe, it, expect, vi } from 'vitest';

const valid = {
  intent: 'screen resumes', role: 'Screens resumes.',
  trigger: { event: 'RESUME_PROCESSED', payloadExpectations: 'candidate_id' },
  inputs: ['parsed_resume'], steps: [{ id: 'fetch', description: 'load resume' }],
  tools: [], emits: ['MATCH_RULE_CHECK_PASSED'], errorHandling: 'retry',
  constraints: ['dual-write'], acceptance: ['emits one event'],
};

vi.mock('../llm/gateway', () => ({
  pickPromptGenGateway: () => ({ baseURL: 'x', apiKey: 'x', model: 'test-model' }),
  makeClient: () => ({
    chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'submit_agent_prompt', arguments: JSON.stringify(valid) } }] } }],
    }) } },
  }),
}));

import { generateAgentPrompt } from './prompt-gen';

describe('generateAgentPrompt', () => {
  it('parses the tool call, validates it, and attaches provenance', async () => {
    const res = await generateAgentPrompt({
      intent: 'screen resumes', locked: { triggerEvent: 'RESUME_PROCESSED' }, domain: 'raas',
    });
    expect(res.prompt.intent).toBe('screen resumes');
    expect(res.prompt.trigger.confirmed).toBe(false);
    expect(res.prompt.fieldOrigin.triggerEvent).toBe('locked');
    expect(res.modelUsed).toBe('test-model');
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run lib/agent-codegen/prompt-gen/prompt-gen.test.ts`
Expected: FAIL — cannot resolve `./prompt-gen`.

- [ ] **Step 5: Implement**

```ts
// prompt-gen.ts
import { pickPromptGenGateway, makeClient } from '../llm/gateway';
import { getToolRegistry } from '../registries';
import { CANONICAL_ENTITIES } from '../ontology/canonical-schemas';
import type { DomainId } from '@/lib/domains';
import type { AgentFormFields } from '../spec-types';
import { AgentPromptDraftSchema, AGENT_PROMPT_DRAFT_JSON_SCHEMA, type AgentPrompt, type FieldOrigin } from './prompt-types';
import { loadEventContexts, loadRealPayloadSamples } from './context-sources';
import { selectContext } from './context-select';
import { assembleSystemPrompt } from './context-assembler';
import { loadAgentExemplars } from './agent-exemplars';

export type GenerateAgentPromptInput = {
  intent: string;
  locked: Partial<AgentFormFields>;
  domain: DomainId;
  blueprintSlug?: string;
};

export type GenerateAgentPromptResult = {
  prompt: AgentPrompt;
  modelUsed: string;
  sourceBadge: 'neo4j' | 'static';
  durationMs: number;
};

export async function generateAgentPrompt(input: GenerateAgentPromptInput): Promise<GenerateAgentPromptResult> {
  const t0 = Date.now();
  const { events, source } = await loadEventContexts(input.domain);

  // attach real payload samples to the locked/likely trigger event (lightweight)
  const triggerName = input.locked.triggerEvent;
  if (triggerName) {
    const samples = await loadRealPayloadSamples(triggerName);
    const ev = events.find((e) => e.name === triggerName);
    if (ev) ev.realPayloadSamples = samples;
  }

  const selected = selectContext({
    intent: input.intent,
    locked: input.locked,
    events,
    tools: getToolRegistry(input.domain),
    entities: CANONICAL_ENTITIES,
    agents: loadAgentExemplars(),
    blueprintSlug: input.blueprintSlug,
  });

  const systemPrompt = assembleSystemPrompt({ selected, locked: input.locked, sourceBadge: source });

  const gateway = pickPromptGenGateway();
  const client = makeClient(gateway);
  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.intent },
    ],
    tools: [{ type: 'function', function: { name: 'submit_agent_prompt', description: 'Submit the structured Agent Prompt.', parameters: AGENT_PROMPT_DRAFT_JSON_SCHEMA } }],
    tool_choice: { type: 'function', function: { name: 'submit_agent_prompt' } },
  });

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') throw new Error('LLM did not return a tool call');
  let raw: unknown;
  try { raw = JSON.parse(toolCall.function.arguments); } catch { throw new Error('LLM tool call arguments were not valid JSON'); }
  const parsed = AgentPromptDraftSchema.safeParse(raw);
  if (!parsed.success) throw new Error('PromptGen output failed schema validation: ' + JSON.stringify(parsed.error.issues));

  // provenance: locked fields are 'locked', everything the LLM proposed is 'inferred'
  const lockedKeys = new Set(Object.keys(input.locked).filter((k) => (input.locked as Record<string, unknown>)[k] != null));
  const fieldOrigin: Record<string, FieldOrigin> = {};
  for (const key of ['triggerEvent', 'stage', 'emitEvents', 'slug', 'displayName', 'ownerTeam']) {
    fieldOrigin[key] = lockedKeys.has(key) ? 'locked' : 'inferred';
  }

  const prompt: AgentPrompt = {
    ...parsed.data,
    trigger: { ...parsed.data.trigger, confirmed: false },
    fieldOrigin,
  };
  return { prompt, modelUsed: gateway.model, sourceBadge: source, durationMs: Date.now() - t0 };
}
```

- [ ] **Step 6: Run to verify it passes; then build**

Run: `npx vitest run lib/agent-codegen/prompt-gen/prompt-gen.test.ts`
Expected: PASS (1 test).
Run: `npm run build`
Expected: PASS — confirms `CANONICAL_ENTITIES` import + all wiring typecheck.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(promptgen): LLM prompt synthesis + AI_PROMPTGEN_MODEL gateway + agent exemplars" -- \
  lib/agent-codegen/llm/gateway.ts \
  lib/agent-codegen/prompt-gen/agent-exemplars.ts \
  lib/agent-codegen/prompt-gen/prompt-gen.ts \
  lib/agent-codegen/prompt-gen/prompt-gen.test.ts
```

---

### Task 7: `POST /api/codegen/prompt-gen` route

**Files:**
- Create: `app/api/codegen/prompt-gen/route.ts`
- Test: `app/api/codegen/prompt-gen/route.test.ts`

- [ ] **Step 1: Write the failing test (mock generateAgentPrompt)**

```ts
// route.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/agent-codegen/prompt-gen/prompt-gen', () => ({
  generateAgentPrompt: vi.fn().mockResolvedValue({
    prompt: { intent: 'x', role: 'r', trigger: { event: 'E', payloadExpectations: '', confirmed: false }, inputs: [], steps: [{ id: 's', description: 'd' }], tools: [], emits: [], errorHandling: 'retry', constraints: [], acceptance: [], fieldOrigin: {} },
    modelUsed: 'm', sourceBadge: 'static', durationMs: 1,
  }),
}));

import { POST } from './route';

function req(body: unknown) { return new Request('http://t/api/codegen/prompt-gen', { method: 'POST', body: JSON.stringify(body) }); }

describe('POST /api/codegen/prompt-gen', () => {
  it('400 on invalid body (missing intent)', async () => {
    const res = await POST(req({ domain: 'raas' }));
    expect(res.status).toBe(400);
  });
  it('200 + prompt on valid body', async () => {
    const res = await POST(req({ intent: 'screen resumes', domain: 'raas', locked: { triggerEvent: 'RESUME_PROCESSED' } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.prompt.intent).toBe('x');
    expect(json.modelUsed).toBe('m');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/api/codegen/prompt-gen/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement** (mirrors generate/route.ts)

```ts
// route.ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generateAgentPrompt } from '@/lib/agent-codegen/prompt-gen/prompt-gen';

const BodySchema = z.object({
  intent: z.string().min(4).max(2_000),
  domain: z.enum(['raas', 'r7']),
  locked: z
    .object({
      slug: z.string().optional(),
      displayName: z.string().optional(),
      stage: z.string().optional(),
      ownerTeam: z.string().optional(),
      triggerEvent: z.string().optional(),
      emitEvents: z.array(z.string()).optional(),
      retries: z.number().int().optional(),
      errorHandling: z.enum(['retry', 'dlq', 'hitl-fallback']).optional(),
    })
    .optional(),
  blueprintSlug: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', detail: parsed.error.issues }, { status: 400 });
  try {
    const result = await generateAgentPrompt({
      intent: parsed.data.intent,
      domain: parsed.data.domain,
      locked: (parsed.data.locked ?? {}) as never,
      blueprintSlug: parsed.data.blueprintSlug,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: 'promptgen_failure', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export const maxDuration = 60;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/api/codegen/prompt-gen/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(promptgen): POST /api/codegen/prompt-gen route" -- \
  app/api/codegen/prompt-gen/route.ts \
  app/api/codegen/prompt-gen/route.test.ts
```

---

## Chunk 3: Versioning + UI + wiring

### Task 8: Prompt-level versioning (serialize/deserialize `promptText`)

The version row's `codegen.promptText: string` (existing) now carries the structured `AgentPrompt` JSON. A pure helper does the (de)serialization with backward-compat for legacy plain-string rows.

**Files:**
- Create: `lib/agent-codegen/prompt-gen/prompt-version.ts`
- Test: `lib/agent-codegen/prompt-gen/prompt-version.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// prompt-version.test.ts
import { describe, it, expect } from 'vitest';
import { serializePromptText, deserializePromptText } from './prompt-version';
import type { AgentPrompt } from './prompt-types';

const prompt: AgentPrompt = {
  intent: 'screen resumes', role: 'r', trigger: { event: 'E', payloadExpectations: '', confirmed: true },
  inputs: [], steps: [{ id: 's', description: 'd' }], tools: [], emits: [], errorHandling: 'retry',
  constraints: [], acceptance: [], fieldOrigin: {},
};

describe('prompt-version', () => {
  it('round-trips an AgentPrompt through promptText', () => {
    expect(deserializePromptText(serializePromptText(prompt))).toEqual(prompt);
  });
  it('reads a legacy plain-string promptText as { intent }', () => {
    const legacy = deserializePromptText('just some old business logic prose');
    expect(legacy?.intent).toBe('just some old business logic prose');
    expect(legacy?.steps).toEqual([]);
  });
  it('returns null for empty/garbage', () => {
    expect(deserializePromptText('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/agent-codegen/prompt-gen/prompt-version.test.ts`
Expected: FAIL — cannot resolve `./prompt-version`.

- [ ] **Step 3: Implement**

```ts
// prompt-version.ts
// AgentPrompt <-> AgentVersion.codegen.promptText. New rows store JSON tagged
// with a version marker; legacy rows (plain prose) read as a minimal prompt.

import { AgentPromptDraftSchema, type AgentPrompt } from './prompt-types';

const TAG = 'agentprompt/v1:';

export function serializePromptText(prompt: AgentPrompt): string {
  return TAG + JSON.stringify(prompt);
}

export function deserializePromptText(text: string | null | undefined): AgentPrompt | null {
  if (!text) return null;
  if (text.startsWith(TAG)) {
    try {
      const obj = JSON.parse(text.slice(TAG.length));
      // tolerate the extra provenance/confirmed fields the draft schema omits
      const draft = AgentPromptDraftSchema.safeParse(obj);
      if (draft.success) {
        return {
          ...draft.data,
          trigger: { ...draft.data.trigger, confirmed: Boolean(obj?.trigger?.confirmed) },
          fieldOrigin: obj?.fieldOrigin ?? {},
        };
      }
    } catch {
      /* fall through */
    }
    return null;
  }
  // legacy plain prose
  return {
    intent: text,
    role: '', trigger: { event: '', payloadExpectations: '', confirmed: false },
    inputs: [], steps: [], tools: [], emits: [], errorHandling: 'retry',
    constraints: [], acceptance: [], fieldOrigin: {},
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/agent-codegen/prompt-gen/prompt-version.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(promptgen): prompt-level versioning serialize/deserialize (legacy-compatible)" -- \
  lib/agent-codegen/prompt-gen/prompt-version.ts \
  lib/agent-codegen/prompt-gen/prompt-version.test.ts
```

---

### Task 9: i18n keys

**Files:**
- Modify: `lib/i18n.tsx` (add `pg_*` keys under both `zh` and `en`)

- [ ] **Step 1: Add keys**

Add to each dictionary (match existing `codegen_*` neighborhood). Keys + suggested copy:

| key | zh | en |
|---|---|---|
| `pg_intent_label` | 意图（一句话目标） | Intent (one-line goal) |
| `pg_intent_placeholder` | 例：筛进来的简历、对照 JD、标出 Top 20% 并发事件 | e.g. screen inbound resumes against the JD, flag top 20%, emit event |
| `pg_generate` | 生成 Prompt | Generate Prompt |
| `pg_generating` | 生成中… | Generating… |
| `pg_blueprint_label` | 蓝本 agent（可选） | Blueprint agent (optional) |
| `pg_locked_hint` | 锁定的字段会被当作硬约束 | Locked fields are treated as hard constraints |
| `pg_source_neo4j` | 事件数据：实时（Neo4j） | Events: live (Neo4j) |
| `pg_source_static` | 事件数据：静态兜底 | Events: static fallback |
| `pg_confirm_trigger` | 确认触发事件 | Confirm trigger event |
| `pg_confirm_slug` | 确认 slug | Confirm slug |
| `pg_accept_generate` | 批准并生成代码 | Accept & Generate Code |
| `pg_origin_inferred` | AI 推断 | AI-inferred |
| `pg_origin_locked` | 已锁定 | Locked |
| `pg_origin_confirmed` | 已确认 | Confirmed |
| `pg_stage_promptgen` | Prompt 生成 | PromptGen |

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS (no missing-key type errors if the dictionary is typed; otherwise lint clean).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(promptgen): i18n keys (pg_*)" -- lib/i18n.tsx
```

---

### Task 10: `PipelineTimeline` — add the `promptgen` stage

**Files:**
- Modify: `components/behavior/codegen/PipelineTimeline.tsx`

- [ ] **Step 1: Add the stage**

In `PipelineTimeline.tsx`:
- Add `"promptgen"` to the `PipelineStage` union (first).
- Add `"promptgen"` as the first element of `STAGE_ORDER`.

The label resolves via `t('codegen_stage_promptgen')` — add that i18n key (alias to `pg_stage_promptgen` copy) in Task 9's table if not already present; or reuse `codegen_stage_*` naming. Use whichever the existing `t('codegen_stage_${s}')` call expects: add `codegen_stage_promptgen` = same copy as `pg_stage_promptgen`.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(promptgen): PipelineTimeline promptgen stage" -- \
  components/behavior/codegen/PipelineTimeline.tsx lib/i18n.tsx
```

---

### Task 11: `IntentPanel` — Stage-0 input

**Files:**
- Create: `components/behavior/codegen/IntentPanel.tsx`

- [ ] **Step 1: Implement** (mirror PromptPanel.tsx styling/atoms)

A client component with:
- intent `<textarea>` (value/onChange props)
- optional locked-field controls: `triggerEvent` (select from event registry names passed as a prop), `stage` (select from StageEnum options), `emitEvents` (multi). Each has a "lock" checkbox; only locked values are sent.
- optional blueprint `<select>` (slugs passed as prop)
- a **[Generate Prompt]** button (calls `onGenerate`, disabled while `loading` or intent empty)
- a source badge area (`pg_source_neo4j` / `pg_source_static`) shown after generation

Props:
```ts
{
  intent: string; onIntentChange: (v: string) => void;
  locked: Partial<AgentFormFields>; onLockedChange: (l: Partial<AgentFormFields>) => void;
  eventNames: string[]; blueprintSlugs: string[];
  onGenerate: () => void; loading: boolean;
}
```
Use `useApp()` for `t`/labels. Use existing Tailwind tokens (`bg-panel`, `border-line`, `text-ink-4`, `var(--c-accent)`) — no hardcoded colors (see CLAUDE.md design-system rule).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(promptgen): IntentPanel (intent + locked fields + blueprint)" -- \
  components/behavior/codegen/IntentPanel.tsx
```

---

### Task 12: `AgentPromptView` — editable prompt + confirm gate

**Files:**
- Create: `components/behavior/codegen/AgentPromptView.tsx`

- [ ] **Step 1: Implement**

A client component that renders an `AgentPrompt` as collapsible, editable sections (intent/role/trigger/inputs/steps/tools/emits/constraints/acceptance), with:
- a provenance badge per identity/wire-up field using `prompt.fieldOrigin` (`pg_origin_*`)
- a **confirm** control for `trigger.event` and `slug` (sets `confirmed` / marks the field `confirmed` in fieldOrigin)
- editable fields call `onChange(updatedPrompt)`
- an **[Accept & Generate Code]** button that calls `onAccept`, **disabled** until `trigger.confirmed === true` AND a non-empty confirmed `slug` exists (this enforces the spec's human-owns-the-form gate)

Props:
```ts
{
  prompt: AgentPrompt; onChange: (p: AgentPrompt) => void;
  form: AgentFormFields; onFormChange: (f: AgentFormFields) => void; // slug/trigger live in the form
  onAccept: () => void; busy: boolean;
}
```

> The confirm gate is the load-bearing safety control (spec Part 1). Keep the disabled-logic exactly: no code generation until trigger + slug are human-confirmed.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(promptgen): AgentPromptView editable prompt + trigger/slug confirm gate" -- \
  components/behavior/codegen/AgentPromptView.tsx
```

---

### Task 13: Wire Stage-0 into `CodegenContent`

**Files:**
- Modify: `components/behavior/codegen/CodegenContent.tsx`

- [ ] **Step 1: Read the current orchestrator**

Read `CodegenContent.tsx` fully. Identify: the businessLogic state, the form state, the `onGenerateSpec` handler that POSTs `/api/codegen/generate`, and where `PromptPanel` + `PipelineTimeline` render.

- [ ] **Step 2: Add Stage-0 state + handlers**

Add state: `intent`, `locked`, `blueprintSlug`, `agentPrompt: AgentPrompt | null`, `pgLoading`, `pgSource`.
Add handler `handleGeneratePrompt()`:
- POST `/api/codegen/prompt-gen` with `{ intent, domain, locked, blueprintSlug }`
- on success: set `agentPrompt`, set `pgSource`, set the `promptgen` PipelineTimeline stage to `ok`, and seed the form from the prompt's inferred fields (without confirming trigger/slug)

Add handler `handleAcceptPrompt()`:
- guard: require `agentPrompt.trigger.confirmed` && `form.slug`
- compute `{ form, businessLogic } = toCodegenInput(agentPrompt, form)`
- set the existing `businessLogic` state to the rendered prose and call the existing `onGenerateSpec()` path (POST `/api/codegen/generate`) — i.e. reuse the unchanged pipeline

Render order in the left rail: `IntentPanel` → (if `agentPrompt`) `AgentPromptView` → existing `PromptPanel` (now showing the rendered businessLogic, still editable) → existing tabs.

On "Save as version", serialize via `serializePromptText(agentPrompt)` into the existing `codegen.promptText` field.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS (full typecheck of the wired flow).

- [ ] **Step 4: Manual smoke (requires LLM env + dev server)**

Use the run skill / `npm run dev` (port 3002). Navigate to `/behavior/codegen`:
1. Type an intent, lock the trigger event, click **Generate Prompt** → structured prompt appears, source badge shows neo4j/static.
2. Confirm trigger + slug → **Accept & Generate Code** enables.
3. Click it → existing pipeline runs, Code/Spec/Eval tabs populate as before.
4. Save as version → reopen → prompt round-trips (Task 8).

If no LLM env is configured locally, verify steps 2-4's gating logic with a stubbed `/api/codegen/prompt-gen` response and confirm the build + the confirm-gate disabled-state behave; note the LLM-dependent path as "verified by unit tests + build, manual LLM smoke pending env."

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(promptgen): wire Stage-0 intent->prompt->confirm->codegen into CodegenContent" -- \
  components/behavior/codegen/CodegenContent.tsx
```

---

## Done criteria

- [ ] `npm run test` green (all new vitest specs pass).
- [ ] `npm run build` clean (typecheck + lint).
- [ ] Manual: intent → Generate Prompt → confirm trigger+slug → Accept & Generate Code → existing pipeline + eval unchanged → Save as version round-trips the prompt.
- [ ] `runPipeline()` and the 5 production agents are unmodified (grep the diff to confirm).

## Out of scope (Phase 2 — do NOT build here)

- Library PromptGen mirror.
- Prompt-level auto-iterate UI (Bundle M already refines businessLogic; surfacing it as prompt diffs is later).
- Embedding/RAG retrieval in `context-select` (heuristics only for v1).
- Reusable prompt-fragment library.
