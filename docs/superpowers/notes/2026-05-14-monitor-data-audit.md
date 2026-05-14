# Monitor data source audit — 2026-05-14

## Tables consulted
- WorkflowRun (count: 15)
- AgentActivity (count: 980 · distinct types: 7)
- AgentEpisode (count: 0)
- event_instances (count: 2)
- DLQEntry (count: 0)
- HumanTask pending (count: 9)

## Activity type breakdown
```
event_emitted   325
agent_complete  306
event_received  220
tool            104
agent_error     20
info            4
step.completed  1
```

## Token source decision
Tokens are written by `server/llm/instrumented.ts → withLlmTelemetry()` 
into `AgentActivity` rows where `type='tool'`, with 
`metadata = JSON.stringify({ model, durationMs, promptTokens, completionTokens, totalTokens })`. 
Monitor will read this as the primary token source.

`AgentEpisode.tokenUsage` exists in the schema but is currently unwritten 
on this branch. Monitor APIs will prefer AgentEpisode rows when present 
(future-proof) and fall back to AgentActivity.metadata otherwise.

## Sample AgentActivity metadata (type='tool')

**Tool rows with metadata:** 104 found, all populated.

Sample (3 entries):
```json
{"source":"MinIO recruit-resume-raw/2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf (380866 bytes)","input_bytes":380866,"text_chars":3427,"llm_prompt_chars":3427}
{"source":"MinIO recruit-resume-raw/2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf (380866 bytes)","input_bytes":380866,"text_chars":3427,"llm_prompt_chars":3427}
{"source":"inline resume_text (389 chars)","input_bytes":389,"text_chars":389,"llm_prompt_chars":389}
```

**Note:** The tool metadata contains document source + character counts but **does NOT yet include LLM token telemetry** (promptTokens, completionTokens, totalTokens). The instrumentation code exists in `server/llm/instrumented.ts` (function `withLlmTelemetry`), but it has not been invoked by any tool calls in the agent runs captured by this DB snapshot — see sample metadata above for the actual shape currently being written. Token charts will be empty until the instrumentation is enabled and agents run.

**Metadata representativeness:** All 104 tool rows follow the same pattern — 100% have `source` field; 62% (64/104) have character counts (`text_chars`, `llm_prompt_chars`). The samples above are representative of the full dataset.

## Known gaps

- **AgentEpisode: 0 rows.** Expected — this table is newly added to the schema and rows accumulate as episodes are judged. Not blocking.
  
- **event_instances: 2 rows.** Expected low count — event logging is selective. Not blocking.

- **DLQEntry: 0 rows.** Expected — no failed message queue entries yet. Not blocking.

- **Token telemetry gap: confirmed.** The critical finding: `AgentActivity.metadata` has 104 tool rows with source/character data, but **no LLM token counts yet**. The `withLlmTelemetry()` instrumentation code exists in `server/llm/instrumented.ts` but the metadata path is not yet wired into the agent execution flow. 
  - **Impact:** Monitor token charts will render empty until agent runs include the instrumented code path.
  - **Assumption for implementation:** Monitor APIs will be built to gracefully handle empty/missing token metadata. No tokens ≠ error; it's an unfinished state.

- **HumanTask.pending: 9 rows.** Good signal — the HITL queue is populated and ready to display.

- **WorkflowRun: 15 rows.** Good baseline for the run tracker.

## Implementation readiness

✓ Sufficient non-token data exists (980 activities, 15 runs, 9 pending HITL tasks) to build and test the Monitor APIs with realistic mock data.

⚠ Token telemetry is a future gap, not a blocker. APIs will handle it gracefully.
