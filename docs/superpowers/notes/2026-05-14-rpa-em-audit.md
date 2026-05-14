# Resume-parser-agent EM audit — 2026-05-14

## Direct `step.sendEvent` call sites

All sends use Inngest's built-in `step.sendEvent()` (not `inngest.send()` or AO-main's
`em.publish()`). Call sites found in the core function files (scripts excluded):

| File | Line | Event emitted | Step key |
|------|------|---------------|----------|
| `lib/inngest/functions/resume-parser-agent.ts` | 230 | `RESUME_PROCESSED` | `'emit-resume-processed'` |
| `lib/inngest/agents/match-resume-agent.ts` | 295 | `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED` | dynamic `emit-match-${stepKey}` |
| `lib/inngest/agents/create-jd-agent.ts` | 345 | `JD_GENERATED` | dynamic `emit-jd-generated-${requisitionId}` |

Additionally, in scripts (not production code):
- `scripts/publish-test-event.ts:72` — `inngest.send()` for test injection
- `scripts/replay-screenshot-event.ts:41` — `client.send()` for test replay

The three production call sites are all `step.sendEvent()`, which is Inngest-native and
provides built-in deduplication and retry semantics within a function run. They do NOT
go through AO-main's EM (`server/em/publish.ts`), which means:
1. Events emitted by RPA bypass `EventInstance` persistence (no row written to AO's SQLite).
2. Events bypass the EM's schema validation (`server/em/validate.ts`).
3. Events bypass the EM's dedup key logic (`em.publish()` uses `causedBy` for idempotency).

## EM availability

AO-main has a full EM at `server/em/` with:
- `publish.ts` — `em.publish(eventName, payload, { causedBy })` writing `EventInstance` rows
- `validate.ts` — schema validation against `server/em/schemas/`
- `registry/` — event schema registry
- `persistence.ts` — SQLite writes via Prisma

There is **no `em/` directory** in `resume-parser-agent/`. RPA is a separate Next.js app with
its own `package.json` and no shared workspace/monorepo package linking. It cannot currently
import `@/server/em` from AO-main without a structural change.

## Recommended path

**Option A — Convert and import (best long-term, high effort)**
Move AO-main's `server/em/` into a shared package (e.g., `packages/ao-em`) and add RPA as a
workspace consumer. All three `step.sendEvent()` calls become `em.publish()` calls, gaining
`EventInstance` persistence and schema validation. Requires pnpm workspaces or similar.
Effort: ~1 sprint.

**Option B — Duplicate EM in RPA (medium effort, technical debt)**
Copy `server/em/publish.ts` + Prisma client into RPA. Gains `EventInstance` persistence for
RPA events but creates a second code path to maintain. Not recommended if monorepo merge
(Option C) is on the near-term roadmap.

**Option C — Defer until RPA merges back into AO-main (recommended for now)**
The `CLAUDE.md` and existing specs suggest AO-main and RPA will eventually merge (the
`agenticOperator/` root already has Inngest functions co-located). Until that merge, RPA
events will continue to bypass EM. This is an acceptable gap because:
- Inngest's `step.sendEvent()` still provides delivery + retry guarantees.
- The missing coverage is audit trails in `EventInstance`, not functional correctness.
- The merge will be cleaner if RPA isn't carrying a duplicated EM implementation.

**Immediate mitigation**: Add a comment to each `step.sendEvent()` call site noting that
it should be replaced with `em.publish()` post-merge. This prevents the pattern from
spreading further.
