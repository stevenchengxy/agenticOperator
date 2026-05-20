# AO Direct Dual-Write Migration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove AO's dependency on partner's RAAS HTTP API. Replace all 6 RAAS endpoint calls with direct dual-write to Partner Postgres (`192.168.1.103:5432/raas_db`) + Neo4j (via allmeta ontology API).

**Architecture:** AO becomes the authoritative writer for `candidate`, `job_posting`, `candidate_match_result`, etc. directly into partner's Postgres, mirroring the business logic from `raas_v4/backend/apps/api/src/modules/*.service.ts`. Side effects exclusive to partner UI (`hitl_task`, `notification_record`) are explicitly NOT replicated — partner must add DB-trigger or Inngest watcher on their side. Neo4j instance writes go via existing `lib/allmeta-client.ts` patterns (already used by rule-check).

**Tech Stack:** `pg` (node-postgres) for direct DB access · existing `lib/allmeta-client.ts` for Neo4j · TypeScript · Inngest agents in `server/inngest/agents/`.

**Reference source code (partner's, DO NOT MODIFY)**:
- `raas_v4/backend/apps/api/src/modules/jd/jd-sync.service.ts` — syncJdGenerated 5 steps
- `raas_v4/backend/apps/api/src/modules/candidates/candidates-main.hono.ts` — POST /candidates ingest
- `raas_v4/backend/apps/api/src/modules/matching/match-result-ingest.service.ts` — match-results
- `raas_v4/backend/apps/api/src/modules/requirements/requirements-main.hono.ts` — requirements detail
- `raas_v4/backend/apps/api/src/modules/requirements/requirements-agent-view.hono.ts` — agent-view (F2)

---

## File Structure

**New files:**
- `lib/partner-pg/client.ts` — pg connection pool singleton
- `lib/partner-pg/requirements.ts` — read job_requisition + spec + siblings
- `lib/partner-pg/job-posting.ts` — JD write (replaces syncJdGenerated)
- `lib/partner-pg/candidates.ts` — candidate/resume/application write (replaces saveCandidate)
- `lib/partner-pg/match-results.ts` — candidate_match_result write
- `lib/partner-pg/parsed-resume.ts` — fetch parsed resume by candidate+resume IDs (F1)
- `lib/partner-pg/agent-view.ts` — claimer requirements + filename fuzzy match (F2)
- `lib/partner-pg/types.ts` — shared TS types (mirrors of partner's Prisma model shapes)

**Modified files:**
- `server/inngest/agents/create-jd-agent.ts` — swap RAAS API calls for partner-pg
- `server/inngest/agents/resume-parser-agent.ts` — same
- `server/inngest/agents/match-resume-agent.ts` — same
- `server/inngest/agents/rule-check-agent.ts` — same
- `.env.local` — add `RAAS_POSTGRES_URL`, deprecate RAAS API vars
- `.env.example` — document new env

**Files to delete (after migration verified):**
- `lib/raas-api-client.ts`
- `lib/raas-internal.ts`
- `server/raas/internal-client.ts`

---

## ⚠️ Side Effects EXPLICITLY Skipped

Per user decision, AO will NOT replicate these partner-side side effects. Partner team must handle on their side (Postgres trigger or outbox watcher):

| Side effect | Where in partner code | Why AO skips |
|---|---|---|
| `hitl_task` row creation (jd_review) | `jd-sync.service.ts:309-365` | UI workflow concern, not AO's responsibility |
| In-app `notification_record` to HSM | `jd-sync.service.ts:244-307` | Same |
| HitlTask routing on candidate ingest | `processResumeIngest` chain | Same |
| Auto-invitation dispatcher trigger | `match-result-ingest.service.ts` | Reads from outbox event; partner can subscribe to AO's Inngest events instead |
| Outbox event publish (partner's outbox) | All write paths | AO emits via own Inngest; partner consumes from there |

**CRITICAL:** Before executing this plan, user must confirm with partner (zyj) that they accept these side effects being moved to partner's side. Without confirmation, partner's HSM/recruiter UI workflows will break silently.

---

## Chunk 1: Foundation (pg client + ontology writer)

### Task 1: Add `pg` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install pg**

```bash
npm install pg
npm install -D @types/pg
```

- [ ] **Step 2: Verify install**

Run: `node -e "console.log(require('pg').version)"`
Expected: prints a version string

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add pg for direct partner Postgres access"
```

---

### Task 2: Add `RAAS_POSTGRES_URL` env var

**Files:**
- Modify: `.env.local`
- Modify: `.env.example`

- [ ] **Step 1: Add to `.env.local`**

Add after the existing RAAS Inngest section:

```bash
# ─── Partner Postgres (direct dual-write, supersedes RAAS API write path) ──
# Per 2026-05-20 architecture decision: AO writes directly to partner's
# Postgres tables for candidate / job_posting / candidate_match_result, etc.
# Replaces POST /candidates, POST /jd/sync-generated, POST /match-results,
# GET /requirements/:id, GET /requirements/agent-view, GET /candidates/:id/resumes/:id/parsed
RAAS_POSTGRES_URL=postgresql://postgres:postgres@192.168.1.103:5432/raas_db
```

- [ ] **Step 2: Add to `.env.example`** (same block, with placeholder password)

- [ ] **Step 3: Verify connection from AO process**

Run:
```bash
node -e "const {Pool} = require('pg'); const p = new Pool({connectionString: process.env.RAAS_POSTGRES_URL}); p.query('SELECT count(*) FROM job_requisition').then(r => console.log('OK rows:', r.rows[0].count)).catch(e => console.error('FAIL:', e.message)).finally(() => p.end());" 2>&1
```
Expected: `OK rows: <some number>`

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "feat(env): add RAAS_POSTGRES_URL for direct partner DB writes"
```
(`.env.local` is gitignored — not staged.)

---

### Task 3: Create pg client singleton

**Files:**
- Create: `lib/partner-pg/client.ts`

- [ ] **Step 1: Write the module**

```ts
// lib/partner-pg/client.ts
//
// Connection pool to partner's Postgres at 192.168.1.103:5432/raas_db.
// Singleton — reuse across all agents and steps.
//
// Per 2026-05-20 dual-write decision: AO writes directly to partner's
// Postgres, replacing the RAAS HTTP API. See plans/2026-05-20-ao-direct-dual-write.md.

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.RAAS_POSTGRES_URL?.trim();
  if (!url) {
    throw new Error('[partner-pg] RAAS_POSTGRES_URL not set in env');
  }
  pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[partner-pg] idle client error', err.message);
  });
  return pool;
}

export function isPartnerPgConfigured(): boolean {
  return !!process.env.RAAS_POSTGRES_URL?.trim();
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as never);
}

/** Run a callback inside a transaction. Rolls back on throw. */
export async function withTx<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** Close pool — used by tests + graceful shutdown. */
export async function close(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

- [ ] **Step 2: Smoke test**

Create a one-off test script `scripts/smoke-partner-pg.mjs`:
```js
import { query, close } from '../lib/partner-pg/client.ts';
const r = await query('SELECT count(*)::int as n FROM job_requisition');
console.log('job_requisition rows:', r.rows[0].n);
await close();
```

Run: `npx tsx scripts/smoke-partner-pg.mjs`
Expected: prints count

- [ ] **Step 3: Delete smoke test, commit**

```bash
rm scripts/smoke-partner-pg.mjs
git add lib/partner-pg/client.ts
git commit -m "feat(partner-pg): add pg pool singleton + tx helper"
```

---

## Chunk 2: Read endpoints (replaces 3 RAAS GETs)

### Task 4: `getRequirementDetail` → direct SQL

**Files:**
- Create: `lib/partner-pg/requirements.ts`
- Create: `lib/partner-pg/types.ts`

**Partner source of truth:** `raas_v4/backend/apps/api/src/modules/requirements/requirements-main.hono.ts:417` → `requirementService.getRequirementDetail(requirementId)`. Reads `job_requisition` + LEFT JOIN `job_requisition_specification` + sibling requisitions. Per F4 doc, this is the canonical source for JD prompt building.

- [ ] **Step 1: Inspect partner's Prisma query**

```bash
grep -rn "getRequirementDetail\|jobRequisition.findUnique\|jobRequisition.findFirst" raas_v4/backend/apps/api/src/modules/requirements/ | head
```

Read the partner service code to get the exact field list + JOIN shape. Match its return shape.

- [ ] **Step 2: Write `lib/partner-pg/types.ts`**

Declare a `RequirementDetail` type matching the existing `RaasRequirement` + `RaasRequirementSpecification` shapes used in `server/inngest/agents/create-jd-agent.ts` and `rule-check-agent.ts`. Source of truth is partner's `raas_v4/backend/prisma/schema.prisma` JobRequisition model.

(Use Read to inspect the model, then mirror its field list.)

- [ ] **Step 3: Write `lib/partner-pg/requirements.ts`**

```ts
// lib/partner-pg/requirements.ts
import { query } from './client';
import type { RequirementDetail } from './types';

/**
 * GET job_requisition + LEFT JOIN job_requisition_specification by ID.
 * Mirror of partner's GET /api/v1/requirements/:id.
 *
 * Returns null if not found (4xx-equivalent — agent should throw NonRetriable).
 */
export async function getRequirementDetail(
  jobRequisitionId: string,
): Promise<RequirementDetail | null> {
  const r = await query<RequirementDetail>(
    `SELECT
       r.*,
       row_to_json(s.*) AS specification
     FROM job_requisition r
     LEFT JOIN job_requisition_specification s
       ON s.job_requisition_specification_id = r.job_requisition_specification_id
     WHERE r.job_requisition_id = $1
     LIMIT 1`,
    [jobRequisitionId],
  );
  return r.rows[0] ?? null;
}
```

- [ ] **Step 4: Manually verify against a real JR**

Pick a real `job_requisition_id` from partner DB:
```bash
docker run --rm postgres:16 psql "$RAAS_POSTGRES_URL" -c "SELECT job_requisition_id FROM job_requisition LIMIT 1;"
```

Then test query in node REPL:
```bash
npx tsx -e "import('./lib/partner-pg/requirements.ts').then(m => m.getRequirementDetail('<real-id>')).then(r => console.log(JSON.stringify(r, null, 2).slice(0, 500)));"
```

Expected: prints first 500 chars of the requirement detail. Verify `client_job_title`, `must_have_skills`, `specification.status` are present.

- [ ] **Step 5: Commit**

```bash
git add lib/partner-pg/types.ts lib/partner-pg/requirements.ts
git commit -m "feat(partner-pg): direct getRequirementDetail SQL"
```

---

### Task 5: `getParsedResume` → direct SQL (F1)

**Files:**
- Create: `lib/partner-pg/parsed-resume.ts`

**Partner source of truth:** `raas_v4/backend/apps/api/src/modules/candidates/candidates-main.hono.ts` → search for `parsed` route handler. Reads `resume.parsed_data` (JSON column) + optional `candidate_snapshot`.

- [ ] **Step 1: Locate partner's parsed-resume read**

```bash
grep -n "resumes/:resumeId/parsed\|resume.parsed_data\|parsed_data" raas_v4/backend/apps/api/src/modules/candidates/candidates-main.hono.ts
```

Read the handler. Identify which columns it returns.

- [ ] **Step 2: Write `lib/partner-pg/parsed-resume.ts`**

```ts
// lib/partner-pg/parsed-resume.ts
//
// F1: thin RESUME_PROCESSED → fetch parsed resume body.
// Mirrors GET /api/v1/candidates/:id/resumes/:resumeId/parsed.

import { query } from './client';

export type ParsedResumeResult = {
  candidate_id: string;
  resume_id: string;
  data: Record<string, unknown> | null; // RoboHire-shape parsed_data
  candidate_snapshot?: Record<string, unknown>;
  resume_meta?: Record<string, unknown>;
};

export async function getParsedResume(
  candidateId: string,
  resumeId: string,
): Promise<ParsedResumeResult | null> {
  // TODO: confirm exact column names from partner's resume model
  const r = await query<ParsedResumeResult>(
    `SELECT
       $1::text AS candidate_id,
       resume_id,
       parsed_data AS data
     FROM resume
     WHERE candidate_id = $1 AND resume_id = $2
     LIMIT 1`,
    [candidateId, resumeId],
  );
  return r.rows[0] ?? null;
}
```

- [ ] **Step 3: Manually verify**

Find a real candidate+resume pair:
```bash
docker run --rm postgres:16 psql "$RAAS_POSTGRES_URL" -c "SELECT candidate_id, resume_id FROM resume WHERE parsed_data IS NOT NULL LIMIT 1;"
```

Test query. Verify `data` contains the RoboHire-shape parsed fields.

- [ ] **Step 4: Commit**

```bash
git add lib/partner-pg/parsed-resume.ts
git commit -m "feat(partner-pg): direct getParsedResume (F1)"
```

---

### Task 6: `getRequirementsAgentView` → direct SQL with filename fuzzy match (F2)

**Files:**
- Create: `lib/partner-pg/agent-view.ts`

**Partner source of truth:** `raas_v4/backend/apps/api/src/modules/requirements/requirements-agent-view.hono.ts`. The fuzzy-match logic (filename → JR ID set) is per partner spec `2026-05-18-nextcloud-resume-jd-fuzzy-match`. This is the most complex of the 3 read paths — partner just wrote it 2 days ago.

- [ ] **Step 1: Read partner's full agent-view handler**

```bash
cat raas_v4/backend/apps/api/src/modules/requirements/requirements-agent-view.hono.ts
```

Identify: (a) the SQL filter for "claimer's active JRs", (b) the `【岗位名】` extraction regex, (c) the fuzzy match algorithm, (d) the zero-hit fallback (return all).

- [ ] **Step 2: Write `lib/partner-pg/agent-view.ts`**

Translate partner's logic 1:1. Include the zero-hit fallback. Match the return shape `{ items, page, page_size, total, total_pages }` from F2 doc.

- [ ] **Step 3: Verify with a real claimer**

```bash
docker run --rm postgres:16 psql "$RAAS_POSTGRES_URL" -c "SELECT recruiter_id FROM requirement_claim WHERE released_at IS NULL LIMIT 3;"
```

Test with and without `resume_filename`. With matching `【岗位名】` → narrowed list. Without / no match → full list (zero regression).

- [ ] **Step 4: Commit**

```bash
git add lib/partner-pg/agent-view.ts
git commit -m "feat(partner-pg): direct getRequirementsAgentView with filename fuzzy match (F2)"
```

---

## Chunk 3: Write endpoints (replaces 3 RAAS POSTs)

### Task 7: `syncJdGenerated` → direct SQL (3 writes)

**Files:**
- Create: `lib/partner-pg/job-posting.ts`

**Partner source of truth:** `raas_v4/backend/apps/api/src/modules/jd/jd-sync.service.ts:83-242`. Three writes per call:
1. UPDATE `job_requisition` SET (must_have_skills, ..., 17 fields) WHERE job_requisition_id = $1
2. UPSERT `job_posting` by job_requisition_id (compare existing, INSERT or UPDATE)
3. UPDATE `job_requisition_specification` SET status='pending_publish' WHERE id=$id AND status='draft' (compare-and-set)

**EXPLICITLY SKIPPED** (per "Side Effects" section above): notification_record, hitl_task INSERT.

- [ ] **Step 1: Re-read partner's syncJdGenerated for exact column list**

```bash
sed -n '83,242p' raas_v4/backend/apps/api/src/modules/jd/jd-sync.service.ts
```

Extract: field mapping (camelCase → snake_case), enum mapping (EDUCATION_MAP, EMPLOYMENT_TYPE_MAP, EXPERIENCE_LEVEL_MAP), salary range parse logic.

- [ ] **Step 2: Write `lib/partner-pg/job-posting.ts`**

Mirror all 3 writes inside a single `withTx()` transaction:

```ts
// lib/partner-pg/job-posting.ts
//
// Replaces RAAS POST /api/v1/jd/sync-generated. Mirror of partner's
// jd-sync.service.ts:syncJdGenerated, steps 1-3. Steps 4-5 (notification +
// hitl_task) are EXPLICITLY skipped per 2026-05-20 architecture decision —
// partner adds these via DB trigger or AO Inngest watcher.

import { randomUUID } from 'crypto';
import { withTx } from './client';
// ... (full code with enum maps copied from partner, transaction wrapper)
```

(Full code mirrors partner — too long to inline here. Use partner's file as reference.)

- [ ] **Step 3: Write JobPosting instance to Neo4j via allmeta**

After Postgres tx commits, call `writeOntologyInstance({ type: 'JobPosting', id: jobPostingId, ... })`. Reuse `lib/allmeta-client.ts` pattern from rule-check.

- [ ] **Step 4: Verify with a real JR**

End-to-end: pick a JR with status='draft', call `syncJdToPartnerPg(...)` with a sample JD payload. Verify:
- `job_posting` row created/updated with `publish_status='pending'`
- `job_requisition.must_have_skills` patched
- `job_requisition_specification.status` advanced `draft → pending_publish`
- Neo4j has JobPosting node

- [ ] **Step 5: Commit**

```bash
git add lib/partner-pg/job-posting.ts
git commit -m "feat(partner-pg): direct syncJdGenerated (3-write tx, no side effects)"
```

---

### Task 8: `saveCandidate` → direct SQL (most complex)

**Files:**
- Create: `lib/partner-pg/candidates.ts`

**Partner source of truth:** `raas_v4/backend/apps/api/src/modules/candidates/candidates-main.hono.ts:218` → `processResumeIngest` → `resumePipelineService`. **This is the largest port.** Touches Candidate + Resume + Application + dedup tables.

- [ ] **Step 1: Map partner's `processResumeIngest` data flow**

Read the full chain. Identify:
- Tables written: candidate, resume, application, candidate_runtime_state, ...?
- Dedup logic: by upload_id+etag → which table+column
- Required side effects we KEEP: pipeline state, parsed_data write
- Side effects we SKIP: outbox event publish, hitl_task creation

- [ ] **Step 2: Write `lib/partner-pg/candidates.ts`**

Implement `saveCandidateToPartnerPg(input)` mirroring partner's chain (minus skipped side effects). Wrap in `withTx()`.

- [ ] **Step 3: Also write Candidate instance to Neo4j via allmeta**

After Postgres commit, write Candidate node.

- [ ] **Step 4: Verify end-to-end**

Trigger from resumeParserAgent in dev — confirm Candidate + Resume + Application rows appear in partner DB + Neo4j.

- [ ] **Step 5: Commit**

```bash
git add lib/partner-pg/candidates.ts
git commit -m "feat(partner-pg): direct saveCandidate (Candidate/Resume/Application tx)"
```

---

### Task 9: `saveMatchResults` → direct SQL

**Files:**
- Create: `lib/partner-pg/match-results.ts`

**Partner source of truth:** `raas_v4/backend/apps/api/src/modules/matching/match-result-ingest.service.ts`. Per F3 doc, AO produces match results in 3 event flavors (MATCH_PASSED_NEED_INTERVIEW / MATCH_PASSED_NO_INTERVIEW / MATCH_FAILED) and these need to be persisted to `candidate_match_result` + `candidate_match_result_runtime_state` tables.

- [ ] **Step 1: Read partner's ingest service**

- [ ] **Step 2: Write `lib/partner-pg/match-results.ts`**

INSERT or UPSERT into `candidate_match_result`. SKIP auto-invitation dispatcher trigger (partner side-effect).

- [ ] **Step 3: Also write Candidate_Match_Result to Neo4j via allmeta**

This is the ONE entity AO already writes to Neo4j today (per memory `reference_dual_neo4j_instances.md` and recent commit `bef8ae8`). Reuse `lib/rule-check/neo4j-match-result-writer.ts`.

- [ ] **Step 4: Commit**

```bash
git add lib/partner-pg/match-results.ts
git commit -m "feat(partner-pg): direct saveMatchResults (+ existing Neo4j write)"
```

---

## Chunk 4: Per-agent integration

### Task 10: Refactor `createJdAgent`

**Files:**
- Modify: `server/inngest/agents/create-jd-agent.ts`

- [ ] **Step 1: Swap imports**

```diff
-import {
-  RaasApiError,
-  getRequirementDetail,
-  isRaasApiConfigured,
-  syncJdGenerated,
-  ...
-} from '@/lib/raas-api-client';
+import {
+  isPartnerPgConfigured,
+} from '@/lib/partner-pg/client';
+import { getRequirementDetail } from '@/lib/partner-pg/requirements';
+import { syncJdToPartnerPg } from '@/lib/partner-pg/job-posting';
```

- [ ] **Step 2: Replace config check** (`isRaasApiConfigured` → `isPartnerPgConfigured`)

- [ ] **Step 3: Replace `fetch-requirement-` step**

Old: `getRequirementDetail(requisitionId, { traceId })` returning `{ requirement, specification }`.
New: `getRequirementDetail(requisitionId)` returning the same shape (we matched it in Task 4).

- [ ] **Step 4: Replace `sync-jd-` step**

Old: `syncJdGenerated(input, { traceId })`.
New: `syncJdToPartnerPg(input)`.

- [ ] **Step 5: Remove `RaasApiError` references** — partner-pg throws plain `Error` + `NonRetriable` already-converted at call site.

- [ ] **Step 6: Test end-to-end**

Restart dev server. Send a `REQUIREMENT_LOGGED` event (or have partner re-send). Verify in Inngest dashboard → no ECONNREFUSED, run succeeds, job_posting row appears in partner DB.

- [ ] **Step 7: Commit**

```bash
git add server/inngest/agents/create-jd-agent.ts
git commit -m "refactor(create-jd-agent): use partner-pg direct write, drop RAAS API"
```

---

### Task 11: Refactor `ruleCheckAgent`

**Files:**
- Modify: `server/inngest/agents/rule-check-agent.ts`

Similar pattern — swap 3 imports (`getRequirementDetail`, `getRequirementsAgentView`, `getParsedResume`) for partner-pg equivalents.

- [ ] **Step 1: Swap imports & calls**
- [ ] **Step 2: Test end-to-end (F1 thin event + F2 filename match path B)**
- [ ] **Step 3: Commit**

---

### Task 12: Refactor `resumeParserAgent`

**Files:**
- Modify: `server/inngest/agents/resume-parser-agent.ts`

Swap `saveCandidate` for `saveCandidateToPartnerPg`.

- [ ] **Step 1: Swap import & call**
- [ ] **Step 2: Test end-to-end with a real upload**
- [ ] **Step 3: Commit**

---

### Task 13: Refactor `matchResumeAgent`

**Files:**
- Modify: `server/inngest/agents/match-resume-agent.ts`

Swap `saveMatchResults` for partner-pg + ensure F3 envelope (fields flattened to top) is still correct (already done per existing code, just verify).

- [ ] **Step 1: Swap import & call**
- [ ] **Step 2: Test end-to-end — verify partner's auto-invitation dispatcher picks up the AO-emitted event**
- [ ] **Step 3: Commit**

---

## Chunk 5: Cleanup

### Task 14: Remove RAAS API client modules

**Files:**
- Delete: `lib/raas-api-client.ts`
- Delete: `lib/raas-internal.ts`
- Delete: `server/raas/internal-client.ts`
- Modify: `.env.local`, `.env.example` — remove `RAAS_API_BASE_URL`, `RAAS_INTERNAL_API_URL`, `AGENT_API_KEY`, `RAAS_AGENT_API_KEY`

- [ ] **Step 1: Verify no remaining imports**

```bash
grep -rn "raas-api-client\|raas-internal\|RAAS_API_BASE_URL\|RAAS_INTERNAL_API_URL" server/ lib/ --include="*.ts" | grep -v partner-pg
```
Expected: empty (or only test files which can be updated/deleted in same task).

- [ ] **Step 2: Delete files, clean env**

- [ ] **Step 3: Run typecheck**

`npm run build` — expect zero errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove RAAS HTTP API client, fully migrated to partner-pg"
```

---

## Verification Matrix (run after all tasks complete)

| Trigger | Event | Expected outcome |
|---|---|---|
| Partner sends `REQUIREMENT_LOGGED` | createJdAgent runs | `job_posting` row in partner DB with `publish_status='pending'`; JD_GENERATED emitted on AO Inngest |
| Partner sends `RESUME_DOWNLOADED` | resumeParserAgent runs | `candidate` + `resume` + `application` rows in partner DB; RESUME_PROCESSED emitted |
| Partner sends `RESUME_PROCESSED` (thin) | ruleCheckAgent runs | Calls partner-pg `getParsedResume`, `getRequirementsAgentView` (F1+F2); emits MATCH_RULE_CHECK_PASSED or FAILED |
| `MATCH_RULE_CHECK_PASSED` | matchResumeAgent runs | RoboHire match-resume → `candidate_match_result` row in partner DB + Neo4j; MATCH_PASSED_* or MATCH_FAILED emitted with flat top-level fields (F3) |

---

## Out of Scope (NOT in this plan)

- Replicating partner's HitlTask creation (jd_review, candidate_review)
- Replicating partner's in-app NotificationRecord writes
- Replicating partner's auto-invitation dispatcher
- Migrating away from `lib/robohire-client.ts` (already direct, no change needed)
- Changes to AO's own SQLite Prisma schema (`prisma/schema.prisma`)
- Changes to AO's UI (Monitor page, Fleet page, etc.)
