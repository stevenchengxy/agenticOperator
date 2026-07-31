# Agentic Operator · 智能体操作中枢

> An operations console for AI recruitment agents — monitor, orchestrate and debug fleets of agents from one screen.

[![Next.js](https://img.shields.io/badge/Next.js-16.2-black)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19.2-149ECA)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org)
[![Tailwind](https://img.shields.io/badge/Tailwind-4.2-06B6D4)](https://tailwindcss.com)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-private-lightgrey)]()

---

## What is this?

Agentic Operator is a **mission-control UI** for a fleet of AI agents that automate enterprise recruitment — from job-requirement intake to JD generation, multi-channel sourcing, resume parsing, candidate matching, AI interviewing, evaluation and final delivery to the customer. It is built for the human Ops team that *supervises* this fleet: HSMs (delivery leads), recruiters, platform engineers and compliance.

The product treats the recruitment pipeline as an **event-driven workflow** in the [Inngest](https://www.inngest.com) style:

```
REQUIREMENT_SYNCED → ANALYSIS_COMPLETED → JD_GENERATED → CHANNEL_PUBLISHED
       → RESUME_DOWNLOADED → MATCH_PASSED → AI_INTERVIEW_COMPLETED
       → EVALUATION_PASSED → PACKAGE_APPROVED → APPLICATION_SUBMITTED
```

Each transition is an event; each event has publishers, subscribers, retry policy, SLA and audit trail. The console makes that fabric **legible at a glance** — what's running, what's stuck, where money is being spent, what humans need to approve next.

This repository is the **operator console + agent runtime** — a Next.js app that:

- Renders the full operator UI (Fleet / Workflow / Monitor / Events / Rule Check / Alerts / Tracing Chatbot)
- Hosts the actual Inngest agent functions (`server/inngest/agents/*`) — JD generation, resume parsing, rule check, candidate matching — that consume events and call RoboHire / LLM gateway / Neo4j / Postgres
- Exposes ~30 read APIs under `app/api/*` for the UI to query runs, events, audits, candidates
- Bridges with the partner RAAS Postgres + Inngest + MinIO over LAN

What started as a frontend mock is now a working end-to-end agent platform. Frontend-only mode (no backend env configured) still works for visual review — every external integration fails soft with a warning banner instead of crashing.

---

## Why does it exist?

Recruitment-process-outsourcing (RPO) teams running AI agents face four problems no off-the-shelf observability tool solves cleanly:

1. **Heterogeneity.** A single hire touches a Workday-style ATS, four job boards, two LLM vendors, a vector DB, a meeting scheduler, and a customer portal. None of those tools know about each other; the Ops team holds the model in their heads.
2. **Mixed initiative.** Most steps are agent-driven, but JD approval, recommendation-package review, and clarification on incomplete requirements are **human-in-the-loop**. A purely-AI dashboard hides the human queue; a purely-human ticket tool hides the agent activity.
3. **Cost control.** Token spend, vendor API rate limits, and channel fees compound quickly. Finance wants per-customer, per-job, per-agent breakdowns in near real time.
4. **Compliance & audit.** EEO, PII handling, candidate consent, and customer NDAs are non-negotiable. Every event must be traceable, every model decision explainable, every override logged.

Agentic Operator answers all four with one IA: **events as the universal substrate**, six purpose-built views that pivot on those events, and a strict design system so dense data stays readable.

---

## The console views

| Path | Audience | What you do here |
|---|---|---|
| `/fleet` | All Ops | Mission control — KPI strip, agent table, alert rail, activity feed, compliance scorecard, pipeline funnel. Default landing page. |
| `/workflow` | Platform engineers | Visual orchestration. SVG topology of all 24+ agents + 30+ events, color-coded by deployment status (real / shell / conceptual). |
| `/monitor` | On-call recruiters | Run-level execution view — live runs, status filter chips, expand any run to see step trace + token usage + AI summary. DLQ tab + 5s timeout banner when event engine is unhealthy. |
| `/events` | Engineers / Auditors | Event bus — three tabs: live stream (SSE), DLQ, **candidate tracking** (per-candidate pipeline progress + JR linkage). Direction chip on every row: 📥 received vs 📤 published. |
| `/rule-check` | Compliance / Recruiters | Two layers: rule×audit grid Dashboard (full ontology set + dead-rule badges) + Audits list with rich detail drawer (User Prompt / Rule Flags / LLM Response / Instances tabs). |
| `/alerts` | On-call | Unified alerts feed (SLA + DLQ + infra + behavior). Severity facets, ack workflow. |
| `/chat` | All Ops | Tracing chatbot full-screen page — natural language Q&A across runs / events / audits / candidates. Backed by 7 read-only tools (no raw Cypher/SQL). Also available as a floating bubble on every page. |
| `/entities/[type]/[id]` | Recruiters | Per-entity journey — pipeline progress ribbon (7 stages) + per-event timeline. |
| `/datasources` | Platform / Compliance | All external connectors — ATS, job boards, LLM vendors, vector DB, messaging, storage, identity. Health, throughput, field mappings. |
| `/audit` | Compliance | Read-only audit log of every AuditLog (Manage axis writes) + agent activity. |

Every view shares one **AppBar** (logo, breadcrumbs, ⌘K command palette, realtime status pill, **language switcher (中文 / EN)**, **theme toggle (light / dark)**, alerts bell, avatar) and one **LeftNav** grouped by Operate / Build / Govern.

---

## Design language

Visual identity is intentionally **dense, calm and instrument-like** — closer to a Bloomberg terminal than a SaaS marketing dashboard. Three principles:

- **OKLCH color space** for tokens. Gives perceptually uniform shifts between light and dark themes with one variable redefinition.
- **Tabular numerals everywhere** money, latency or counts appear, so columns align without explicit widths.
- **One accent color**. Status is communicated by `ok / warn / err / info` semantic tokens; the accent (default deep blue) is reserved for selection and key calls-to-action.

Tokens live in [`app/globals.css`](./app/globals.css); Tailwind utilities (`bg-surface`, `text-ink-2`, `border-line`, `bg-accent-bg`, …) are aliases that read those variables. Dark mode flips by setting `data-theme="dark"` on `<html>` — every component recolors automatically.

Typography: Inter for UI, JetBrains Mono for IDs / latency / payloads / event names.

---

## Architecture

```
app/
  layout.tsx              wraps tree in AppProvider (lang + theme + i18n)
  page.tsx                redirects / → /fleet
  <route>/page.tsx        thin: <Shell><FooContent /></Shell>
  api/
    inngest/route.ts      Inngest serve adapter — registers all agent functions
    inngest-admin/        proxies to Inngest dev /v0/gql + /v1/* (runs, events, DLQ)
    monitor/              /monitor aggregations (overview, queue, failures)
    events/               candidate-tracking aggregation + SSE stream
    ontology/rules/       allmeta-backed rule list (with JSON fallback)
    rule-check-audits/    audit list + detail + replay
    chat/trace/           tracing chatbot — POST, SSE streaming + tool loop
    agents/[short]/chat/  agent-scoped chatbot
    manage/runs/[id]/     cancel · pause · replay (writes + AuditLog)
    alerts/               unified alerts (SLA + DLQ + infra + behavior)
    behavior/             read MONITOR_ALERT rows for /alerts feed
    allmeta/              instance read-through to Studio API
components/
  shared/                 Shell, AppBar, LeftNav, CommandPalette, atoms, Ic
  fleet/ workflow/ monitor/ events/ rule-check/ entity/ chat/ alerts/
  manage/                 ConfirmActionModal (typed-keyword gate)
server/
  inngest/
    client.ts             inngest SDK client
    functions.ts          allFunctions = real + stub + behavior
    agents/
      resume-parser-agent.ts   RESUME_DOWNLOADED → RESUME_PROCESSED
      create-jd-agent.ts       REQUIREMENT_LOGGED → JD_GENERATED
      rule-check-agent.ts      RESUME_PROCESSED → MATCH_RULE_CHECK_*
      match-resume-agent.ts    MATCH_RULE_CHECK_PASSED → MATCH_*
      monitor-agent.ts         Behavior axis — cron, 6 detection rules
      manager-agent.ts         Behavior axis — auto-response decisions
      stub-factory.ts          synthesize stub agents for un-deployed wsIds
    raas-bridge.ts        pull events FROM partner Inngest INTO AO
  em/                     EventManager — em.publish, sync worker, registry
  llm/
    gateway.ts            pickGateway() — AI_BASE_URL/AI_API_KEY routing
  clients/                neo4j, ws, em
  manage/audit.ts         AuditLog writer for Manage axis
lib/
  chat/                   tool layer + types + system prompt + useGlobalChat hook
  rule-check/             runner, ontology-source, prompt, llm, audit-writer
  partner-pg/             direct Postgres writes (replaces RAAS HTTP API)
  events/                 pipeline-stages, event-direction classifier
  monitor/                aggregations, run-token-usage
  allmeta-client.ts       Studio API + name resolution
  inngest-admin-client.ts Inngest dev GraphQL/REST wrapper (with 5s timeout)
  i18n.tsx                AppProvider + zh/en dictionary
  workflow-graph-meta.ts  canonical workflow topology (24 nodes, derived edges)
prisma/
  schema.prisma           Prisma models (WorkflowRun, EventInstance, RuleCheckAudit,
                          BehaviorAlert, AuditLog, AgentEpisode, ...)
  migrations/
```

Every route is `"use client"` because theme / language / command palette / SSE chat are browser state. The API routes under `app/api/*` are server-side (Prisma + Inngest + LLM calls). Inngest agent functions live in `server/inngest/agents/` and consume events emitted by `em.publish` + bridged from partner RAAS.

For a more detailed working contract see [CLAUDE.md](./CLAUDE.md).

---

## Tech stack

**Frontend**
- Next.js 16.2 (App Router · Turbopack) · React 19.2 · Node ≥ 22
- TypeScript 5 strict · Tailwind CSS 4.2 (CSS-first config, OKLCH tokens)
- React Context + custom flat-dictionary i18n with localStorage persist
- Inline SVG icon set (zero icon-library dependency)

**Backend (in-process — same Next app)**
- [Inngest](https://www.inngest.com) v4.3 — event-driven agent runtime; dev server runs as `inngest-cli` natively on the host
- [Prisma](https://www.prisma.io) 7 + **local Postgres** (driver adapter `@prisma/adapter-pg`; migrated from SQLite on 2026-05-28) — `WorkflowRun`, `EventInstance`, `RuleCheckAudit`, `BehaviorAlert`, `AuditLog`, the `inngest_*_archive` durability mirror, 36 models total
- **Inngest archiver** (`scripts/inngest-archiver.ts`, `npm run archive`) — standalone poller that mirrors Inngest events/runs/step-traces into Postgres so monitoring survives an Inngest crash; reads go Postgres-first / live-fallback via `lib/inngest-source.ts`
- [OpenAI SDK](https://github.com/openai/openai-node) routed via OpenAI-compatible gateway (new-api proxy in dev) → Gemini / GPT / etc.
- [Neo4j JS driver](https://neo4j.com/developer/javascript/) — two instances (AO-local + RAAS-shared)
- [MinIO client](https://github.com/minio/minio-js) — partner shared S3-compatible object store
- Vitest + happy-dom for unit tests (~150 tests across chat / events / workflow / ontology)

**External integrations**
- Partner RAAS Postgres (direct dual-write) + RAAS Inngest (event bridge in/out)
- [Allmeta Ontology Studio](https://github.com/yuhancheng/allmetaOntology) (HTTP, port 3500) — rule + entity instance source of truth
- [RoboHire](https://robohire.io) — production resume parser + match-resume backend

---

## Getting started

### Minimum (frontend-only) — render the UI, no agents fire

```bash
npm install
cp .env.example .env.local        # required by Prisma client init even in UI-only mode
npx prisma generate
npm run dev                       # port 3002, NOT 3000
```

Open <http://localhost:3002> — you'll land on `/fleet`. All pages render with empty data; integration warnings show inline (e.g. "事件引擎暂时不可达").

Use the language toggle (中文 / EN) and theme toggle (sun / moon) top-right. Press **⌘K** anywhere for the command palette.

### Architecture

```
              ┌──────────────────────────────────────┐
              │  Shared Inngest (Docker container)   │
              │  ONE for everyone                    │
              └──────────────────────────────────────┘
                ▲                                  ▲
                │ register                         │ register
                │                                  │
       ┌──────────────────┐             ┌──────────────────┐
       │ AO (this repo)   │             │ RAAS services    │
       │ /api/inngest     │             │ /api/inngest     │
       └──────────────────┘             └──────────────────┘
                │
                │ HTTP (no direct Neo4j needed)
                ▼
       ┌──────────────────┐             ┌──────────────────┐
       │ Allmeta Studio   │ ──bolt──→  │ Neo4j            │
       │ (HTTP API:3500)  │             │                  │
       └──────────────────┘             └──────────────────┘
```

- **ONE shared Inngest** — partner ops a dockerized Inngest; AO + RAAS both register with it. No bridge, no per-app Inngest.
- **Allmeta is the only Neo4j path** — AO calls Studio over HTTP, Studio owns the Neo4j connection. AO does not need bolt:// credentials.
- **Other partner systems** (Postgres for dual-write, MinIO for resume files, RoboHire for parsing) are direct integrations — set URL + key only if you use them.

### Deployment — full step-by-step

For production or deployment onto another machine, use the single maintained
[Docker Compose deployment and operations guide](./docs/deploy/deployment.md). It includes
durable Postgres/Inngest/log volumes, split archiver/sweeper services, health
checks, backup/restore and a fail-fast environment preflight.

The steps below are the local source-development workflow. Follow in order and
skip optional steps only if you're sure you don't need that feature.

#### Step 1 · Install AO + one-shot setup

```bash
git clone <repo>
cd agenticOperator
npm install
cp .env.example .env.local         # then edit it — fill in every MUST section (1–8)
npm run setup                      # env check + prisma generate + db push
```

`npm run setup` is idempotent — safe to re-run after editing `.env.local`. It does:

1. **Node ≥ 22 check** — refuses to continue on older Node (nvm install 22).
2. **`.env.local` scaffold** — copies `.env.example` if missing.
3. **Env preflight** — prints a `✓ / ✗` table of required + recommended vars; flags placeholder values like `<shared-inngest-host>`.
4. **`data/` + `logs/` dirs** — auto-creates so the migration source + agent-logger don't error.
5. **`prisma generate`** — emits the Prisma Client to `./node_modules/.prisma`.
6. **`prisma db push`** — syncs all 36 tables to the local Postgres straight from `prisma/schema.prisma`. **No migrations folder** — the schema is the source of truth. Requires Postgres up first (`npm run pg:up`).

> **Local Postgres + archiver.** `npm run dev` provisions all of this automatically (Postgres via Docker, schema push, archiver). Manual equivalent:
> ```bash
> npm run pg:up                    # local Postgres on :5433 (Docker, volume ao-pgdata)
> npx prisma db push               # sync 36 tables
> npm run db:migrate-from-sqlite   # optional: copy legacy data/ao.db → Postgres (idempotent)
> npm run archive                  # Inngest durability mirror (or let `npm run dev` auto-start it)
> ```

Values you'll need from your team:
- Shared Inngest URL + event/signing keys (`INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`)
- LLM gateway URL + API key (`AI_BASE_URL` + `AI_API_KEY`, or fallback `OPENAI_API_KEY`)
- Allmeta Studio URL + token (`ALLMETA_BASE_URL`, `ALLMETA_API_KEY`)
- RoboHire API key (`ROBOHIRE_API_KEY`)
- Partner Postgres connection string (`RAAS_POSTGRES_URL`)
- MinIO endpoint + access keys (`MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`)

#### Step 2 · Verify the Postgres DB

```bash
docker ps | grep ao-postgres       # container on host port 5433
npx prisma studio                  # GUI to browse the 36 tables (optional)
```

To wipe and start over (loses local data):
```bash
npm run db:reset                   # prisma db push --force-reset
```

> **Common error: `Cannot find module 'dotenv/config'` when running `npx prisma db push` manually.**
> Cause: `npm install --omit=dev` or `NODE_ENV=production npm install` was used and skipped the dotenv install. Fix: run plain `npm install` so all dependencies land, then re-run `npm run setup`.

#### Step 3 · Verify partner Postgres schema exists

AO writes business data directly into partner's Postgres via `lib/partner-pg/`. The schema is **owned and maintained by the RAAS team** — AO assumes these tables already exist. Without them, rule-check + match-resume will fail with "relation does not exist" errors.

Required tables on partner side:
- `candidate`
- `candidate_match_result`
- `candidate_match_result_runtime_state`
- `job_posting`
- `job_requisition`
- `resume`
- `resume_upload_runtime`

Sanity check:
```bash
psql "$RAAS_POSTGRES_URL" -c "\dt candidate*"
psql "$RAAS_POSTGRES_URL" -c "\dt resume*"
```

If any table is missing, coordinate with the RAAS team to deploy their schema migration before continuing.

#### Step 4 · Run Allmeta Ontology Studio

Studio is a separate Next.js app in `~/allmetaOntology/apps/studio`. It owns the Neo4j connection — AO calls Studio over HTTP, never touches Neo4j directly.

```bash
cd ~/allmetaOntology/apps/studio
npm install
cp .env.example .env.local         # Studio has its own env
# Edit .env.local with the Neo4j URL/user/password
npm run dev                        # Studio on :3500
```

Health check from AO's machine:
```bash
curl http://<studio-host>:3500/api/v1/ontology/actions
# 200 (with data) or 401 (auth required) means Studio is up
```

Without Studio, rule-check falls back to the bundled `lib/rule-check/rules.json` (older snapshot), candidates / JRs show as raw IDs in the chatbot, and the audit drawer's live snapshot panel stays empty.

#### Step 5 · Connect to the shared Inngest

Either:
- Use partner's existing shared Inngest (recommended): set `INNGEST_*` in `.env.local` to point at it
- OR run a local `inngest-cli` for solo dev: `node_modules/.bin/inngest-cli dev --host 0.0.0.0 &`

Health check:
```bash
curl http://<inngest-host>:8288/health
# 200 means the Inngest dev server is up
```

#### Step 6 · (Optional) Local Neo4j for audit graph features

99% of AO works without direct Neo4j — only one niche feature (rule-check writing audit nodes via bolt://) uses it. Skip this step unless you need it.

```bash
docker run -d --name ao-neo4j \
  -p 7475:7474 -p 7688:7687 \
  -e NEO4J_AUTH=neo4j/testpassword123 \
  neo4j:5
```

Then uncomment §9 in `.env.local` with the same credentials.

#### Step 7 · Start AO Next dev server

```bash
npm run dev                        # port 3002
```

Open <http://localhost:3002> — you'll land on `/fleet`. Check `/monitor` to see infrastructure status.

#### Step 8 · Register AO's SDK with the shared Inngest

The Inngest server needs to know AO's SDK URL so it can call back with events. One-time:

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"url":"http://<this-machine-ip>:3002/api/inngest"}' \
  http://<inngest-host>:8288/fn/register
```

Verify in Inngest dashboard at `http://<inngest-host>:8288/apps` — you should see `agentic-operator-main` with 5+ functions listed.

#### Step 9 · Trigger a test event

From the Inngest dashboard "Send event" panel, fire a `REQUIREMENT_LOGGED` (full pipeline trigger) or `RESUME_DOWNLOADED` (triggers rule-check directly). Watch `/monitor` populate with run records, then drill into one to see the trace.

### Register the AO SDK with Inngest

After Next dev is up, the shared Inngest needs to know AO's SDK URL. Three ways:

1. **Inngest dashboard** (easiest) — visit `<shared-inngest-url>/apps`, click "Sync new app", enter the SDK URL (`http://<ao-machine-ip>:3002/api/inngest`).
2. **`/fn/register` POST** — see command above.
3. **PUT to SDK** — `curl -X PUT http://localhost:3002/api/inngest` triggers the SDK to push its function metadata to Inngest.

Re-run after: adding a new agent, changing a trigger event name, or whenever Inngest's app catalogue is wiped (e.g. memory-mode restart).

### Configuration cheatsheet

`.env.example` is the canonical template:

| Tier | Section | What happens if missing |
|---|---|---|
| **MUST** | 1. Persistence (SQLite) | AO won't boot |
| optional | 2. Logger dir | defaults to `./logs`, auto-created |
| **MUST** | 3. Shared Inngest | Agents can't register / dispatch |
| **MUST** | 4. LLM gateway | rule-check + chatbot show "未配置" banner |
| **MUST** | 5. Allmeta Studio | rule-check falls back to bundled rules.json; candidate displays raw ID |
| **MUST** | 6. RoboHire | resume parsing + match-resume fail per-call |
| **MUST** | 7. Partner Postgres | dual-write fails — no candidate / match data lands on partner side |
| **MUST** | 8. MinIO | RESUME_DOWNLOADED stalls at the parser — no candidate downstream |
| Rarely | 9. Direct Neo4j (bolt://) | one niche rule-check audit graph feature inactive; everything else still works |
| Rarely | 10. P3 sidecars | only needed if running legacy WS/EM as separate services |

The `npm run setup` script's preflight (and `server/init.ts`'s boot probe) prints a `✓ / ✗` table of every required + recommended var on first load. Placeholder values like `<shared-inngest-host>` or `replace-with-…` count as missing.

---

## Internationalization

Two locales ship today: **简体中文 (zh)** and **English (en)**. The dictionary is a flat object in [`lib/i18n.tsx`](./lib/i18n.tsx); add a key under both locales and call `t("your_key")`. Nothing more.

Domain-specific copy that's mock-data only (e.g. customer names like "字节跳动", agent names like "ReqSync") is intentionally kept in the page components — only UI chrome and labels go through `t()`. This keeps the dictionary lean and lets the recruitment domain stay verbatim.

The user's choice is persisted to `localStorage` under `ao:lang`. First-load default is auto-detected from `navigator.language`.

---

## Theming

Light / dark themes share the same component code. Switching is one attribute on `<html>`:

```ts
document.documentElement.setAttribute("data-theme", "dark");
```

The dark block in `globals.css` redefines the same `--c-*` variable names with darker OKLCH values. Every Tailwind utility, every inline `style={{ background: "var(--c-line)" }}`, and every SVG fill via `currentColor` recolors automatically. The user's choice is persisted to `localStorage` under `ao:theme`.

---

## Roadmap

The shapes you see today are deliberately implementation-ready — no feature is mocked at lower fidelity than it would ship. The work to turn this into production:

- **Event bus.** Wire `lib/events-catalog.ts` to a real Inngest deployment (or self-hosted Temporal/Kafka). Replace the `setInterval` live-stream with SSE/WebSocket.
- **Agent runtime.** Hook the agent table on `/fleet` and the swimlane on `/live` to LangGraph (or whatever runtime ships). The schema here is `Run` + `Span` + `Event`.
- **Connector integrations.** Replace the 24 hard-coded sources on `/datasources` with a manifest pulled from the platform.
- **Alerts engine.** Today's alerts are static; future is rule definitions evaluated by Prometheus / SQL DSL with feishu / wecom / email webhook fan-out.
- **Workflow editor.** `/workflow` currently renders a fixed graph. Migrate to [React Flow](https://reactflow.dev) for drag-edit-publish.
- **Auth + multi-tenant.** Workspace switcher, role-based view access, audit log.
- **Mobile read-only view.** Alerts + Live ops on a phone for on-call.

---

## Documentation

**[`docs/README.md`](./docs/README.md) is the documentation index — start there.**
Docs are grouped by purpose, and each topic has exactly one current document;
superseded ones are moved to `docs/archive/` or carry a banner pointing at their
replacement.

| Topic | Entry point |
|---|---|
| **Deploy to another machine** | [`docs/deploy/deployment.md`](./docs/deploy/deployment.md) — the single maintained deployment guide |
| Event & agent architecture | [`docs/architecture/`](./docs/architecture) |
| Rule check | [`docs/rule-check/`](./docs/rule-check) |
| RAAS / partner integration | [`docs/raas/`](./docs/raas) · [`docs/api/`](./docs/api) |
| Allmeta / Neo4j ontology | [`docs/ontology/`](./docs/ontology) |
| Design docs per change (dated) | [`docs/superpowers/specs/`](./docs/superpowers/specs) |

## Repository layout

| Path | Purpose |
|---|---|
| [`app/`](./app) | Next.js App Router — one folder per route, plus `api/` route handlers |
| [`components/`](./components) | UI components, grouped by route + `shared/` |
| [`lib/`](./lib) | Domain logic — i18n provider, event catalog, rule-check, partner-pg, mappers |
| [`server/`](./server) | Agent runtime — Inngest functions, event-manager schemas |
| [`scripts/`](./scripts) | Setup, deployment preflight, archiver, one-off operational tools |
| [`prisma/`](./prisma) | `schema.prisma` — AO's own Postgres schema |
| [`docs/`](./docs) | All documentation — see [`docs/README.md`](./docs/README.md) |
| [`design_handoff_agentic_operator/`](./design_handoff_agentic_operator) | Original design references — **reference only, do not import** |
| [`app/globals.css`](./app/globals.css) | OKLCH design tokens (light + dark) — **there is no `tailwind.config.ts`**; Tailwind v4 config lives in this file's `@theme inline` block |
| [`CLAUDE.md`](./CLAUDE.md) | Contract for AI coding agents touching this repo |
| [`.env.example`](./.env.example) | Local development env template (annotated, section-by-section) |
| [`.env.deploy.example`](./.env.deploy.example) | Production/Docker deployment env template |

---

## License

Private — internal use only. Not licensed for external distribution.

---

<sub>Built from the *Agentic Operator* design handoff package by Claude Design. Visual style by the design team; engineering by you and your favorite agent.</sub>
