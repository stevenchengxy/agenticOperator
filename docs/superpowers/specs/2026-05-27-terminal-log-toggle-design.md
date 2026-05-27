# Terminal log toggle — `AO_TERMINAL_LOG`

**Date:** 2026-05-27
**Status:** Approved scope (Option 1), pending spec review.

## Problem

When Agentic Operator runs in a real deployment, the terminal floods with log
output — every agent step echoes its full request/response JSON, and every
external API call (RoboHire / Allmeta / partner-pg) prints a multi-line block.
This volume of stdout writes hurts runtime performance. We want a single,
documented environment variable to turn terminal log display on/off, and we
want production to be quiet by default.

## Key finding

The switch **already exists** but is undocumented and only half-wired:

- `lib/agent-logger.ts:61` — `const TERMINAL_LOG_ENABLED = process.env.AO_TERMINAL_LOG !== '0'`
  gates the per-step / per-API echo (the biggest flood source).
- `lib/external-api-log.ts:18` — `const TERMINAL_ENABLED = process.env.AO_TERMINAL_LOG !== '0'`
  gates the external-API echo.

Gaps:
1. `AO_TERMINAL_LOG` appears only in code comments — it is **not documented in
   `.env.example`** (only `AO_LOG_DIR` is, near line 91). Nobody deploying knows
   it exists.
2. The gate semantics are **duplicated** in two files with no shared source of
   truth.
3. Default is "on unless explicitly `=0`", so a production deploy is noisy
   unless the operator remembers to set the flag.

## Goal

One documented env var (`AO_TERMINAL_LOG`) that toggles terminal logging, with a
single source of truth for the gate, defaulting to **off in production** so
deploys are quiet without anyone remembering a flag.

## Decision: reuse `AO_TERMINAL_LOG`

Do **not** introduce a new variable name. The existing name is already honored
in two places; a second name would create drift and confusion.

### New semantics (centralized)

| Value of `AO_TERMINAL_LOG`        | Terminal logging |
| --------------------------------- | ---------------- |
| `0` / `false` / `off`             | disabled         |
| `1` / `true` / `on`               | enabled          |
| *unset*                           | enabled when `NODE_ENV !== 'production'`; **disabled in production** |

This is the one behavior change: today *unset-in-production* = on; after this
change *unset-in-production* = off. To get logs in a production process for
debugging, set `AO_TERMINAL_LOG=1`.

Value parsing is case-insensitive and tolerant (`0/false/off` vs `1/true/on`);
any other non-empty value is treated as "on".

## Components

### 1. New `lib/terminal-log.ts` (single source of truth)

Tiny, zero-dependency, matches the existing logger style (no pino/winston).

- `terminalLogEnabled: boolean` — evaluated once from `AO_TERMINAL_LOG` +
  `NODE_ENV` using the table above. (A function form `isTerminalLogEnabled()`
  is acceptable if lazy evaluation is cleaner; behavior is identical for a
  long-lived server process.)
- `tlog(...args: unknown[]): void` — thin gated wrapper: `if (terminalLogEnabled) console.log(...args)`.
  For informational, per-operation lines that should obey the switch.

### 2. `lib/agent-logger.ts`

Replace the local `TERMINAL_LOG_ENABLED` const (line 61) with an import from
`lib/terminal-log.ts`. `echoToTerminal()`'s early-return guard now reads the
shared value. Behavior is identical except for the new production default.

### 3. `lib/external-api-log.ts`

Replace the local `TERMINAL_ENABLED` const (line 18) with the same import. Same
behavior change.

### 4. Scattered informational `console.log` → `tlog`

Rule applied per call site (implementation reads each one):

- **Per-operation / chatty informational `console.log`** (e.g. partner-pg
  per-write success line, `lib/partner-pg/client.ts:236`) → `tlog`.
- **One-shot startup lines** (e.g. Inngest function-registration count in
  `server/inngest/functions.ts`, handler-rebuild notice in
  `app/api/inngest/route.ts:48`) → **leave as `console.log`**. One line at boot,
  useful, harmless to performance.
- **`console.error` / `console.warn`** → **never touched.** Production must keep
  surfacing failures and degradation warnings regardless of the switch.

### 5. `.env.example`

Add a documented entry for `AO_TERMINAL_LOG` near the existing `AO_LOG_DIR`
block: explain the accepted values and the production default, and note that
file logs (`logs/*.log`) are unaffected — only the terminal echo is gated.

## Out of scope (YAGNI)

- No npm logging library (pino / winston / debug).
- No log-level system.
- No gating of `console.error` / `console.warn`.
- No centralized env-validation / zod schema.
- File-based logging (`logs/*.log` via `AO_LOG_DIR`) is unchanged — this is
  purely about terminal stdout echo.

## Verification

No test suite is configured. Verify by:

1. `npm run build` — typechecks + lints clean.
2. Default dev (`npm run dev`) — per-step echo still prints (unchanged dev DX).
3. `AO_TERMINAL_LOG=0 npm run dev` — no per-step / per-API echo.
4. Simulated production (`NODE_ENV=production`, `AO_TERMINAL_LOG` unset) — quiet
   terminal; `console.error`/`console.warn` still appear.
5. `AO_TERMINAL_LOG=1` with `NODE_ENV=production` — echo restored.
