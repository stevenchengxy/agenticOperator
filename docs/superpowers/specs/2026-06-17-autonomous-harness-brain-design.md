# Agent Factory v3 — Autonomous Harness Brain (design)

**Date:** 2026-06-17 · **Status:** approved · supersedes the fixed `conductor` pipeline

## Decision (user-approved)
- **Autonomous ReAct brain + deterministic tools** (Claude/Codex model), NOT a fixed pipeline.
- **Full autonomy**, pausing only at key gates (before `deploy`, + any HITL gate).

## Core
A **streaming ReAct loop** where the LLM drives. Per turn: assemble messages → `streamChatWithTools(messages, tools)` → stream thinking deltas → if tool_calls: execute (reads parallel / writes serial), append results, loop; else done. Resumable, checkpointed to the ledger, hard per-build token budget.

**Hard prerequisite:** `streamChatWithTools()` — a streaming, tool-calling loop against the OpenAI-compatible gateway (today's `gateway.ts` throws at 5 iters + no streaming). Gemini gateway supports SSE + function-calling.

## Tool/action space (`lib/agent-factory-v3/tools/`)
Each tool = `{ name, description, parameters(JSONSchema), execute(args, ctx) }`.
- `read_ontology(domain, kind?)` / `search_ontology(query)` — JIT ontology.
- `write_agent(spec)` — generate one Behavior.compute (wraps proven generator).
- `validate_graph(specs)` — v3 graph verifier (built, 9/9).
- `sandbox_run(domain)` — deploy→Agents-generation→fire→observe (deploy bridge, namespacing+multi-emit fixed).
- `deploy(domain)` — promote drafts → Inngest. **HITL gate before this.**
- P2: `web_search(query)` / `fetch_url(url)` (needs a provider) · `create_skill` / `create_tool`.
- P3: `spawn_subagent(task)`.
- The deterministic builders (Planner/ToolSmith/Critic) exposed as optional tools.

## Streaming protocol (`BrainEvent`)
`think.delta`(token) · `tool.call`(id,name,input) · `tool.result`(id,output,ok) · `agent.created`(spec) · `skill.created` · `web.result` · `gate`(reason, pause) · `done`(tokensUsed) · `error`. Streamed over SSE from `app/api/factory-v3/brain/stream`.

## UI (Claude/Codex chatbot)
Center = streaming conversation: thinking streams token-by-token; tool calls = expandable cards (input→output); agent/skill cards inline; HITL approve/deny inline. Right inspector: Agents (sub-agents) · **Trace** (full live reasoning+tool log) · Eval. Left: domains + runs + drafts.

## Keeps / Replaces
Keeps: spine (bus/ledger/store/SSE), graph verifier, deploy bridge, builders-as-tools. Replaces: fixed `conductor`.

## Phases
- **P1**: streamChatWithTools + ReAct brain + minimal tools (read_ontology, write_agent, validate_graph, sandbox_run, deploy) + streaming chatbot UI. → autonomously generates working agents, streamed; fixes current broken live gen via fixed sandbox_run.
- **P2**: web_search + create_skill/create_tool.
- **P3**: spawn_subagent.

## Reliability
Deterministic tools keep quality; graph verifier gates before deploy; per-build token budget hard-stop; full ledger trace.
