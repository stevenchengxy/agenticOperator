# Workflow Canonical Sync — 2026-05-14

## Summary

Three sources of "workflow agent" information were drifting apart and have now been reconciled with the authoritative workflow JSON from the allmetaOntology team.

## Sources of Truth

| Source | Location | Role |
|--------|----------|------|
| Canonical workflow JSON | `lib/workflow-canonical.json` | **Primary spec** — 22 nodes with id/name/description/actor/trigger/actions/triggered_event |
| AGENT_MAP | `lib/agent-mapping.ts` | Registry metadata — 22 business agents + Chatbot (23 total) |
| Real Inngest agents | `resume-parser-agent/` | 3 wsIds actually deployed: 4, 9-1, 10 |

## What Changed

### 1. Canonical JSON in-repo (`lib/workflow-canonical.json`)

Copied from `/allmetaOntology/apps/events-builder/data copy/workflow_20260330 (1).json`. This is now the single source of truth for the workflow spec. Future workflow design changes should edit this JSON; the visualization regenerates from it automatically.

### 2. Graph auto-generation (`lib/workflow-graph-meta.ts`)

`NODES` and `EDGES` are now derived programmatically from `workflow-canonical.json` combined with a `NODE_LAYOUT` visual coordinate table keyed by wsId. Key consequences:

- Adding/removing a workflow node = edit the JSON + add a row to `NODE_LAYOUT`
- Edge wiring is automatic: each node's `trigger` and `triggered_event` arrays build the edge graph
- Exceptional events (suffix `_FAILED`, `_ERROR`, `_INCOMPLETE`, etc.) are automatically rendered as dashed edges

### 3. Node 3-2 `ReClarifier` added

The canonical JSON has node `3-2 requirementReClarification` (HITL, actor=Human). This was missing from the previous graph. It now appears:
- Position: (x=580, y=280) — offset below `clarifier` (x=580, y=100)  
- Edges: `clarifier → reClarifier (CLARIFICATION_INCOMPLETE)` and `reClarifier → reqAnalyzer (CLARIFICATION_RETRY)`
- Deployment: `conceptual` (Human actor, no Inngest function)

### 4. `MatchReviewer` removed

`MatchReviewer` (wsId `10-HITL`) existed in AGENT_MAP and the graph but does NOT appear in the canonical workflow JSON. The canonical spec treats `MATCH_FAILED` as a terminal event. Alignment choice: **Option A** — align with the authoritative spec.

Changes:
- Removed from `lib/agent-mapping.ts`
- Removed from `lib/agent-functions.ts`  
- Removed from `lib/workflow-graph-meta.ts` (now derived, no hand-coding needed)
- `MATCH_FAILED` is now a terminal event with no downstream consumer in the graph

### 5. Deployment status on graph nodes (`WorkflowNode.deployment`)

Each node now carries a `deployment` field:

| Status | Meaning | Visual |
|--------|---------|--------|
| `deployed` | Real Inngest function in `resume-parser-agent` | Green "Deployed" badge at top-right |
| `stubbed` | AO-main stub-factory handles it | No extra indicator (default) |
| `conceptual` | actor=Human in canonical JSON; no Inngest function | Dashed border |

The 3 deployed wsIds: `4` (JDGenerator/createJD), `9-1` (ResumeParser/processResume), `10` (Matcher/matchResume).

### 6. Stub-factory skips RPA-owned wsIds (`server/inngest/functions.ts`)

AO-main no longer registers stub Inngest functions for wsIds `4`, `9-1`, `10`. This prevents the stub from racing the real agent when both are subscribed to the same trigger event.

- Default: RPA-owned stubs are skipped (19 stubs registered, not 22)
- Override: set `STUB_RPA_OWNED=1` to re-enable for isolated dev/testing

### 7. Agent descriptions from canonical JSON (`lib/monitor/agent-descriptions.ts`)

Rewritten to derive all descriptions from `workflow-canonical.json` via the `CANONICAL_WORKFLOW` export. Each agent's:
- `description`: canonical JSON `description` field (full text, not hand-summarized)
- `input`: derived from `trigger[]` array
- `output`: derived from `triggered_event[]` array  
- `processingLogic`: derived from `actions[]` array (action name + first 120 chars of description)

The old hand-written `AGENT_DESCRIPTIONS` const is replaced. The public `getAgentDescription(short)` API is unchanged.

## Test Changes

- `lib/workflow-graph-meta.test.ts`: 11 → 14 tests (3 new tests added)
  - HITL node list updated (added ReClarifier, ResumeCollector, AIInterviewer; removed MatchReviewer)
  - Matcher fan-out: 3 edges → 2 edges (MATCH_FAILED is now terminal)
  - New: `reClarifier node exists` test
  - New: `canonical JSON is loaded with all 22 workflow nodes` test
  - New: `deployed nodes are exactly the 3 RPA-owned wsIds` test
- `lib/agent-mapping.test.ts`: count stays 23 (- MatchReviewer + ReClarifier = net zero)
- All other tests: 265/265 passing (up from 262; 3 new tests added)

## Maintenance Guide

**Adding a new workflow node:**
1. Add it to `lib/workflow-canonical.json`
2. Add a row to `NODE_LAYOUT` in `lib/workflow-graph-meta.ts` with visual coordinates
3. Add a title entry to `TITLE_BY_WSID` in the same file
4. Add to `lib/agent-mapping.ts` if it needs Inngest registration
5. Run `npx vitest run` — edge tests auto-update

**Changing a workflow event:**
1. Edit `trigger[]` / `triggered_event[]` in `lib/workflow-canonical.json`
2. Edges regenerate automatically on next build
3. Update AGENT_MAP `triggersEvents`/`emitsEvents` to match
