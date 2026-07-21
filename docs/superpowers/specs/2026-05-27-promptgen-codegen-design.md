# AI-Native Agent Authoring — PromptGen + CodeGen + Tool Generator (one closed loop)

> 2026-05-27 · Design doc
> Companion to [AI-native codegen feasibility](../../2026-05-25-ai-native-codegen-feasibility.md),
> [phase 4/5 decision](../../2026-05-25-codegen-phase4-phase5-decision.md), and
> [behavior codegen research](../../2026-05-25-ao-behavior-codegen-research.md).
> Status: **proposed** — awaiting implementation plan.

---

## TL;DR

The leader's framing, in full: *"先有 prompt，才能生成 code；需要 API 调用，就写出工具来。"*
An LLM authors a **prompt** first; the prompt is **injected into CodeGen** to produce the
agent's code; and when the agent needs an external API the registry doesn't have yet, a
**tool is generated** and registered before code-gen proceeds.

That is **three pillars bound by one registry, in one closed loop** — and two of the three
already exist in this repo:

| Pillar | What it generates | Status |
|---|---|---|
| **PromptGen** | a structured, reviewable `AgentPrompt` from a light intent | **NEW — this spec (Bundle P)** |
| **CodeGen** | the Inngest agent `.ts` from the approved prompt | exists (`runPipeline`: LLM-A → LLM-B → render → compile → eval) |
| **Tool Generator** | an `@/lib/*` HTTP-client wrapper + a `TOOL_REGISTRY` entry, from curl/NL | exists (Library CodeGen, `/behavior/codegen/library`) — this is the leader's "写工具" |

`TOOL_REGISTRY` (+ the event registry) is **the seam**: AI generates strictly within the
registry's surface (so output is grounded, bounded, safe); humans extend that surface via
the Tool Generator. The whole point of this doc is to **wire the three pillars into a
single operator flow** — they exist today as three disconnected pages.

```
operator intent
   │
   ├─(does it need a tool the registry lacks?)──► Tool Generator ──► new TOOL_REGISTRY entry
   │                                                (Library CodeGen — leader's "写工具")
   ▼
PromptGen ──► AgentPrompt (grounded in registry tools + event registry)   ← NEW
   │            [human confirm gate: trigger + slug]
   ▼
CodeGen ──► agent .ts ──► eval (L1–L8) ──► save version ──► PR ──► deploy
   │
   ▼
agent emits/consumes real events ──► composes into the running workflow chain
```

`runPipeline()` does **not** change. PromptGen→CodeGen injection = deserialize the approved
`AgentPrompt` into `(AgentFormFields, businessLogic)` and call the existing pipeline.
Minimal blast radius; maximum reuse.

**Scope decisions (settled in brainstorming):**
- The prompt is a **CodeGen input spec** (reading B), authored by an LLM — *not* the agent's
  runtime brain. AO agents stay deterministic Inngest workflows; the *authoring* path
  becomes AI-native (intent → prompt → code).
- **Generation is static** — it reads only curated registries, never a live DB/Neo4j query
  (Part 4).
- **AI generates within the registry surface; it never self-extends it.** A missing
  capability routes to the Tool Generator (human-curated), per the leader's rule.

**Honest boundary (Part 1a):** an AI-generated agent slots into the *existing* event chain
when (a) it follows the canonical shape, (b) every tool it needs is already in the registry
(or generated first), and (c) every event it triggers/emits already exists. Building a whole
*new* multi-agent workflow from scratch is **assisted, not one-click** — new events + new
tools + cross-agent wiring stay human-curated.

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

## Part 1a — The closed loop: three pillars + the tool-gap protocol

Agents do **not** call each other directly — they communicate over the **Inngest event
bus**: agent A `emit X`, agent B `trigger on X`. So "agents compose into a workflow" reduces
to *every agent declaring the right `triggerEvent` / `emitEvents`*. Because PromptGen grounds
those names to the **event registry**, a newly generated agent's `emit X` is consumed by the
existing downstream agent — it **wires itself into the running chain**. No glue code.

### The three pillars and the registry seam

```
              ┌──────────────────────────────────────────────────────┐
              │  TOOL_REGISTRY  +  EVENT_REGISTRY  (static, human-curated) │  ← the seam
              └──────────────────────────────────────────────────────┘
                 ▲ extends surface              │ grounds generation
                 │                              ▼
   Tool Generator (Library CodeGen)      PromptGen ──► CodeGen ──► agent .ts
   curl/NL → @/lib/* wrapper             intent → AgentPrompt → runPipeline → eval
   → new TOOL_REGISTRY entry             (NEW)        (exists)
   (exists — leader's "写工具")
```

- **AI generates strictly inside the registry surface** → output is groundable, bounded,
  and safe (AI can't reach an arbitrary API).
- **Humans extend the surface through the Tool Generator** → new capability is a deliberate,
  reviewed act, consistent with the established "tool-registry curation stays human" limit.

### The tool-gap protocol (the leader's rule, made operational)

When the operator's intent (or the PromptGen draft) references a capability that is **not** a
`TOOL_REGISTRY` id:

1. PromptGen flags the gap: it lists the **missing tools** (intents like "call X API",
   "translate the JD") it could not ground to a registry id, instead of silently inventing a
   library path.
2. The flow offers to **jump to the Tool Generator** (Library CodeGen) pre-seeded with that
   need. The operator supplies curl/NL; it generates the `@/lib/*` wrapper + a suggested
   `TOOL_REGISTRY` entry; the operator reviews and commits it.
3. PromptGen **re-runs** with the now-complete registry; the previously-missing capability is
   a real tool id; CodeGen can fill the step.

This makes the registry the single source of truth and turns "I need a new API" into a
first-class, reviewed step rather than a generation failure. v1 implements the **flag + jump**
(detect missing tools, link to the Tool Generator); deep auto-handoff (auto-invoke Library
CodeGen mid-PromptGen) is a phase-2 polish.

### Worked example — regenerating `create-jd-agent`

| Dimension | Reality | Verdict |
|---|---|---|
| Tools it needs | `partner-pg.getRequirement`, `allmeta.writeJobRequisition`, `robohire.generateJdDirect`, `partner-pg.syncJd`, `allmeta.writeJobPosting`, `inngest.send` | **all already in the registry** → no tool-gap |
| Events | in `REQUIREMENT_LOGGED`; out `JD_GENERATED` (consumed by the downstream JD-publish chain) | **both in the event registry** → emits wire into the chain automatically |
| Where the tool-gap protocol would fire | hypothetically adding "translate the JD to English via a new API" | → Tool Generator writes a `translateJd` wrapper + registry entry **first**, then PromptGen can use it |

**Honest limits the example exposes (v1 gets ~80%, human finishes ~20%):**
- `create-jd-agent` carries `pickRequisitionIdFromEnvelope` — fallback across `entity_id` /
  `payload.requirement_id` / `raw_input_data.job_requisition_id`. That is the **L7 gap** (real
  payload shape vs. declared), deferred here; AI follows the declared contract and may miss
  the historical fallbacks.
- It also carries a 130-line `buildPromptFromRequirement` domain helper — the **domain-helper
  gap**; the thin template doesn't render free-standing helpers, so LLM-B inlines or the
  operator hand-finishes.

So: **insert-into-existing-chain is realistic today; whole-new-workflow-from-scratch is
assisted** (each agent through the loop, plus human-curated new events/tools/wiring).

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
    event: string;                   // primary trigger, from the event registry
    additionalEvents?: string[];     // real agents fan in on multiple triggers
                                     // (e.g. create-jd: REQUIREMENT_LOGGED +
                                     // CLARIFICATION_READY + JD_REJECTED). Captured
                                     // in the prompt; code-layer render deferred (Part 9).
    payloadExpectations: string;     // what fields the handler reads off event.data
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

**Generation is a static, design-time activity — not a live data pipeline.** Today's
codegen reads only **static curated registries** during generation (`getToolRegistry` →
`TOOL_REGISTRY_RAAS`, `getEventRegistry` → `EVENT_REGISTRY_RAAS`, `CANONICAL_ENTITIES`,
static agent source); it never queries the DB or Neo4j at generation time, and
`event-registry.raas.ts` states the static list is *"the auditable source of truth for
now."* PromptGen stays inside that model: it reads the **same static curated sources**.
This keeps generation deterministic, reproducible, and free of off-VPN / sync fragility.

| Prompt section | Needs to know | Source (static, curated) |
|---|---|---|
| `trigger.event` + payloadExpectations | which events exist + their payload fields | `EVENT_REGISTRY_RAAS` (name/stage/summary/direction). Payload field shape, when desired, comes from a **static snapshot** baked offline (see below), not a live query |
| `inputs` (data it reads) | which entities/tables/nodes + their fields | `canonical-schemas.ts` (8 Allmeta entities w/ PK/FK/required — itself a static snapshot lifted from the writer files) |
| `steps` | domain task decomposition + **AO code idioms** | the 5 production agents' source (`server/inngest/agents/`); `tool-registry` `exampleCalls` (real call-site snippets lifted from those agents) |
| `tools` | what is callable | `tool-registry.raas.ts` (`signature`/`importFrom`/`sideEffects`/`category`/`canonicalEntity`) |
| `emits` | which events to emit | `EVENT_REGISTRY_RAAS` (`direction` marks produce/consume) |
| `constraints` | dual-write, idempotency, NonRetriableError conventions | static reviewer's 8+1 rules; Bundle J canonical-field guidance; agent source |
| `acceptance` | what "correct" looks like | derived from the prompt's emits + the blueprint agent's shape |
| blueprint | a similar existing agent | the 5 agents' source |

**Optional offline snapshot (NOT a live fetch).** If we want richer event payload schemas
(or real observed samples) than the static registry carries, we **bake them into a
registry file via an offline script** — exactly how `canonical-schemas.ts` was lifted from
production writers, "re-sync is one grep away." The script may read
`prisma.eventDefinition` / `EventInstance` *at author time*, but the **generation path
itself reads only the committed static file**. This preserves reproducibility (the same
intent generates the same prompt regardless of DB/VPN state) and is deferred from v1 (see
Part 9).

The 5 production agents are **read-only ground truth / few-shot** here; PromptGen never
modifies them (explicit user constraint: "我们不动现有 agents").

### Source model (static)

All generation-time sources are **static curated files, imported directly** — the same
model the existing codegen uses:

- `TOOL_REGISTRY_RAAS`, `EVENT_REGISTRY_RAAS`, `CANONICAL_ENTITIES`, the stage enum,
  reviewer rules, and the 5 agents' source.
- Cross-agent topology, if needed, is **derived from the static registries** (e.g. which
  agents declare which trigger/emit) — still no runtime query.
- Any payload-schema enrichment is a **committed snapshot** refreshed by an offline script
  (above), never a fetch on the generation path.

### `context-assembler.ts`

Pulls the static sources into a structured `PromptGenContext`. One technical crux remains:

**Crux — context is too big → selection layer.** ~32 events + the whole
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
- **Tool-gap banner (the leader's rule in the UI):** when PromptGen reports `missingTools`
  (capabilities it could not ground to a `TOOL_REGISTRY` id), show them with a
  **[Generate this tool →]** link to Library CodeGen (`/behavior/codegen/library`). After the
  operator creates + registers the tool, **[Re-generate Prompt]** picks it up.
- Add a "PromptGen" stage to the existing `PipelineTimeline.tsx`.

---

## Part 8 — New modules (slotting into existing structure)

```
lib/agent-codegen/prompt-gen/
  prompt-types.ts        AgentPrompt Zod schema + PromptStep + PromptGenContext
  context-sources.ts     read layer over STATIC curated registries:
                         EVENT_REGISTRY_RAAS + canonical-schemas + tool-registry + agents
  context-select.ts      heuristic selection: relevant events/tools/entities/blueprint
  context-assembler.ts   selected sources → system prompt
  prompt-gen.ts          LLM call, tool_choice submit_agent_prompt, reuses gateway.ts;
                         also computes missingTools = prompt.tools \ registry ids (tool-gap)
  to-codegen-input.ts    AgentPrompt → (AgentFormFields, businessLogic)
app/api/codegen/prompt-gen/route.ts   POST → { prompt, missingTools, modelUsed, timings }
components/behavior/codegen/
  PromptPanel.tsx        (upgrade) Stage-0 intent panel
  AgentPromptView.tsx    (new) editable structured prompt + provenance + confirm gate
                         + tool-gap banner linking to Library CodeGen (Tool Generator)
```

**No new runtime read path.** `context-sources.ts` reads only static curated files
(`EVENT_REGISTRY_RAAS`, `CANONICAL_ENTITIES`, `tool-registry.raas.ts`, agent source) —
the same sources existing codegen already imports. No Prisma / Neo4j query on the
generation path. (Payload-schema snapshotting, if pursued later, is a separate offline
script — see Part 4 / Part 9.)

Touched existing files: `PipelineTimeline.tsx` (+1 stage), `CodegenContent.tsx`
(orchestrate Stage-0 → gate → existing flow), `AgentVersion` type/storage (promptText
payload), i18n dictionary (new `pg_*` keys, zh + en).

---

## Part 9 — Scope / phasing

The three pillars are positioned as: **CodeGen** (exists, unchanged), **Tool Generator** =
Library CodeGen (exists, unchanged), **PromptGen** (built here). This spec's net-new work is
**PromptGen + wiring the three into one operator flow**.

**Phase 1 (this spec):** Agent PromptGen — intent panel, PromptGen LLM call, AgentPrompt
artifact + schema, **static data layer** (context-sources over the curated registries +
heuristic context-select + context-assembler), review/confirm gate, injection into the
existing pipeline, prompt versioning, UI. Generation is static and reproducible — **no
live DB/Neo4j query on the generation path.** The prompt captures payload shape via
`payloadExpectations` (authored by the LLM from the static event registry + blueprint).
Multi-trigger (`trigger.additionalEvents`) is captured in the prompt for review.
**Tool-gap protocol — flag + jump (Part 1a):** PromptGen returns `missingTools`; the UI shows
them with a link to the Tool Generator (Library CodeGen); after the operator registers the
tool, re-running PromptGen picks it up. (This is the loop-closing integration with the
existing Tool Generator — light to build, since both pages already exist.)

**Phase 2 (noted, not specced — YAGNI for v1):**
- **Deep tool-gap auto-handoff** — auto-invoke Library CodeGen mid-PromptGen and resume,
  instead of the manual flag + jump.
- **Offline payload-schema snapshot** — a script that reads `prisma.eventDefinition` /
  `EventInstance` *at author time* and bakes event payload fields (and optionally real
  samples) into a committed static registry file (like `canonical-schemas.ts` was
  snapshotted). Generation still reads only the static file. Gated on usage — build it
  when operators hit payload-shape gaps. (Overlaps Bundle N's L7 goal.)
- **Code-layer enrichment** — render multi-trigger (`triggers[]`) and a typed inbound
  envelope (derived from the snapshotted payload schema) in `render-agent.ts`. Deferred
  per the Phase-4 expressiveness gate: build when a generated multi-trigger agent actually
  hits the thin-template ceiling. Until then the prompt declares additional triggers and
  `render-agent` emits them as a hand-finish note.
- **Library PromptGen mirror** — "describe the API in one line" → PromptGen drafts the
  curl examples + library spec → existing library pipeline.
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
| Static registry drifts from live events | Same trade-off existing codegen already accepts (registry is "the auditable source of truth for now"); refreshed by the offline snapshot script when needed (Part 9) — not a generation-time concern |
| Context too big / token blow-up | Heuristic selection layer trims to relevant subset (Part 4, Crux) |

**Non-goals:** changing the agent runtime model; **AI self-extending the tool registry**
(new tools always go through the human-driven Tool Generator + review); auto-confirming
trigger/slug; deep tool-gap auto-handoff (phase 2); one-click whole-new-workflow generation
(assisted only — Part 1a); changing CodeGen (`runPipeline`) or the Tool Generator internals.
