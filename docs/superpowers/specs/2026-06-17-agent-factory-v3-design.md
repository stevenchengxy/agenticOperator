# Agent Factory v3 — Design Spec

**Date:** 2026-06-17
**Status:** approved (design), pending implementation plan
**Supersedes:** the lost-then-recovered `lib/agent-factory-v2` cognitive layer (spine retained)

---

## 0. One-line

A cognitive "harness brain" that, given a goal + a domain ontology, **reasons** (not transcribes) its way to generating runnable agents — emitting `Behavior.compute` functions into the **existing** `make-agent` factory — validated by reverse-scoring against the known-good recruitment + energy agents, every output saved as a DRAFT, every internal helper-AI's full reasoning streamed live to a Claude-Desktop-style right panel.

This spec combines: **v2's recovered, tested deterministic spine** + **v3's cognitive layer / context engineering / reverse-score discipline** + **three ground-truth corrections verified against the real code**.

---

## 1. Grounding facts (verified 2026-06-17 against recovered code)

These killed the naive design and shape this one:

1. **The v2 spine is recovered and works** — `bus/ledger/store/types/deploy`, Prisma `FactoryBuildRun/Event/LlmCall`, SSE route, `factory-auth` — 48/49 hermetic tests green (last one needs the `recruit-gen-v1` snapshot fixture, also recoverable). It was never committed and the working tree was wiped; recovered from git loose objects. **We keep it as v3's L0.**
2. **Orchestration is a `triggered_event[]` conditional graph, not `emit`.** Recruitment actions have `emit: null`; `triggered_event` is multi-value conditional (e.g. `["RESUME_PROCESSED","RESUME_LOCKED_CONFLICT"]`). The graph compiler walks `triggered_event` with a per-edge business predicate.
3. **Tools are in the ontology `tool_use` field** (recruit-gen-v1 snapshot has it populated: `["minio.getResume","robohire.parseResume",...]`), bound through the recovered `lib/tools/registry.ts`. LLM inference is fallback only (for the Neo4j-deployed domain where `tool_use` is null).
4. **A working `make-agent` factory already exists** (`server/inngest/agent-factory/` + `domains/energy|feikong`) with `GateRequest→waitForEvent` (energy: 3 gates), `branchActions`, terminal states, conditional `emitEvents`, `Behavior.compute`. **The cognitive layer targets this**, not a parallel executor. Recruitment agents are hand-written, **linear, zero `waitForEvent`** — so recruitment is the no-HITL golden suite; energy/feikong is the HITL/branching golden suite.
5. **`gateway.ts` throws at `maxIterations=5` with no partial trace** (line 266-268), 300s timeout, no streaming. The cognitive loop must wrap it in a resumable, checkpointed driver — `chatComplete` is a per-builder primitive, not the loop.
6. **Real agents are stochastic** (they call `chatComplete`). Reverse-scoring uses **frozen golden fixtures** (pinned model/seed input→output), scored deterministically — never live re-run of a random reference.

---

## 2. Scope

### In (lean first increment)
L0 spine (kept) · resumable ReAct cognitive layer · `triggered_event` graph compile+verify · generate `Behavior.compute` (agent-as-code) · sandbox reverse-score (dual checklist, deterministic) · Reflexion repair · DRAFT store · Claude-Desktop 3-column UI with a rich right panel (Agents / **Trace** / Eval).

### Deferred (YAGNI until the lean loop proves out — v3's own review flags over-specification)
CoALA three-tier memory · surrogate cost-predictor · AFlow-MCTS / EvoAgent search · drift-detection jobs · cross-run vector skill registry · MemGPT working-set. The architecture leaves seams for these but ships without them.

---

## 3. Layered architecture

| Layer | Status | Contents |
|---|---|---|
| **L0 Spine** | **KEEP** (recovered) | `bus.ts`, `ledger.ts` (`recordLlmCall` single LLM entry + budget), `store.ts`, `types.ts` (BuildEvent union), `deploy.ts`, Prisma `FactoryBuildRun/Event/LlmCall`, SSE route, `factory-auth.ts` |
| **L1 Cognitive core** | **BUILD** | resumable `conductor`, builder crew (isolated sub-agents, ≤1.5k summary passback) |
| **L2 Context engineering** | **BUILD (lean)** | map-reduce comprehension, 1-hop slice selection, compaction (no silent drop), rules-verbatim invariant |
| **L3 Memory** | **DEFER** | (seam only: ledger already = episodic substrate) |
| **L4 Tools/skills** | **REUSE + extend** | recovered `lib/tools/registry.ts`, `resolve-registry.ts`, `recruitment-tools.ts`; ToolSmith binds from `tool_use` |
| **L5 Verify/sandbox** | **BUILD** | graph-closure verify, isolated sandbox run, dual-checklist reverse-score, Reflexion Fixer |
| **L6 UI** | **BUILD** | `app/behavior/factory-v3/` + `components/behavior/factory-v3/` — 3-column, rich right panel |

Engine: the existing **OpenAI-compatible gateway** (`chatComplete()` function-calling). Zero Anthropic-API dependency.

### Keep / Delete / Build (file-level)
- **KEEP:** `lib/agent-factory-v2/{bus,ledger,store,types,deploy}.ts`, the Prisma tables, the SSE route, `lib/factory-auth.ts`, `lib/tools/*`, `lib/agent-factory-gen/*` (v1 reuse helpers), `server/llm/__mocks__/gateway.ts`.
- **DELETE/REPLACE (recovered v2 cognitive layer — transcribes, wrong target):** `conductor.ts`, `builders/*`, `generate.ts`, `smoke.ts`, `comprehend.ts`. (Remain in git history as reference.)
- **BUILD:** new `lib/agent-factory-v3/` cognitive core + `components/behavior/factory-v3/` + `app/behavior/factory-v3/`.

> Naming: new cognitive code lives under `lib/agent-factory-v3/` importing the kept spine from `lib/agent-factory-v2/`. (Spine may be promoted to a shared `lib/agent-factory/spine/` later; not now — avoid churn.)

---

## 4. Target runtime — generate `Behavior.compute`

The cognitive layer's deliverable per action is a **`Behavior.compute` function** + its place in the orchestration graph, plugged into `server/inngest/agent-factory`'s `makeOntologyAgent`. We reuse the proven contract: `ComputeCtx` (dataset, upstream payload, logger, memoized `step.run`), `ComputeResult.emitEvents` (conditional), `GateRequest→waitForEvent` (HITL), `branchActions`/`terminalActions`. The factory's executor runs it; we do not build a second executor.

Generated agents deploy **only to the isolated `Agents-generation` domain**, never to production recruitment/energy.

---

## 5. Data model & compile-then-generate

1. **Comprehend** (map-reduce): each action → strict structured digest, **rules/failurePolicy/park semantics preserved verbatim**. Hierarchical reduce → domain dependency graph + retrieval index. Never load the whole ontology (energy `actions.json` ≈ 140K tokens) into one window.
2. **Compile graph** from `triggered_event` + `workflow.json`: nodes = actions, edges = `(trigger → triggered_event)` each carrying a **business predicate** (pass / fail / conflict). 
3. **Verify** statically: every trigger has a producer, no orphan emits, terminals + HITL states reachable. **Fail fast back to Planner before any function body is generated.**
4. **Generate** `Behavior.compute` per node, fed a **1-hop context slice** only (owned action + its triggers/triggered_events/tools/rules/target_objects). Sibling actions are distractors — excluded.

---

## 6. Cognitive layer

**Resumable conductor** runs the ReAct loop on a checkpointed wrapper (each turn → `FactoryBuildEvent`, resumable from last persisted step). `chatComplete` is a per-builder primitive, never the driver (works around the gateway's throw-at-5).

**Builder crew** (each an isolated sub-agent, returns a typed ≤1.5k-token summary + ledger row-ids, never raw scratchpad):
`Comprehender×N` → `Planner` (proposes agent set along event boundaries; for recruitment must re-derive the 7 agents) → `GraphCompiler+Verifier` → `ToolSmith` (binds from `tool_use`) → `BehaviorWriter` (emits `Behavior.compute`, agent-as-code, calibrated-altitude prompt) → `Critic` → `Validator` → `Fixer` (Reflexion, max 3, stop on repeated diagnosis → HITL).

Deterministic gates wrap every tool call (deny-wins): the recovered `infra-vs-business` classifier (`lib/rule-check/infra-failure.ts`), draft-domain confinement, budget (`recordLlmCall`). LLM-judge is **advisory-only with debias**; acceptance is deterministic.

---

## 7. Generation pipeline (6 stages)

`comprehend → compile+verify graph → generate Behavior.compute → sandbox reverse-score → repair (Reflexion) → draft`. Greedy (no MCTS). Each stage emits `BuildEvent`s on the Bus → ledger → SSE.

---

## 8. Reverse-score harness (load-bearing)

Two **frozen-fixture** golden suites, scored **deterministically** (dual checklist, SWE-bench style: `did-emit` positive + `no-regression`):
- **Recruitment** (linear, no HITL): orchestration-correctness over the `triggered_event` chain + `infra-vs-business` classification + idempotent-PK replay.
- **Energy/feikong** (HITL/branching): gate-suspend, branch selection, terminal reachability.

Each candidate runs N times → mean ± variance (stochasticity guard). Acceptance = both checklists green. The 7 recruitment + energy agents are serialized as the seed archive + expressiveness test (if a candidate can't be expressed/scored, the model is too narrow).

---

## 9. Observability + Frontend

**Principle:** every internal LLM turn is a `FactoryLlmCall` ledger row → the UI is a *render of the ledger* (auditable + replayable). Built on `docs/reports/agent-factory-chatbot.html`'s palette + the shared atoms; de-jargonized; i18n zh+en.

**3-column** (`app/behavior/factory-v3/page.tsx` + `components/behavior/factory-v3/`):
- **Left:** domain switch + build runs + DRAFTS list (with score badges).
- **Center:** build conversation — goal input, collapsible think/tool blocks, inline `triggered_event` graph (Mermaid), HITL approve/park cards.
- **Right panel (enriched — per user):** tabbed —
  - **Agents:** live lane per helper-AI (Planner / Comprehender×N / ToolSmith / Generator / Critic / Fixer / Validator) with status + token counts, SSE-live.
  - **Trace (the rich one):** the **full, replayable record of every agent and AI turn** — each helper-AI's **input** (assembled prompt), **output**, **thinking/reasoning**, and **inter-agent debate** (Critic↔Generator challenges, Fixer diagnosis↔BehaviorWriter, Planner↔Observer). Threaded/filterable by agent, by build phase, by event. Backed 1:1 by `FactoryLlmCall` + `FactoryBuildEvent` rows, so it is complete and post-hoc inspectable, not just a live tail.
  - **Eval:** per-candidate dual-checklist verdict (F2P / P2P counts), pass-rate vs golden with variance, DRAFT badges.

Streaming requires a **streaming `chatComplete` variant** (currently absent) so thinking flows token-by-token to Trace; until then, Trace renders per-turn (still complete via ledger).

---

## 10. Phased delivery (first increment)

- **P0 — Spine truth + reconcile.** Finish recovering `recruit-gen-v1` snapshot (→ 49/49). Delete old cognitive layer. Scaffold `lib/agent-factory-v3/`. Map the `make-agent` `Behavior.compute` contract. *Exit:* spine green, contract documented, SSE streams a trivial BuildEvent sequence.
- **P1 — Comprehend + compile + verify.** map-reduce Comprehender (rules verbatim); `graph_compile` + `graph_verify` over `triggered_event` + predicates; inline Mermaid render. Validate on recruitment (re-derive graph) + 555KB energy (no context-rot). *Exit:* any domain → verified orchestration contract without loading whole ontology.
- **P2 — Generate + reverse-score (core loop).** BehaviorWriter emits `Behavior.compute`; resumable conductor; reverse-score harness (frozen fixtures, dual checklist, N-run variance); greedy generate→sandbox→score→repair; DRAFT with verdict. *Exit:* goal → reverse-scored DRAFT agents (the headline ask).
- **P3 — UI.** 3-column + rich right panel (Agents/Trace/Eval), SSE-live, ledger-backed Trace with full reasoning/debate. HITL promote gate. *Exit:* operator watches a live build, inspects every agent's reasoning/IO/debate, promotes drafts.

---

## 11. Testing

Hermetic vitest throughout (gateway mocked via `server/llm/__mocks__/gateway.ts`), mirroring the recovered suite. Graph compiler/verifier: pure-function unit tests over fixtures. Reverse-score harness: deterministic given frozen fixtures. One live smoke (real gateway + `Agents-generation` domain) per phase, off the test path.

---

## 12. Risks (carried from the v3 review)

- **Ontology-transcription relapse** (the v2 disease) → agent-as-code + reasoning + behavior-verify, never one-shot field mapping.
- **No deterministic metric = no search** → build the reverse-score harness *before* the generator.
- **In-process TS is not a security boundary** — generated TS can `import { partnerPg }`. First increment confines via draft-domain + the deterministic gate; **true isolation (AST import-allowlist, or out-of-process + disposable DB / microVM)** is required before any real code execution and is called out explicitly, not assumed.
- **Stochastic false-positives** → N-run mean±variance before DRAFT.
- **Cost fan-out** → per-build total token budget in the conductor (hard stop → HITL), not just per-edge.

---

## 13. Key references (full set in `docs/reports/agent-factory-v3-architecture.html`)

Harness-not-framework · Anthropic context engineering + multi-agent research system · ADAS / AFlow / DSPy · Reflexion / Self-Debug / AlphaCodium · SWE-bench dual-checklist · Voyager / CREATOR / CodeAct · Chroma context-rot · Temporal "fallacy of the graph" · E2B/Firecracker/gVisor (real isolation).
