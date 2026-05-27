# Bundle P — PromptGen: AI-authored Agent Prompt as the front-stage of CodeGen

> 2026-05-27 · Design doc
> Companion to [AI-native codegen feasibility](../../2026-05-25-ai-native-codegen-feasibility.md),
> [phase 4/5 decision](../../2026-05-25-codegen-phase4-phase5-decision.md), and
> [behavior codegen research](../../2026-05-25-ao-behavior-codegen-research.md).
> Status: **proposed** — awaiting implementation plan.

---

## TL;DR

The leader's framing: *"先有 prompt，才能生成 code"* — an LLM should **generate a prompt
first**, and that prompt is **injected into CodeGen** to produce the agent's code.

Today there is **no prompt-authoring stage**. The operator hand-writes the
`businessLogic` prose, and the existing pipeline (LLM-A → LLM-B → render → compile →
eval) consumes it directly. The textarea labelled "Prompt" in the UI is just that
hand-written prose — it is neither AI-generated nor the agent's runtime brain.

Bundle P adds a **front-stage** upstream of the existing pipeline:

```
[NEW] light operator input
   → LLM-PromptGen → structured Agent Prompt (reviewable, versionable)
   → [human review/edit gate]
   → injected into existing CodeGen (LLM-A → LLM-B → render → compile → eval)
   → code + eval → save version
```

`runPipeline()` does **not** change. Injection = deserialize the approved Agent Prompt
into `(AgentFormFields, businessLogic)` and call the existing pipeline. Minimal blast
radius; maximum reuse.

**Scope decision (settled in brainstorming):** the prompt is a **CodeGen input spec**
(reading B), authored by an LLM — *not* the agent's runtime brain (reading A). AO agents
remain deterministic Inngest workflows. What becomes AI-native is the *authoring* path:
intent → prompt → code, with the prompt as a first-class reviewable artifact.

---

## Part 1 — Where this sits relative to existing work

The feasibility doc's "When this is done" (Part 6) lists the AI-native pipeline as:

1. Operator types: **business goal + identity form** ← *Bundle P front-loads this*
2. AI extracts spec, fills bodies, renders code (LLM-A / LLM-B / render — exists)
3. AI evaluates structurally + statically + sandboxed (exists)
4. AI catches canonical-field violations (Bundle J — exists)
5–8. N / L / M / PR proposal

Bundle P is **Stage 0** — it generates the input to step 1. It does not replace any
existing bundle; it feeds them.

### Reconciling with the established human-owns-the-form line

The feasibility doc's *Limits* table and Bundle M both state a hard principle:

> AI refines **prose**; humans own the **form** (slug, trigger event, tool-registry
> curation). Bundle M "explicitly does NOT touch the form."

Bundle P respects this. PromptGen **proposes** form fields as a convenience (it has the
event catalog and tool registry in context, so it can suggest a plausible trigger and
emits), but:

- **Trigger event and slug require explicit human confirmation** before injection. The
  review gate surfaces every PromptGen-inferred form field as a *suggestion* the operator
  must accept or override. Inferred-but-unconfirmed identity/wire-up fields block the
  "Generate Code" action.
- The operator may **lock** any field up front; locked fields are treated as hard
  constraints by PromptGen rather than guesses.

So AI authors the prose-level prompt and *drafts* the form; the human still owns the form.

---

## Part 2 — The Agent Prompt artifact

The prompt is a **structured document**, not free prose. It must be (a) human-readable
for the review gate, (b) structured enough to drive LLM-A reliably, (c) versionable and
diffable.

```ts
// lib/agent-codegen/prompt-gen/prompt-types.ts
interface AgentPrompt {
  intent: string;                    // one-line goal, echoes input
  role: string;                      // responsibility in the recruitment pipeline
  trigger: {                         // SUGGESTION — operator must confirm
    event: string;                   // from events-catalog.ts
    payloadExpectations: string;     // what fields the handler reads
    confirmed: boolean;              // false until operator accepts at the gate
  };
  inputs: string[];                  // data it reads: Postgres tables / Neo4j nodes / RoboHire
  steps: PromptStep[];               // ordered NL steps — the heart; LLM-A turns these into steps[]
  tools: string[];                   // TOOL_REGISTRY ids it should use
  emits: string[];                   // events emitted (dual-write side effects)
  errorHandling: 'retry' | 'dlq' | 'hitl-fallback';
  constraints: string[];             // hard rules: dual-write contract, must-emit, idempotency
  acceptance: string[];              // what "correct" looks like — feeds test-case generation
  // provenance
  fieldOrigin: Record<string, 'inferred' | 'locked' | 'confirmed'>;
}

interface PromptStep {
  id: string;                        // kebab, stable across regenerations
  description: string;               // NL: "fetch the requisition from Postgres, mirror to Neo4j"
  usesTools?: string[];              // optional TOOL_REGISTRY id hints
}
```

**Why structured, not prose:** today's form fields + `businessLogic` prose are scattered.
The Agent Prompt is their coherent, reviewable superset. The review gate renders it as
collapsible sections; the operator edits any field; provenance markers
(`inferred` / `locked` / `confirmed`) show what PromptGen guessed vs. what the human owns.

**Division of labour (do NOT overlap LLM-A):** PromptGen stops at the human-readable
prompt. It does **not** emit `steps[]` code-shaped output. Step decomposition stays with
LLM-A; code bodies stay with LLM-B. Three LLM calls, three concerns:

| Stage | LLM | Produces | Audience |
|---|---|---|---|
| **PromptGen (NEW)** | LLM-P | Agent Prompt (what & why, in human terms) | operator review gate |
| Spec extract (exists) | LLM-A | `steps[]` (decomposed, executable) | pipeline |
| Body fill (exists) | LLM-B | TS step bodies | pipeline |

---

## Part 3 — Input (the recommended combination)

A single input panel with progressive disclosure. The operator gives as little or as much
as they want; PromptGen always produces a **full** Agent Prompt draft, treating any
supplied/locked field as a constraint.

1. **Required — one-line intent.** e.g. *"筛进来的简历、对照 JD、标出 Top 20% 并发事件"*.
   The AI-native entry point, lowest friction.
2. **Optional — locked key fields.** stage / triggerEvent / emitEvents. PromptGen suggests
   values; a *locked* field becomes a hard constraint (fixes the most common drift:
   wrong trigger / wrong stage).
3. **Optional — blueprint agent.** Pick an existing production agent as a few-shot anchor
   for "make one like X but for Y."

The three collapse into one flow because PromptGen always emits every field; the inputs
just shift fields from `inferred` → `locked`.

---

## Part 4 — Mechanism: how the LLM generates the prompt

### What the prompt needs, and where each piece comes from

PromptGen needs a **superset of what LLM-A/B already read**. Each section of the
`AgentPrompt` (Part 2) maps to a concrete, already-existing data source:

| Prompt section | Needs to know | Source |
|---|---|---|
| `trigger.event` + payloadExpectations | which events exist + their **real payload fields** | `prisma.eventDefinition` via `/api/events` (synced from Allmeta Ontology by the Neo4j sync worker); each row carries `fields[]` + JSON `schema`. Cold-start fallback only: `lib/events-catalog.ts` (32 rows, `@deprecated`) |
| `inputs` (data it reads) | which entities/tables/nodes + their fields | `lib/agent-codegen/ontology/canonical-schemas.ts` (8 Allmeta entities w/ PK/FK/required); `prisma/schema.prisma`; live ontology API (:7688) |
| `steps` | domain task decomposition + **AO code idioms** | the 5 production agents' source (`server/inngest/agents/`); `tool-registry` `exampleCalls` (real call-site snippets lifted from those agents) |
| `tools` | what is callable | `tool-registry.raas.ts` (`signature`/`importFrom`/`sideEffects`/`category`/`canonicalEntity`) |
| `emits` | which events to emit + who consumes them | `EventDef.subscribers`/`emits`/`publishers` (the event-chain topology is built into the catalog) |
| `constraints` | dual-write, idempotency, NonRetriableError conventions | static reviewer's 8+1 rules; Bundle J canonical-field guidance; agent source |
| `acceptance` | what "correct" looks like; **real fired payloads** | `EventInstance.payloadSummary` (real events that actually fired, + `causedByEventId` causality chain) |
| where-it-fits (topology) | upstream/downstream agents | `EventDef.publishers`/`subscribers` + `EventInstance.causedBy*` |
| blueprint | a similar existing agent | the 5 agents' source + their `AgentVersion` rows |

The 5 production agents are **read-only ground truth / few-shot** here; PromptGen never
modifies them (explicit user constraint: "我们不动现有 agents").

### Three source tiers

- **Tier 1 — static, already in-repo (zero new plumbing):** tool-registry,
  canonical-schemas, stage enum, the 5 agents' source, reviewer rules. Structured
  arrays/objects, imported directly; LLM-A/B already read them.
- **Tier 2 — live (needs a read path):** `prisma.eventDefinition` (authoritative event
  contract, via `/api/events`), `EventInstance.payloadSummary` (real observed payloads),
  live ontology API (:7688).
- **Tier 3 — derived:** cross-agent event topology, computed from publishers/subscribers +
  `causedBy` — gives PromptGen "where my agent sits in the chain."

### `context-assembler.ts`

Pulls the above into a structured `PromptGenContext`. Two technical cruxes:

**Crux 1 — live data degrades gracefully.** The authoritative event data is live
(Allmeta Ontology → sync worker → `prisma.eventDefinition`), but sync fails off-VPN, and
`EventInstance` rows may be absent on a fresh DB. The assembler **prefers live, falls back
to static silently** — the same degradation pattern AO already uses (the `@deprecated`
fallback comment in `events-catalog.ts`). No hard dependency on :7688 / RAAS being online.
Specifically: no real `EventInstance` payload for the trigger → fall back to the declared
contract (`eventDefinition.schema`); no `eventDefinition` at all → fall back to the
hardcoded catalog.

**Crux 2 — context is too big → selection layer.** 32 events × full schema + the whole
registry + 8 entities × ~30 fields + 5 agents × ~150 LoC will blow the token budget and
dilute signal. The assembler **selects a relevant subset** keyed off intent + locked
fields:
- events: keyword/stage match on intent, or (if locked) the locked event + its
  topological neighbors (up/downstream);
- tools: filter registry by stage + the entities the selected events touch;
- entities: include canonical schema only for entities the selected tools write;
- blueprint: pick the existing agent whose trigger/stage/emits best match (or
  operator-selected).

v1 uses **heuristic selection** (enum match + topology neighbors + registry filter by
`category`/`canonicalEntity`) — explainable and sufficient. Embedding/RAG retrieval is a
phase-2 upgrade, only if heuristics prove imprecise (YAGNI).

### The call

`prompt-gen.ts` makes a single LLM call via the existing `gateway.ts` (same model
routing), with a tool call `submit_agent_prompt` → Zod-validated `AgentPrompt`.

- New env knob `AI_PROMPTGEN_MODEL`, defaulting to a stronger model than codegen
  (prompt synthesis benefits from reasoning), falling back to `AI_CODEGEN_MODEL` →
  `AI_MODEL`.
- User message = the operator's one-line intent + any locked-field constraints.
- System message = the assembled context + the AgentPrompt schema + hard rules
  (only reference catalogued events, only reference registry tools, respect locked fields,
  do not invent a slug — that's the operator's).

### API

`POST /api/codegen/prompt-gen`

```
Request:  { intent: string, locked?: Partial<AgentFormFields>, blueprintSlug?: string }
Response: { prompt: AgentPrompt, modelUsed: string, timings: {...} }
```

---

## Part 5 — Injection into CodeGen

`to-codegen-input.ts` deserializes an approved Agent Prompt into the existing pipeline's
inputs:

```ts
function toCodegenInput(p: AgentPrompt, confirmedForm: AgentFormFields): {
  form: AgentFormFields;        // trigger/stage/emits/retries/errorHandling from confirmed form
  businessLogic: string;        // rendered from p.role + p.steps + p.constraints + p.tools
}
```

- `form` ← the operator-confirmed form fields (PromptGen suggestions the operator accepted
  or overrode at the gate). **Unconfirmed trigger/slug block this step.**
- `businessLogic` ← a deterministic render of the prompt's prose-bearing sections
  (`role`, `steps`, `constraints`, `tools`, `acceptance`) into the same prose shape LLM-A
  already consumes.

Then the existing `runPipeline(form, businessLogic, domain)` runs **unchanged**.

### Free dividend: Bundle M now refines at the prompt level

Bundle M's auto-iterator already refines `businessLogic` prose from eval gaps. Once
`businessLogic` is rendered from the Agent Prompt, Bundle M's refinement naturally maps
back onto the prompt — the loop becomes "AI refines the *prompt* until verdict is high,"
with zero changes to Bundle M. (Phase-2 polish: surface the refinement diff in the prompt
view rather than the raw prose.)

---

## Part 6 — Versioning

Today `AgentVersion` stores `{ codeBlob, specJson, promptText, modelUsed }`, where
`promptText` is the raw textarea string.

Bundle P upgrades `promptText`'s payload to the **structured Agent Prompt JSON** (plus a
rendered prose view for diffing). This yields **prompt-level diff/history**: the operator
can see how the prompt evolved across versions, not just the code. Backward-compat: old
rows with a plain string are read as `{ intent: <string> }`.

---

## Part 7 — UI

No new route. Extend `/behavior/codegen`:

- Add a **Stage-0 panel** (upgrade of `PromptPanel.tsx`): intent input + optional
  locked-field controls + optional blueprint picker + **[Generate Prompt]**.
- Render the generated Agent Prompt as an **editable, collapsible structured view**, with
  provenance badges (`inferred` / `locked` / `confirmed`) and a confirm control on
  trigger/slug.
- **[Accept & Generate Code]** flows the approved prompt into the existing pipeline; it is
  disabled until trigger event + slug are confirmed.
- Add a "PromptGen" stage to the existing `PipelineTimeline.tsx`.

---

## Part 8 — New modules (slotting into existing structure)

```
lib/agent-codegen/prompt-gen/
  prompt-types.ts        AgentPrompt Zod schema + PromptStep + PromptGenContext
  context-sources.ts     read layer: eventDefinition (live) + EventInstance payloads
                         + canonical-schemas + tool-registry + agents; live→static fallback
  context-select.ts      heuristic selection: relevant events/tools/entities/blueprint
  context-assembler.ts   selected sources → system prompt
  prompt-gen.ts          LLM call, tool_choice submit_agent_prompt, reuses gateway.ts
  to-codegen-input.ts    AgentPrompt → (AgentFormFields, businessLogic)
app/api/codegen/prompt-gen/route.ts   POST → AgentPrompt draft
components/behavior/codegen/
  PromptPanel.tsx        (upgrade) Stage-0 intent panel
  AgentPromptView.tsx    (new) editable structured prompt + provenance + confirm gate
```

The only **new read path** is `EventInstance.payloadSummary` (a Prisma query in
`context-sources.ts`). Everything else reuses existing read paths (`/api/events` /
`prisma.eventDefinition`, `canonical-schemas.ts`, `tool-registry.raas.ts`, agent source).

Touched existing files: `PipelineTimeline.tsx` (+1 stage), `CodegenContent.tsx`
(orchestrate Stage-0 → gate → existing flow), `AgentVersion` type/storage (promptText
payload), i18n dictionary (new `pg_*` keys, zh + en).

---

## Part 9 — Scope / phasing

**Phase 1 (this spec):** Agent PromptGen — intent panel, PromptGen LLM call, AgentPrompt
artifact + schema, **data layer** (context-sources + heuristic context-select +
context-assembler, with live→static fallback), review/confirm gate, injection into the
existing pipeline, prompt versioning, UI. **Real event payloads included, lightweight:**
pull 1–2 recent `EventInstance.payloadSummary` rows for the trigger event to ground
`payloadExpectations` + `acceptance`; silently fall back to the declared
`eventDefinition.schema` when none exist. (Overlaps Bundle N's L7 goal — this is the
minimal slice of it.)

**Phase 2 (noted, not specced — YAGNI for v1):**
- **Library PromptGen mirror** — "describe the API in one line" → PromptGen drafts the
  curl examples + library spec → existing library pipeline. A smaller mirror of the same
  pattern.
- Prompt-level auto-iterate UI (surface Bundle M refinements as prompt diffs).
- Reusable prompt-fragment library / templates.

---

## Part 10 — Risks & non-goals

| Risk | Mitigation |
|---|---|
| PromptGen guesses wrong trigger/slug | Human confirmation gate blocks code-gen until confirmed (Part 1) |
| Prompt drifts from what code actually does | Eval already diffs code vs. ground truth; prompt is the *input*, code/eval remain the source of truth |
| Scope creep into reading A (LLM-runtime agents) | Explicitly out of scope; agents stay deterministic Inngest workflows |
| Cost of an extra LLM call | One call per generation; cheaper than a wasted hand-written prose round; bounded |
| Overlap with LLM-A | PromptGen stops at human-readable prose; never emits `steps[]` (Part 2) |
| Live data unavailable (off-VPN, sync failed, fresh DB) | Assembler prefers live, falls back to static silently (Part 4, Crux 1); no hard dependency on :7688 / RAAS |
| Context too big / token blow-up | Heuristic selection layer trims to relevant subset (Part 4, Crux 2) |
| Stale real payloads mislead the prompt | Only used to ground `payloadExpectations`/`acceptance`; declared `eventDefinition.schema` remains the contract of record |

**Non-goals:** changing the agent runtime model; auto-extending the tool registry;
auto-confirming trigger/slug; Library PromptGen (phase 2).
