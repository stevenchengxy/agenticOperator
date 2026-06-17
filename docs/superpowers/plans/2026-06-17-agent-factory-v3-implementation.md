# Agent Factory v3 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`). Work on `main`, NO worktree (project rule). Commit with pathspec (`git commit -m … -- <files>`). Hermetic vitest (gateway mocked via `server/llm/__mocks__/gateway.ts`); one live smoke per phase off the test path. Don't push (leave for user). **Build real — no demos, no fakes.** Spec: `docs/superpowers/specs/2026-06-17-agent-factory-v3-design.md`.

**Goal:** A cognitive harness that reasons a domain ontology into runnable agents — emitting `Behavior.compute` into the existing `make-agent` factory — reverse-scored against known-good agents, saved as DRAFT, deployable to Inngest in the `Agents-generation` domain, with a Claude-Desktop 3-column UI whose Trace tab replays every internal agent's full reasoning/debate, and a fleet surface to add/delete/manage agents.

**Architecture:** Keep recovered v2 spine (L0: bus/ledger/store/types/deploy + Prisma Factory tables + SSE + auth). Build new cognitive layer in `lib/agent-factory-v3/`. Target the proven `server/inngest/agent-factory` runtime (generate `Behavior.compute`). Data model corrected to real code: `triggered_event` conditional graph, `tool_use` from ontology, resumable loop around `gateway.ts`.

**Tech Stack:** TS · vitest · Inngest · Prisma/Postgres · OpenAI-compatible gateway (`chatComplete`) · Next 16 App Router · React 19 · Tailwind v4.

---

## File structure

```
lib/agent-factory-v2/            # L0 SPINE — KEEP (recovered)
  bus.ts ledger.ts store.ts types.ts deploy.ts (+ tests)
lib/agent-factory-v3/            # NEW cognitive layer
  types.ts            # v3 types: ActionDigest, DomainGraph, GraphNode/Edge(+predicate), BehaviorDraft, BuildEventV3
  comprehend.ts       # map-reduce ontology comprehension (rules verbatim)
  graph.ts            # compileGraph(triggered_event+workflow) + verifyGraph (closure)
  conductor.ts        # resumable ReAct conductor (checkpoint→FactoryBuildEvent, budget)
  generate.ts         # per-node Behavior.compute generation orchestration
  sandbox.ts          # deploy draft → Agents-generation domain (isolated), run fixtures
  reverse-score.ts    # frozen golden fixtures + dual checklist + N-run variance
  draft-store.ts      # save every generation as DRAFT (extends v2 pattern)
  emit-behavior.ts    # render BehaviorDraft → make-agent Behavior.compute source
  builders/
    planner.ts toolsmith.ts behavior-writer.ts critic.ts validator.ts fixer.ts
    comprehender.ts integrator.ts
  golden/
    recruit.ts energy.ts   # frozen (input→expected) fixtures
  TARGET-CONTRACT.md  # what BehaviorWriter must emit (from make-agent factory)
server/inngest/factory/
  build-fn.ts         # Inngest fn that runs a v3 build (off main agent path)
app/api/factory-v3/
  build/route.ts      # POST trigger a build (returns runId)
  build/stream/route.ts  # SSE (reuse v2 stream pattern)
  drafts/route.ts     # GET list drafts
  drafts/[id]/promote/route.ts  # POST promote draft → deployed
  fleet/route.ts      # GET/POST/DELETE manage agents (AgentVersion CRUD)
app/behavior/factory-v3/page.tsx
components/behavior/factory-v3/
  FactoryV3Content.tsx   # 3-column shell
  RightPanel.tsx         # Agents / Trace / Eval tabs
  TraceTab.tsx           # full ledger render: per-agent I/O + thinking + debate + reasoning
  FleetPanel.tsx         # add/delete/manage agents
prisma/schema.prisma     # +Factory tables (done); maybe +draft fields
lib/i18n.tsx             # +nav_factory_v3 + factory strings (zh+en)
components/shared/LeftNav.tsx  # +factory-v3 entry
```

---

## Chunk / Phase plan (each phase ends GREEN + committed)

### P0 — Spine truth + scaffold + target contract
- [ ] Recover `lib/ontology-generator/snapshots/recruit-gen-v1/{actions,events,rules,workflow}.json` from git objects (14:17:56 cluster). Run `npx vitest run lib/agent-factory-v2` → **49/49 green**.
- [ ] Delete old cognitive layer: `lib/agent-factory-v2/{conductor,generate,smoke,comprehend}.ts` + builders/* + their tests. Keep `bus/ledger/store/types/deploy`. `npx tsc --noEmit` clean (route that imported conductor → point at v3 or stub).
- [ ] Read `server/inngest/agent-factory/types.ts` + `server/inngest/domains/energy/make-agent.ts` + `domains/energy/index.ts`. Write `lib/agent-factory-v3/TARGET-CONTRACT.md`: the exact `Behavior<TData>` / `ComputeCtx` / `ComputeResult.emitEvents` / `GateRequest` shapes BehaviorWriter must emit.
- [ ] Scaffold `lib/agent-factory-v3/` dirs + `types.ts` (re-export kept v2 spine types + new v3 types). tsc clean.
- **Gate:** spine 49/49; tsc clean; contract documented. Commit.

### P1 — Comprehend + compile + verify graph
- [ ] `graph.ts`: `compileGraph(actions, workflow)` → DomainGraph (nodes=actions, edges from `triggered_event` with business predicate); `verifyGraph` → orphanEmits/missingProducers/unreachableTerminals/hitlStates. TDD with recruit-gen-v1 + energy fixtures.
- [ ] `comprehend.ts` + `builders/comprehender.ts` + `integrator.ts`: map-reduce per-action digest (rules/failurePolicy verbatim), reduce → DomainGraph + index. Hermetic test (mocked gateway).
- **Gate:** recruit-gen-v1 compiles to the 7-node chain, 0 orphan emits; energy compiles with HITL states flagged; large energy ontology handled chunked (no whole-file load). Commit.

### P2 — Generate Behavior.compute + reverse-score (CORE LOOP)
- [ ] `conductor.ts`: resumable ReAct driver; each turn → FactoryBuildEvent; per-build token budget hard-stop; `chatComplete` as per-builder primitive (works around throw@5).
- [ ] `builders/{planner,toolsmith,behavior-writer,critic,validator,fixer}.ts`: crew. BehaviorWriter emits BehaviorDraft; `emit-behavior.ts` renders → Behavior.compute source. ToolSmith binds from `tool_use` via `lib/tools/registry`.
- [ ] `reverse-score.ts` + `golden/{recruit,energy}.ts`: frozen fixtures, dual checklist (did-emit + no-regression), N-run mean±variance. **Build this before trusting the generator.**
- [ ] `sandbox.ts`: register generated Behavior into the isolated `Agents-generation` Inngest domain (per-candidate reset), fire entry event, observe to terminal via ledger. Real isolation note: AST import-allowlist guard on generated source (deny non-CRUD imports) — first real safety gate.
- [ ] `generate.ts` + `draft-store.ts`: greedy generate→sandbox→score→repair(Reflexion max3); save every result as DRAFT with verdict.
- [ ] `server/inngest/factory/build-fn.ts`: wire the build as an Inngest function (off the main agent path) so it runs durably and streams.
- **Gate (the headline):** goal "复刻招聘 agents" → 7 Behavior.compute generated → graph verifies → sandbox runs the chain end-to-end in `Agents-generation` → reverse-score dual-checklist passes → DRAFT saved. **Live smoke with real gateway, real Inngest.** Commit.

### P3 — UI (3-column) + Trace + Fleet + deploy/manage
- [ ] API routes: `factory-v3/build` (POST), `build/stream` (SSE), `drafts` (GET), `drafts/[id]/promote` (POST), `fleet` (GET/POST/DELETE).
- [ ] `FactoryV3Content.tsx` 3-column (clone chatbot.html palette/atoms); left console+drafts, center build convo (think/tool/graph/HITL), right panel.
- [ ] `RightPanel.tsx` tabs Agents/Trace/Eval; `TraceTab.tsx` = **full ledger render**: every agent turn's input(prompt)/output/thinking/reasoning + inter-agent debate, threaded + filterable by agent/phase/event, backed by FactoryLlmCall+FactoryBuildEvent.
- [ ] `FleetPanel.tsx` + `fleet/route.ts`: list all agents (generated drafts + deployed), add/delete/manage (AgentVersion CRUD), deploy draft → Inngest `Agents-generation`.
- [ ] i18n zh+en, LeftNav entry, de-jargonize.
- **Gate:** operator runs a live build, watches every internal agent reason+debate in Trace, drafts appear, promotes a draft → it deploys to Inngest Agents-generation and the generated chain runs; fleet can add/delete agents. `npm run build` clean. Commit.

---

## Testing strategy
- Per-file hermetic vitest (mocked gateway), TDD where it pays (graph compiler/verifier are pure → strong unit tests; reverse-score deterministic on frozen fixtures).
- Each phase: one **live smoke** (real gateway + real Inngest `Agents-generation`) proving it's not a mock.
- Final acceptance = P2 gate (real end-to-end generation) + P3 gate (UI/Trace/fleet/deploy) both green, reported with evidence.

## Notes / iterate-as-we-go
- Design, UI, and this plan may change during build (user-sanctioned). Keep the spec/plan updated when a decision changes.
- Deferred (do NOT build now): CoALA 3-tier memory, surrogate predictor, MCTS/EvoAgent search, drift jobs, vector skill registry. Leave seams only.
