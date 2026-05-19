# Fleet 信息架构梳理 — Design Spec

**Date:** 2026-05-19
**Status:** Draft
**Scope:** Information architecture only (no visual / no code). Covers `/fleet` list page redesign + `/fleet/[short]` detail page IA skeleton.
**Out of scope:** Visual design, color tokens, code changes, receiving pages' internal IA, Manage actions implementation, Behavior (new-agent design) flow.

---

## 1. Why this spec exists

`/fleet` today conflates two unrelated jobs:

1. A real-time operational dashboard (system-wide KPIs, current alerts, live activity stream, pipeline visualization).
2. A roster of deployed agents.

Job 1 overlaps with `/overview`, `/events`, `/alerts`, `/workflow`. Job 2 has no other home.

This spec re-scopes `/fleet` around Job 2 only: **the registry of agents as long-lived assets, with a health snapshot to support governance decisions.** Everything that belongs to Job 1 is delegated to its canonical neighbor page.

Per the project memory (`project_three_pillars.md`), AO has three pillars — Monitor / Manage / Behavior — and only Monitor is in scope right now. This spec stays inside Monitor: it designs Fleet as the "agent roster + long-term health archive," but explicitly reserves visual slots for Manage actions (without implementing them) so the future Manage spec can plug in without restructuring.

---

## 2. Role / definition

> **`/fleet` is the three-pillar entry surface for agents as long-lived assets.** Its subtitle — "部署、监控和治理招聘自动化智能体" — declares the long-term role: a single page where operators **deploy** (Behavior), **monitor as long-term assets** (Monitor — the part this spec implements), and **govern** (Manage) the agent fleet. It does not answer "what is happening right now in the system." That question belongs to `/overview` (system KPIs), `/live` (per-run inspection), `/events` (stream), `/alerts` (incidents), `/workflow` (graph + pipeline).

Primary unit on the page is **one agent**, not "one row of operational data." Clicking a row enters the agent detail page (`/fleet/[short]`).

**Current-scope reminder.** The subtitle promises three pillars, but per `project_three_pillars.md` only Monitor is in build now. This spec therefore designs the **full IA** of the three-pillar surface but treats Behavior (deploy) and Manage (govern) as **visible-but-disabled placeholders** (see §6). When the Behavior / Manage specs land, they fill in handlers — they should not need to restructure the IA.

---

## 3. `/fleet` list page IA

### 3.1 Page header

| Element | Detail |
|---|---|
| Title | "智能体舰队" (i18n: `fleet_title`) |
| Subtitle | "部署、监控和治理招聘自动化智能体" (existing i18n key: `fleet_sub`, unchanged) — declares Fleet as the three-pillar entry surface |
| Time-window selector | `7d` (default) / `30d` / `90d` — replaces current `Last 24h` |
| Filter dropdown | All / With anomalies / Paused / Deprecated |
| Owner-team filter | Multi-select |
| Primary action | `+ 部署智能体` — placeholder behavior, see §6 |

### 3.2 Summary chips (replaces 6-card KPI strip)

Four inline chips, each clickable as a list filter:

| Chip | Computation | Click behavior |
|---|---|---|
| `Active 11/12` | Count where `lifecycle = active AND status ≠ paused` | Filter list to active |
| `7d Success 94.8%` | Cross-fleet weighted average | No filter; tooltip shows delta |
| `Anomalies 4` | Count with active P1/P2 alert OR `7d success < 90%` | Filter list to anomalies |
| `7 teams` | Distinct `ownerTeam` | Open team filter |

No KPI cards. No sparklines in the header. No `Cost today`. No `Runs 24h`. Those move to `/overview` (its spec decides how to absorb them).

### 3.3 Grouping & sort

Default group: **by owner team**. Each group renders a group header:

```
HSM · 交付         12 agents · all healthy
招聘运营            8 agents · 1 degraded · 1 paused
合规                1 agent  · all healthy
技术招聘            2 agents · 1 in review
```

Group toggle: `team` (default) / `status` / `stage` / `flat (sort by 7d success)`.

### 3.4 List columns

Five columns (down from 9):

| # | Column | Content |
|---|---|---|
| 1 | Identity | Mono glyph (single-color, not rainbow) + name + role + `id · owner` subscript |
| 2 | Status | Dot + word — no pill background; tone applied to text only when not `running` |
| 3 | 7d Health | `94.8% ↑0.6pp` — red when `<90%`, amber when `90–95%`, neutral otherwise |
| 4 | Last active | Relative time only |
| 5 | Version | Mono small, muted |
| → | Drill-in | Chevron → `/fleet/[short]` |

Removed from the list (moved to detail):

- Per-row 24h sparkline
- 24h runs count
- P50 latency
- Cost (today and any horizon)

### 3.5 Status taxonomy (visual rules)

| Status | Visual treatment |
|---|---|
| `running` | Default. Dot color `--c-ok`. Text neutral. No emphasis. |
| `degraded` | Dot color `--c-warn`. Status word in amber text. **No** background pill. |
| `failed` | Dot color `--c-err`. Status word in red text. **No** background pill. |
| `paused` | Dot muted grey. Entire row at `opacity: 0.55`. |
| `deprecated` | Paused styling + strikethrough on name. |
| `review` (HITL) | Dot color `--c-warn`. Status word "待审核". |

Color is a signal, not decoration. Only non-`running` states get color.

### 3.6 Density & footer

- Density toggle: `comfortable` (default) / `compact`. Persisted to `localStorage` (`ao:fleet-density`).
- Footer: `Showing X of Y · 已筛选: <active filters>` + reset link.

### 3.7 URL state

```
/fleet
  ?group=<team|status|stage|flat>       # default: team
  &status=<all|anomalies|paused|deprecated>   # default: all
  &window=<7d|30d|90d>                  # default: 7d
  &team=<comma-separated team ids>       # default: none
  &density=<comfortable|compact>         # default: comfortable
```

All state bookmarkable. Follows the URL-state pattern already in `/live` (`LiveContent.tsx`).

---

## 4. Widget migration map

This is the central deliverable of phase A. Every current `/fleet` widget gets one of three verdicts: `kept-redesigned`, `moved`, or `removed-from-fleet`.

| Current widget | Verdict | Destination | Notes |
|---|---|---|---|
| 6-card KPI strip (`m_active_agents`, `m_runs_24h`, `m_success_rate`, `m_hitl_queue`, `m_cost_today`, `m_anomalies`) | replaced | Fleet keeps 4 inline summary chips; full KPI strip belongs to `/overview` | `/overview` spec decides own layout. Do not pre-design it here. |
| Right-rail Alerts card (4 alerts) | removed-from-fleet | `/alerts` (canonical, already exists) | Fleet `Anomalies N` chip links there filtered. |
| Right-rail Activity feed | removed-from-fleet | `/events` stream tab (already exists) | No replacement on Fleet. |
| Right-rail Compliance card | removed-from-fleet | `/audit` or future `/compliance` | No replacement on Fleet. |
| Bottom Pipeline Strip (JR-2041) | removed-from-fleet | `/workflow` (already canonical for pipeline) | The current implementation in `FleetContent.tsx:352` is dead-weight on Fleet. |
| Per-row 24h sparkline | moved | `/fleet/[short]` Overview tab | Detail-page surface, not list. |
| Per-row 24h runs / P50 / cost | moved | `/fleet/[short]` Overview tab | Same. |
| Per-row Status pill | kept-redesigned | (stays in list) | Becomes dot + inline text, no background. |
| `AgentGlyph` rainbow | kept-redesigned | (stays) | Becomes single-color mono block. |

**Receiving pages get only a flag**, not a design: "Fleet 会把 X 移过来。" The receiving page's spec decides absorption.

---

## 5. `/fleet/[short]` detail page IA

### 5.1 Route

`/fleet/[short]` where `short` is the canonical agent short code (e.g. `req-analyzer`, `publisher`, `matcher`).

### 5.2 Page header band

| Element | Content |
|---|---|
| Identity | Glyph + name + role + status dot |
| Meta row | `Owner: <team> · <person>  ·  Version: vX.Y.Z  ·  Deployed: <date>  ·  Lifecycle: <state>` |
| Manage actions (right) | `Pause` / `Roll back` / `Reassign owner` / `Deprecate` — visible-but-disabled, unified tooltip "Manage 模块上线后启用". See §6. |

### 5.3 Tab bar

| # | Tab | This spec |
|---|---|---|
| 1 | **Overview** | Default. **Fully specced** (§5.4). |
| 2 | Versions | Sketch only — version history table with success-rate delta vs previous. |
| 3 | Runs | Sketch — embedded view of `/live` filtered to `?agent=<short>`. |
| 4 | Alerts | Sketch — embedded view of `/alerts` filtered to `?agent=<short>`. |
| 5 | Events | Sketch — event contracts this agent publishes / subscribes; deep link to `/events/[name]`. |
| 6 | Permissions & Data | Sketch — read-only inventory of scopes + data-source connections. |
| 7 | Audit | Sketch — `AGENT_*` audit events about this agent. |

Tabs 2–7 are **declared** in this spec so the navigation skeleton is committed; their full content moves to their own follow-up specs.

### 5.4 Overview tab (full content)

Two-column layout, ~60 / 40 split.

**Left column (primary):**

- **30d Health card** — large success-rate trend (line), P50 / P95 latency, cost-per-run, runs-per-day mini-chart.
- **Recent alerts (top 3)** — title, severity, started-at; "View all →" jumps to Alerts tab.
- **Recent runs (top 5)** — id, status, started, duration; "View all →" jumps to Runs tab.

**Right column (identity & relationships):**

- **Identity panel** — short, displayName, role, owner team, owner person, deployedAt, version, lifecycle.
- **Workflow position** — which workflow stage(s) this agent serves; link to `/workflow?node=<short>`.
- **Data sources** — read-only inventory (placeholder mock — full data model in Permissions spec).
- **Permissions** — read-only scope list (same caveat).

### 5.5 URL state

```
/fleet/[short]
  ?tab=<overview|versions|runs|alerts|events|perm|audit>   # default: overview
```

Tabs 3 (Runs) and 4 (Alerts) embed the existing pages and pass their URL state through (e.g. `/fleet/publisher?tab=runs&run=RUN-...`).

---

## 6. Manage placeholder strategy

To honor the "Monitor only, no Manage" memory constraint while still letting Fleet feel complete:

- The four Manage actions in the detail-page header (`Pause`, `Roll back`, `Reassign owner`, `Deprecate`) are rendered as **disabled buttons** with a single shared tooltip: `"Manage 模块上线后启用"`. This makes the surface area visible without committing to behavior.
- The `+ 部署智能体` button on `/fleet` list-page header is **kept** for visual completeness, but click opens a placeholder modal `"Behavior 模块未上线 — 现阶段请联系 RAAS"`. Routing this to a real Behavior wizard is the Behavior spec's job.
- **No** Manage-flavored content (create-draft form, deploy wizard, permission editor) goes anywhere else on Fleet or its detail page. Inventory is read-only.

This gives Manage / Behavior specs a clean plug-in path: replace the disabled buttons' handlers, replace the placeholder modal, no IA restructuring needed.

---

## 7. Backend / data contract gaps (flagged for the implementation plan)

These are real prerequisites but **not solved in this IA spec**. They will be addressed in the writing-plans phase.

| Gap | Why it matters | Likely approach |
|---|---|---|
| `/api/agents` returns 24h aggregates only; Fleet now needs 7d/30d trends | List column 3 (7d Health), detail Overview card (30d trend) | New aggregation endpoint `/api/agents/health-trend?window=…` |
| `AgentsResponse.agent` schema lacks `lifecycle` (active/paused/deprecated/draft), `deployedAt`, `ownerPerson` | Status taxonomy §3.5; detail meta row §5.2 | Extend `AgentSummary` Neo4j projection + API type |
| Agent's workflow position not exposed via API | Detail right-rail "Workflow position" panel | Derive from existing `WORKFLOW_META` server-side, or expose as a new field |
| Runs / Alerts tab embedding — iframe vs shared component | Detail tabs 3 & 4 | Lean toward extracting `<RunsList agentFilter={short} />` from `LiveContent` — same for alerts |

---

## 8. Acceptance criteria

This IA spec is considered correct if all of the following hold:

1. The `/fleet` list page contains **at most**: header (title, subtitle, time-window, filter, primary action), 4 inline summary chips, group / sort / filter controls, the 5-column grouped list, and a footer. **No** KPI cards, **no** activity feed, **no** pipeline strip, **no** alerts list, **no** compliance card.
2. Every datum currently visible on `/fleet` has an explicit verdict in the migration table (§4): kept-redesigned, moved (with destination), or removed-from-fleet.
3. `/fleet/[short]` declares all 7 tabs, with **Overview** fully specced (§5.4) and tabs 2–7 sketched at one-paragraph fidelity.
4. All Manage-flavored buttons are present-but-disabled with one shared gating mechanism (§6).
5. URL state is documented for both pages (§3.7, §5.5).
6. The spec makes **no** layout / IA decisions for `/overview`, `/events`, `/alerts`, `/audit`. Those pages are only flagged as receivers.

---

## 9. Non-goals

- Visual design (color, typography, exact spacing) — separate spec after IA approval.
- Implementation code — separate writing-plans phase.
- Receiving pages' redesigns — each has its own spec.
- Manage feature design (pause / rollback / reassign / deprecate behavior) — separate Manage spec.
- Behavior feature design (new-agent deployment wizard) — separate Behavior spec.
- `/fleet/[short]` tabs 2–7 full IA — separate detail-tab specs.
- Backend schema changes — flagged in §7, owned by writing-plans output.
