# Ontology Agent Generator — Runnable Agents Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Ontology Generator from sandboxed-shell drafts into real, runnable Inngest agents derived per Allmeta domain id — energy dispatch (`nengyuandiaodu-v1`) end-to-end first.

**Architecture:** A pure ontology-source layer reads a domain's five-piece ontology by domain id (Allmeta live → in-repo snapshot fallback). A `deriveAgents()` analyzer splits actions into LLM agents (actor=Agent) and simulated-human auto-responders (actor=Human). A single Inngest **factory** turns each derived agent-spec into a real `createFunction` (trigger event → self-gate on `AgentVersion.status` → simulated tool calls → real LLM call → emit next event), all registered behind `ENERGY_AGENTS=1`. The generator's deploy flips `AgentVersion` rows to `active`; a "run once" route fires the seed event.

**Tech Stack:** Next.js 16 route handlers, Inngest v4 (`step.sendEvent`), Prisma/Postgres (`AgentVersion`), `@/server/llm/gateway` `chatComplete`, `@/lib/agent-logger` (file JSONL bridged to AgentActivity + /audit LogEvent), vitest.

**Key integration facts (verified):**
- Inngest v4: arbitrary event names OK; emit via `step.sendEvent(id, {name, data})`.
- Functions registered in `server/inngest/functions.ts` → `allFunctions = [...realFunctions, ...stubFunctions, ...behaviorFunctions]`.
- Logger: `createAgentLogger({agent,nodeId,runId})` from `@/lib/agent-logger` + `runWithLogger` — file logs bridge to AgentActivity + LogEvent automatically.
- `AgentVersion`: `{ short, slug, versionLabel, status('draft'|'active'|'offline'|'archived'), domain, configJson, capturedFrom, generatedBy, notes }`.
- LLM: `chatComplete({ system, user, model?, temperature?, maxTokens?, logger? }) → { text, ... }`.
- Energy: 28 actions (17 actor=Agent → llm, 11 actor=Human → simulated-human); event chain in spec §4.5.

---

## Chunk 1: Ontology source + snapshot + analyzer (pure, unit-tested)

### Task 1: Snapshot the energy five-piece into the repo

**Files:**
- Create: `lib/ontology-generator/snapshots/nengyuandiaodu-v1/{objects,rules,actions,events,workflow}.json`

- [ ] Copy + normalize names from `neo4j_data/能源调度/*` → snapshot dir (objects/rules/actions/events from the `{metadata,...}`/array files; workflow from `workflow_nengyuan.json`).
- [ ] Commit: `git commit -m "feat(onto-gen): snapshot nengyuandiaodu-v1 five-piece ontology" -- lib/ontology-generator/snapshots/nengyuandiaodu-v1`

### Task 2: Ontology source types + loader

**Files:**
- Create: `lib/ontology-generator/ontology-source.ts`
- Test: `lib/ontology-generator/ontology-source.test.ts`

- [ ] **Test first:** `fetchDomainOntology("nengyuandiaodu-v1")` resolves `{ actions.length===28, events.length===31, source:"snapshot" }`.
- [ ] Implement `fetchDomainOntology(domainId)`: try Allmeta live (`GET /api/v1/ontology/{actions,events,objects,rules}?domain=<id>` via `ALLMETA_BASE_URL`+token, best-effort, short timeout); if any resource returns empty `items` or errors → load the in-repo snapshot for that domainId. Unwrap `{metadata,actions}`/bare-array shapes. `source` reflects which won.
- [ ] Run tests → PASS. Commit (pathspec).

### Task 3: deriveAgents analyzer

**Files:**
- Create: `lib/ontology-generator/analyze.ts`
- Test: `lib/ontology-generator/analyze.test.ts`

- [ ] **Test first:** `deriveAgents(energyOnto)` returns 28 specs; 17 `kind:"llm"`, 11 `kind:"simulated-human"`; `forecastOutput` spec has `triggerEvents:["DATA_INTERPRETED"]`, `emitEvents:["FORECAST_COMPLETED"]`, non-empty `systemPrompt`/`userPrompt`, `tools.length>0`.
- [ ] Implement `deriveAgents(onto): DerivedAgent[]` per spec §4.3 (camelCase actionName → slug `energy-<kebab>`, short `<Pascal>Agent`, kind by actor, copy trigger/triggered_event/tool_use/target_objects/system_prompt/user_prompt; rationale from real trigger→emit).
- [ ] Run tests → PASS. Commit (pathspec).

---

## Chunk 2: Runnable agent factory + Inngest registration

### Task 4: Tool simulation + structured-output helpers

**Files:**
- Create: `server/inngest/domains/energy/sim-tools.ts` (deterministic tool-result stand-ins, no randomness — derive from action+event names)
- Create: `server/inngest/domains/energy/structured-output.ts` (`buildEventDataSchemaHint(event)` + `parseOrSynthesize(text, event)` — parse LLM JSON, else synthesize a deterministic payload from the event's `event_data`)
- Test: `server/inngest/domains/energy/structured-output.test.ts`

- [ ] Test: `parseOrSynthesize('{"a":1}', evt)` returns parsed; on garbage returns a payload with every `event_data.name` key present.
- [ ] Implement + PASS + commit.

### Task 5: The agent factory

**Files:**
- Create: `server/inngest/domains/energy/make-agent.ts`

- [ ] Implement `makeOntologyAgent(spec: DerivedAgent, domainId: string)` → `inngest.createFunction({ id: spec.slug, name: spec.nameZh, retries: 1, triggers: spec.triggerEvents.map(e => ({ event: `${domainId}/${e}` })) }, handler)`. Handler, wrapped in `runWithLogger(createAgentLogger({agent: spec.short, nodeId: spec.actionName, runId})...)`:
  1. `log.event("event_received", ...)`.
  2. **Self-gate:** `await isAgentActive(domainId, spec.short)`; if not → `log.event("skip", {reason:"not-deployed"})` + return.
  3. Load context objects (`fetchDomainOntology` → pick `spec.objects` schemas).
  4. For each `spec.tools`: `log.apiCall(tool, simResult)` (simulated).
  5. **LLM:** `kind==="llm"` → `chatComplete({system: spec.systemPrompt, user: fill(spec.userPrompt)+toolResults+schemaHint, logger})`; `kind==="simulated-human"` → skip or one light call, mark `simulated:true`.
  6. `parseOrSynthesize` → payload; `log.decision(...)`.
  7. For each `spec.emitEvents`: `step.sendEvent('emit-'+e, { name: `${domainId}/${e}`, data: { payload, source_action: spec.actionName, simulated: kind==="simulated-human" } })`; `log.event("event_emitted", ...)`.
  8. `log.event("done", ...)`.
- [ ] Guard re-entry loops: if seed payload lacks `enableBranches`, the back-edge agents (`rollingRevision`, `raiseRiskEvent`) cap at depth via a `_depth` counter in event data (drop when `_depth > N`).

### Task 6: Manifest + registration

**Files:**
- Create: `server/inngest/domains/energy/index.ts` (`energyFunctions = deriveAgents(snapshotOnto).map(s => makeOntologyAgent(s, "nengyuandiaodu-v1"))`)
- Create: `server/inngest/domains/energy/is-active.ts` (`isAgentActive(domain, short)` — query `AgentVersion` newest row by `{domain, short}`, cache ~5s)
- Modify: `server/inngest/functions.ts` — import `energyFunctions` behind `process.env.ENERGY_AGENTS === "1"`; add `...energyFunctions` to `allFunctions`; update the registered-count log.

- [ ] `npm run build` typechecks. Commit (pathspec).

---

## Chunk 3: Deploy/activate + run wiring + API routes

### Task 7: Domains proxy + real infer/generate/run routes

**Files:**
- Create: `app/api/ontology-generator/domains/route.ts` (GET → proxy Allmeta `/api/domains`, fallback to known list)
- Create: `app/api/ontology-generator/run/route.ts` (POST `{domainId}` → `inngest.send({name: `${domainId}/DISPATCH_CYCLE_STARTED`, data:{ seededAt, enableBranches:false }})`)
- Modify: `app/api/ontology-generator/infer/route.ts` → return `deriveAgents(await fetchDomainOntology(domainId))` mapped to candidate cards (+ dangling-event annotation).
- Modify: `app/api/ontology-generator/generate/route.ts` → for energy candidates write/flip `AgentVersion` to `status:"active"`, `domain:domainId`, real `slug`/`short` (no forced `og-` prefix when a real function exists).

- [ ] `npm run build`. Commit (pathspec).

---

## Chunk 4: UI + end-to-end verification

### Task 8: Generator UI — real domains, real candidates, run button

**Files:**
- Modify: `components/behavior/ontology-generator/OntologyGeneratorContent.tsx` + `DomainChip`/`DeployResult` — domain dropdown from `/api/ontology-generator/domains`; candidates from real infer; deploy-result "运行一次演示" button → `POST /api/ontology-generator/run`.

- [ ] `npm run build`. Commit (pathspec).

### Task 9: Integration smoke + AO acceptance

**Files:**
- Create: `server/inngest/domains/energy/chain.smoke.test.ts` (drive a few handlers directly: feed `DATA_INGESTED` envelope → assert `forecastOutput` emits `FORECAST_COMPLETED` with full `event_data`; assert LogEvents recorded).

- [ ] `npm test` for the energy + onto-gen suites → PASS.
- [ ] Manual AO acceptance: `ENERGY_AGENTS=1 npm run dev` → `/behavior/ontology-generator` → pick `nengyuandiaodu-v1` → infer shows 28 (17 real + 11 simulated) → deploy → "运行一次" → `/audit` 运行日志 shows `ingestAndOpenCase → … → archiveCase` with LLM apiCall records.
- [ ] Commit any fixes (pathspec).

---

## Then: replicate reimbursement (`baoxiao-v1`)
Snapshot `neo4j_data/报销/*` → `snapshots/baoxiao-v1/`; same factory with `domainId="baoxiao-v1"` behind `FEIKONG_AGENTS=1`; reuse everything. Out of scope for the first run-through; covered once energy is green.

## Notes
- Commits: `git commit -m "…" -- <files>` pathspec; no push; no worktree (per memory).
- Keep recruitment production agents untouched; energy strictly gated by `ENERGY_AGENTS`.
