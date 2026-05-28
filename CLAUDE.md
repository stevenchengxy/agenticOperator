# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — runs `scripts/dev-bootstrap.mjs` (provisions Postgres + Inngest, pushes schema, starts the archiver) then the dev server on **port 3002** (not 3000).
- `npm run build` — production build. Use this to surface TypeScript errors; `next build` runs typecheck + lint.
- `npm run start` — serve the production build on port 3002.
- `npm run lint` — `next lint`.
- `npm test` — vitest run. `npm run test:watch` for watch mode.

### Data layer (local Postgres) + Inngest archive

- `npm run pg:up` / `pg:down` / `pg:logs` — local Postgres on **port 5433** (5432 is the partner `raas-postgres-dev`). Container `ao-postgres`, named volume `ao-pgdata` (durable). Conn string in `DATABASE_URL` (default `postgresql://ao:ao_local_pw@localhost:5433/ao`).
- `npm run db:push` — sync `prisma/schema.prisma` to Postgres. `db:reset` — `prisma db push --force-reset`. `db:studio` — Prisma Studio.
- `npm run db:migrate-from-sqlite` — one-time copy of the legacy SQLite `data/ao.db` into Postgres (idempotent).
- `npm run archive` — standalone Inngest archiver (mirrors Inngest events/runs/step-traces into Postgres for durability). `dev` auto-starts it; gate with `ARCHIVE_ENABLED=0`.
- See [docs/superpowers/specs/2026-05-28-local-postgres-inngest-archive-design.md](docs/superpowers/specs/2026-05-28-local-postgres-inngest-archive-design.md).

## Stack

Next.js 16.2 (App Router · Turbopack default) · React 19.2 · Tailwind CSS v4.2 · TypeScript 5 · `engines.node: ">=22"`. Backend: Prisma 7 → **local Postgres** (driver adapter `@prisma/adapter-pg`), Inngest (event engine / agent runtime), Neo4j (via Allmeta), MinIO, OpenAI-compatible LLM gateway. Tests: vitest. API: App Router Route Handlers under `app/api/`.

## Architecture

**Agentic Operator** — a control-plane UI + runtime for AI recruitment agents. The UI chrome is still mock-data-driven in places, but there is a real backend: Route Handlers in `app/api/`, agent functions in `server/inngest/`, persistence in Postgres via Prisma (`server/db/index.ts`), and external integrations (RAAS partner Postgres, Allmeta/Neo4j, MinIO, RoboHire).

### Monitoring data flow + durability

The Inngest dev server (`:8288`) is the live source of truth for runs/events/traces. `lib/inngest-archive/` mirrors that into Postgres via the polling archiver; `lib/inngest-source.ts` resolves monitor reads **Postgres-first with live fallback** (`MONITOR_READ_SOURCE=auto|postgres|live`). Monitor route handlers under `app/api/inngest-admin/*` import from `inngest-source`, not `inngest-admin-client`, so they survive an Inngest outage.

### Top-level shape

`app/layout.tsx` wraps the entire tree in `AppProvider` from [lib/i18n.tsx](lib/i18n.tsx). Every route is a thin client component (`"use client"`) that renders `<Shell>` + a `*Content` component. **The `Shell` is the single source of chrome** (AppBar, LeftNav, CommandPalette, direction tag) — page files only pass `crumbs` and the direction tag string.

```
app/<route>/page.tsx   ← thin: returns <Shell crumbs={...}><FooContent /></Shell>
components/<route>/    ← all the real markup lives here
components/shared/     ← Shell + AppBar + LeftNav + CommandPalette + atoms + Ic
lib/i18n.tsx           ← AppProvider: lang (zh/en) + theme (light/dark) + t(key)
lib/events-catalog.ts  ← 28-event Inngest-style catalog used by /events
```

Routes implemented: `/fleet` (Direction A), `/workflow` (B), `/live` (C), `/events` (D), `/alerts`, `/datasources`. `/` redirects to `/fleet`.

### Design system — read this before styling anything

Visual identity is defined as **OKLCH CSS variables (`--c-*`) in [app/globals.css](app/globals.css)**. There is **no `tailwind.config.ts`** — Tailwind v4's config lives in CSS, in the `@theme inline { --color-bg: var(--c-bg); ... }` block at the top of `globals.css`. The `inline` keyword is load-bearing: it makes Tailwind utilities reference the runtime CSS variables instead of inlining literal values, so flipping `data-theme="dark"` on `<html>` recolors the entire app without a rebuild. The dark block in `globals.css` redefines the same `--c-*` variable names.

Practical consequence: never hardcode colors. Use Tailwind utilities (`bg-surface`, `border-line`, `text-ink-1`, `text-ok`, `bg-accent-bg`) **or** inline `style={{ background: "var(--c-ok)" }}`. Both auto-respond to theme changes. The `oklch(...)` fragments scattered through page components (e.g. `oklch(0.5 0.14 75)` for the warn ink) are intentional — they're shades that don't have token slots and were copied 1:1 from the design references.

When adding a new color/font/radius token: add it once under `@theme inline` (Tailwind utility binding) and once under `:root` + `[data-theme="dark"]` (light/dark values). PostCSS plugin is `@tailwindcss/postcss` (v4 — `tailwindcss` is no longer the PostCSS entry point).

The atoms in [components/shared/atoms.tsx](components/shared/atoms.tsx) (`StatusDot`, `Spark`, `Metric`, `Badge`, `Btn`, `Card`, `CardHead`) and the `.tbl` class in `globals.css` cover ~all repeated chrome. Reach for those before inventing one-off styled divs.

Icons live in [components/shared/Ic.tsx](components/shared/Ic.tsx) as a flat object (`Ic.search`, `Ic.bolt`, …). The `IcName` type is the union of keys — pages that pass icons through props (palette items, nav items) accept `IcName` strings rather than rendered nodes, then look them up.

### i18n

`useApp()` exposes `{ t, lang, setLang, theme, setTheme }`. The dictionary is two flat objects in [lib/i18n.tsx](lib/i18n.tsx) — when adding a string, add it under both `zh` and `en`. Keys are short and namespaced by area (`nav_*`, `m_*` for metrics, `wf_*` for workflow, `em_*` for events, `agent_*`, `evt_*`, etc.). `lang` and `theme` are persisted to `localStorage` under `ao:lang` / `ao:theme`.

Domain copy that's mock-data-only (e.g. agent names like "ReqSync", customer names like "字节跳动") is intentionally hardcoded in the page components — only UI chrome and labels go through `t()`.

### Design references

`design_handoff_agentic_operator/` contains the original handoff package: a README spec, `styles.css` (token source of truth), and Babel-transpiled-in-browser JSX prototypes for each direction. **Do not import from this folder** — it's reference material. When extending a page, the corresponding `direction-*.jsx` or `page-*.jsx` file is the visual ground truth.

### Reading a page component

Each `*Content.tsx` follows the same skeleton:

1. Mock data declared at the top (or imported from `lib/`).
2. Sub-header / KPI strip.
3. 2- or 3-column CSS grid for the body (typical `gridTemplateColumns: "232px 1fr 320px"`).
4. Local sub-components for cards, rows, etc., kept in the same file unless reused across routes.

The Workflow page ([components/workflow/WorkflowContent.tsx](components/workflow/WorkflowContent.tsx)) is the one exception with non-trivial logic: nodes + edges are positioned on a `1620×560` SVG viewBox and edges are computed from node coordinates. If you reposition nodes, the edges follow automatically.
