# Candidate Lock — RMHR Alignment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
> **AO rule:** work on `main` (no worktrees). Commit only via `git commit -- <files>` pathspec (pre-commit hook re-stages everything). Commit only when the user asks.

**Goal:** Align AO with the company RMHR `uploadByRecruiterEmail` lock interface so candidate-lock ownership is refreshed at every real upload — fixing the stale-lock bug — without enforcing anything until the scaffold is proven and partner deliverables land.

**Architecture:** New `lib/candidate-lock/` module with a clean ①persist / ②check split: a dumb `LockPersistencePort` (zero branching), a single `LockResolver` seam (`rmhr-client.ts`, the only file that knows the company contract), a pure `decide()` gate, and `classify.ts` reusing dependency-health. The lock concern is wired at the **resume-parser ingestion seam** (file bytes only exist there), gating both downstream announcers — but inert behind four default-OFF flags.

**Tech Stack:** TypeScript, Next.js App Router, Inngest agents, Prisma (local Postgres), partner Postgres (raw SQL via `lib/partner-pg`), Allmeta/Neo4j ontology, vitest.

**Spec:** [docs/superpowers/specs/2026-06-08-candidate-lock-rmhr-alignment-design.md](../specs/2026-06-08-candidate-lock-rmhr-alignment-design.md)

**Test command:** `npx vitest run <path>` (single file) · `npm test` (all) · `npm run build` (typecheck).

**Outcome model (applies throughout):** the lock-check step yields exactly one of — `proceed` / `lock-only` (业务: 他人锁/保护/黑名单) / **故障失败** (infra: RMHR down, network, gateway error, `data.model` parse-fail, unresolvable recruiterEmail; **reason=故障**). 故障失败 is a real, recorded, classified failure (never silently swallowed): dark-launch logs it without blocking; enforcement parks+retries on it. Never treat 故障 as success; never guess/empty `recruiterEmail`.

---

## Chunk 0: P0 — pure AO scaffold (all flags OFF, zero behavior change)

Lands first, depends on nothing external. Every later partner deliverable becomes a config/value drop, not new wiring.

### Task 1: Lock vocabulary (`types.ts`)

**Files:**
- Create: `lib/candidate-lock/types.ts`

- [ ] **Step 1: Write the types** (no test — pure type declarations)

```typescript
// lib/candidate-lock/types.ts
// Vendor-agnostic candidate-lock vocabulary. No IO, no imports from rmhr-client.

/** RMHR lockState scale — the literal 1/2/3 ONLY. Blacklist is a SEPARATE branch. */
export enum LockState {
  FREE = 1,
  LOCKED = 2,
  PROTECTED = 3,
}

/** Normalized result of one RMHR uploadByRecruiterEmail call (model parsed). */
export interface LockSnapshot {
  rmhrResumeId: string;          // model.resumeId, stringified — cross-system correlation key
  lockState: LockState;
  blacklisted: boolean;          // company dedup returned a blacklist branch
  lockByEmployeeId: string | null;  // model.lockBy (工号)
  lockByName: string | null;
  lockByEmail: string | null;    // model.lockByEmail — the comparison key
  lockTime: string | null;       // model.lockTime RAW "yyyy-MM-dd HH:mm:ss" (NOT coerced to Date)
  message: string | null;
}

/** Pure gate verdict over a SUCCESSFUL snapshot. 'park'/'fail' come from the error path, not decide(). */
export type LockDecision = 'proceed' | 'lock-only';

/** Why the lock-check step ended — recorded on every attempt. */
export type LockOutcomeReason =
  | 'owned-by-uploader'       // proceed
  | 'newly-locked'            // proceed (was FREE)
  | 'locked-by-other'         // 业务: lock-only
  | 'protected'               // 业务: lock-only
  | 'blacklisted'             // 业务: lock-only
  | 'infra-fault'             // 故障失败 (recorded as failure)
  | 'email-unresolvable';     // 故障失败 (data problem, recorded as failure)

/** What the dumb persistence port writes. Pre-computed; port does NOT derive anything. */
export interface LockRecord {
  candidateId: string;
  rmhrResumeId: string | null;
  lockState: number | null;        // LockState numeric, or null when no successful snapshot
  blacklisted: boolean;
  lockOwnerEmployeeId: string | null;
  lockByName: string | null;
  lockByEmail: string | null;
  lockTime: string | null;         // RAW string
  message: string | null;
  requestedByEmail: string | null; // who WE tried to lock under (distinct from owner)
  decision: LockDecision | 'fault';
  reason: LockOutcomeReason;
}
```

- [ ] **Step 2: Typecheck** — Run: `npm run build` · Expected: no new TS errors referencing `lib/candidate-lock/types.ts`.
- [ ] **Step 3: Commit** — `git commit -- lib/candidate-lock/types.ts -m "feat(candidate-lock): lock vocabulary types"`

---

### Task 2: Pure gate (`decide.ts`) — highest-value, fully testable, zero IO

**Files:**
- Create: `lib/candidate-lock/decide.ts`
- Test: `lib/candidate-lock/decide.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// lib/candidate-lock/decide.test.ts
import { describe, it, expect } from 'vitest';
import { decide, normalizeEmail } from './decide';
import { LockState, type LockSnapshot } from './types';

const base: LockSnapshot = {
  rmhrResumeId: '10086', lockState: LockState.LOCKED, blacklisted: false,
  lockByEmployeeId: '0006006934', lockByName: '李四',
  lockByEmail: 'lisi@company.com', lockTime: '2026-03-06 15:30:00', message: null,
};

describe('decide', () => {
  it('FREE → proceed (we just locked it)', () => {
    expect(decide({ ...base, lockState: LockState.FREE }, 'lisi@company.com').decision).toBe('proceed');
  });
  it('LOCKED by uploader → proceed', () => {
    expect(decide(base, 'lisi@company.com').decision).toBe('proceed');
  });
  it('LOCKED by uploader, case/space-insensitive → proceed', () => {
    expect(decide(base, '  LiSi@Company.com ').decision).toBe('proceed');
  });
  it('LOCKED by other → lock-only', () => {
    const r = decide(base, 'wangwu@company.com');
    expect(r.decision).toBe('lock-only');
    expect(r.reason).toBe('locked-by-other');
  });
  it('PROTECTED → lock-only', () => {
    expect(decide({ ...base, lockState: LockState.PROTECTED }, 'lisi@company.com').reason).toBe('protected');
  });
  it('blacklisted → lock-only regardless of lockState', () => {
    expect(decide({ ...base, blacklisted: true }, 'lisi@company.com').reason).toBe('blacklisted');
  });
});
```

- [ ] **Step 2: Run, verify it fails** — Run: `npx vitest run lib/candidate-lock/decide.test.ts` · Expected: FAIL (`decide` not exported).

- [ ] **Step 3: Minimal implementation**

```typescript
// lib/candidate-lock/decide.ts
import { LockState, type LockSnapshot, type LockDecision, type LockOutcomeReason } from './types';

export function normalizeEmail(e: string | null | undefined): string {
  return (e ?? '').trim().toLowerCase();
}

/** Pure gate over a SUCCESSFUL snapshot. Caller handles 故障/park separately. */
export function decide(
  snap: LockSnapshot,
  recruiterEmail: string,
): { decision: LockDecision; reason: LockOutcomeReason } {
  if (snap.blacklisted) return { decision: 'lock-only', reason: 'blacklisted' };
  if (snap.lockState === LockState.PROTECTED) return { decision: 'lock-only', reason: 'protected' };
  if (snap.lockState === LockState.FREE) return { decision: 'proceed', reason: 'newly-locked' };
  // LOCKED
  const mine = normalizeEmail(snap.lockByEmail) === normalizeEmail(recruiterEmail)
    && normalizeEmail(recruiterEmail) !== '';
  return mine
    ? { decision: 'proceed', reason: 'owned-by-uploader' }
    : { decision: 'lock-only', reason: 'locked-by-other' };
}
```

- [ ] **Step 4: Run, verify pass** — Run: `npx vitest run lib/candidate-lock/decide.test.ts` · Expected: PASS (6 tests).
- [ ] **Step 5: Commit** — `git commit -- lib/candidate-lock/decide.ts lib/candidate-lock/decide.test.ts -m "feat(candidate-lock): pure lock-gate decide()"`

---

### Task 3: Channel-code mapping (`resume-source-map.ts`) — pure, placeholder table

**Files:**
- Create: `lib/rmhr/resume-source-map.ts`
- Test: `lib/rmhr/resume-source-map.test.ts`

> The literal company code table is a PARTNER deliverable. P0 ships a placeholder map + a default + the resolution logic so wiring is done; partner fills `CHANNEL_CODE_MAP` later.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/rmhr/resume-source-map.test.ts
import { describe, it, expect } from 'vitest';
import { resolveResumeSourceId } from './resume-source-map';

describe('resolveResumeSourceId', () => {
  it('maps a known channel label to its company code', () => {
    expect(resolveResumeSourceId('BOSS直聘-AI')).toBe('02001034');
  });
  it('falls back to the default code for null', () => {
    expect(resolveResumeSourceId(null)).toBe(resolveResumeSourceId('某个绝不会命中的渠道'));
  });
  it('trims/normalizes the label before lookup', () => {
    expect(resolveResumeSourceId('  BOSS直聘-AI ')).toBe('02001034');
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run lib/rmhr/resume-source-map.test.ts` · Expected: FAIL.

- [ ] **Step 3: Minimal implementation**

```typescript
// lib/rmhr/resume-source-map.ts
// PARTNER DELIVERABLE: full company resumeSourceId code list + label→code mapping.
// P0 ships only the one known code + the default; partner extends CHANNEL_CODE_MAP.
export const DEFAULT_RESUME_SOURCE_ID = '02001034'; // TODO(partner): confirm a real "其他/未知来源" default that does NOT trigger data.code 1001

const CHANNEL_CODE_MAP: Record<string, string> = {
  'boss直聘-ai': '02001034',
  // TODO(partner): 猎聘 / 智联 / 前程无忧 / LinkedIn / 脉脉 / 人才库-AI ...
};

export function resolveResumeSourceId(aoChannel: string | null | undefined): string {
  const key = (aoChannel ?? '').trim().toLowerCase();
  return CHANNEL_CODE_MAP[key] ?? DEFAULT_RESUME_SOURCE_ID;
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run lib/rmhr/resume-source-map.test.ts` · Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -- lib/rmhr/resume-source-map.ts lib/rmhr/resume-source-map.test.ts -m "feat(rmhr): resumeSourceId channel-code mapping (placeholder table)"`

---

### Task 4: Register `rmhr` in dependency-health + api-log

**Files:**
- Modify: `lib/dependency-health/types.ts` (the `DepProvider` union)
- Modify: `lib/external-api-log.ts` (the `ApiLogCategory` union + color switch)

> First READ both files to confirm the exact union names/locations (probe reported `DepProvider = 'robohire'|'llm'` and `ApiLogCategory` ~line 40).

- [ ] **Step 1: Add `'rmhr'` to `DepProvider`** in `lib/dependency-health/types.ts` so `reportDependencyDegraded` accepts RMHR. One-line union extension; verify no exhaustive `switch` on `DepProvider` breaks (fix any to handle `'rmhr'`).
- [ ] **Step 2: Add `'rmhr'` to `ApiLogCategory`** in `lib/external-api-log.ts` and a `categoryColor` case (mirror the `robohire` case).
- [ ] **Step 3: Typecheck** — `npm run build` · Expected: no errors; if a `switch` became non-exhaustive, handle the `'rmhr'` case.
- [ ] **Step 4: Commit** — `git commit -- lib/dependency-health/types.ts lib/external-api-log.ts -m "feat(candidate-lock): register rmhr in dependency-health + api-log"`

---

### Task 5: RMHR client (`rmhr-client.ts`) — the ② seam, two-layer response

**Files:**
- Create: `lib/candidate-lock/rmhr-client.ts`
- Test: `lib/candidate-lock/rmhr-client.test.ts`

> Mirror `lib/robohire-client.ts` (multipart FormData + AbortSignal.timeout + error class). CANNOT reuse its single-layer JSON handler — RMHR is two-layer and `data.model` is a JSON string.

- [ ] **Step 1: Write the failing test** (parse-only, fetch mocked)

```typescript
// lib/candidate-lock/rmhr-client.test.ts
import { describe, it, expect } from 'vitest';
import { parseRmhrResponse, RmhrApiError } from './rmhr-client';
import { LockState } from './types';

const ok = {
  code: 200, msg: 'success', timestamp: 1,
  data: { code: 1000, msg: '操作成功', success: true,
    model: JSON.stringify({ resumeId: 10086, lockState: 2, lockBy: '0006001111',
      lockByName: '王五', lockByEmail: 'wangwu@company.com', lockTime: '2026-03-01 10:00:00',
      message: '重复简历，已被他人锁定' }) },
};

describe('parseRmhrResponse', () => {
  it('parses the two-layer success + JSON-string model into a snapshot', () => {
    const s = parseRmhrResponse(ok);
    expect(s.rmhrResumeId).toBe('10086');
    expect(s.lockState).toBe(LockState.LOCKED);
    expect(s.lockByEmail).toBe('wangwu@company.com');
    expect(s.lockTime).toBe('2026-03-01 10:00:00'); // RAW, not Date
  });
  it('throws BUSINESS RmhrApiError on data.code 1001 (邮箱不存在/解析失败)', () => {
    const biz = { code: 200, msg: 'success', timestamp: 1,
      data: { code: 1001, msg: '招聘邮箱不存在，不入库', success: false, model: null } };
    expect(() => parseRmhrResponse(biz)).toThrow(RmhrApiError);
    try { parseRmhrResponse(biz); } catch (e) { expect((e as RmhrApiError).code).toBe('BUSINESS'); }
  });
  it('throws infra (non-BUSINESS) when model is unparseable', () => {
    const bad = { code: 200, msg: 'success', timestamp: 1,
      data: { code: 1000, msg: 'ok', success: true, model: '{not json' } };
    try { parseRmhrResponse(bad); } catch (e) { expect((e as RmhrApiError).code).not.toBe('BUSINESS'); }
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run lib/candidate-lock/rmhr-client.test.ts` · Expected: FAIL.

- [ ] **Step 3: Implement** `parseRmhrResponse` (pure, exported for test) + `RmhrApiError` + `uploadByRecruiterEmail` (does the fetch). `parseRmhrResponse`: if `data.code === 1001` → `throw new RmhrApiError('BUSINESS', data.msg)`; if `data.code === 1000` → `JSON.parse(data.model)` (guard string), map to `LockSnapshot` (stringify resumeId, map lockState numeric → enum, blacklisted from message/branch); parse failure or missing model → infra `RmhrApiError`. `uploadByRecruiterEmail({file, filename, recruiterEmail, resumeSourceId})`: build `FormData` (`file` Blob + `recruiterEmail` + `resumeSourceId`), header `X-Internal-Api-Key` from `config()` (`RMHR_INTERNAL_HOST` + `RMHR_INTERNAL_API_KEY` + `RMHR_TIMEOUT_MS`, throw if missing), `fetch` with `AbortSignal.timeout`, `res.ok` guard (else infra throw), route through `logApiCall('rmhr', ...)`, then `parseRmhrResponse`. `RmhrApiError extends Error { httpStatus, code: 'CLIENT'|'RATE_LIMITED'|'QUOTA_EXHAUSTED'|'SERVER'|'NETWORK'|'BUSINESS', businessCode?, requestId? }`.

- [ ] **Step 4: Run, verify pass** — `npx vitest run lib/candidate-lock/rmhr-client.test.ts` · Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -- lib/candidate-lock/rmhr-client.ts lib/candidate-lock/rmhr-client.test.ts -m "feat(candidate-lock): RMHR client + two-layer response parsing"`

---

### Task 6: Error classifier (`classify.ts`)

**Files:**
- Create: `lib/candidate-lock/classify.ts`
- Test: `lib/candidate-lock/classify.test.ts`

- [ ] **Step 1: Write the failing test** — assert: `BUSINESS` RmhrApiError → a typed BUSINESS outcome (NOT a dependency degrade, no park); gateway non-2xx / `NETWORK` / `SERVER` / parse-empty → an infra outcome that maps to a dependency-health `DepReason` (recoverable → park; auth → NonRetriable). The `instanceof` MUST test `RmhrApiError` (not `RobohireApiError`).
- [ ] **Step 2: Run, verify fail** — `npx vitest run lib/candidate-lock/classify.test.ts`.
- [ ] **Step 3: Implement** `classifyRmhr(op, errOrSnapshot)` reusing `lib/dependency-health` types (`DepReason`, `reportDependencyDegraded`), returning a discriminated `{ ok: true } | { ok: false, reason: 'infra-fault'|'email-unresolvable', depReason, recoverable }`. **故障 is a failure** — this function never maps an infra error to "success".
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -- lib/candidate-lock/classify.ts lib/candidate-lock/classify.test.ts -m "feat(candidate-lock): RMHR error classifier (故障 vs 业务)"`

---

### Task 7: Extend `CandidateLock` Prisma model (AO-owned migration)

**Files:**
- Modify: `prisma/schema.prisma` (model `CandidateLock`, ~line 145)

> AO-owned local Postgres, zero existing readers/writers — safe to migrate without partner sign-off.

- [ ] **Step 1: Edit the model** — relax `expiresAt` to `DateTime?`; add `lockState Int?`, `blacklisted Boolean @default(false)`, `lockOwnerEmployeeId String?`, `lockByName String?`, `lockByEmail String?`, `lockTime String?` (RAW), `rmhrResumeId String?`, `lockMessage String?`, `requestedByEmail String?`, `lastCheckedAt DateTime?`, `lockReason String?`, `source String?`. Add `@@index([candidateId, rmhrResumeId])`. Re-evaluate `@@index([clientId, expiresAt])` (see open question — keep for now).
- [ ] **Step 2: Push schema** — Run: `npm run db:push` · Expected: success, `CandidateLock` altered.
- [ ] **Step 3: Verify Prisma client typegen** — `npm run build` · Expected: `prisma.candidateLock` exposes new fields, no errors. Keep `server/db/index.test.ts` green (new columns are nullable/defaulted).
- [ ] **Step 4: Commit** — `git commit -- prisma/schema.prisma -m "feat(candidate-lock): extend CandidateLock with RMHR lock fields"`

---

### Task 8: Dumb persistence port (`persistence-port.ts` + `index.ts`)

**Files:**
- Create: `lib/candidate-lock/persistence-port.ts`, `lib/candidate-lock/index.ts`
- Test: `lib/candidate-lock/persistence-port.test.ts`

- [ ] **Step 1: Write the failing test** — `persistLock(record)` does a single unconditional upsert into `prisma.candidateLock` keyed on `(candidateId, rmhrResumeId)`, writing exactly the fields handed in; it does NOT call `decide()`, RMHR, read flags, or re-derive. (Use a prisma mock or test DB per existing repo test pattern — check `server/db/index.test.ts`.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `persistLock(record: LockRecord): Promise<void>` — one upsert, zero branching. `index.ts` re-exports types/decide/rmhr-client/classify/persistence-port.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -- lib/candidate-lock/persistence-port.ts lib/candidate-lock/index.ts lib/candidate-lock/persistence-port.test.ts -m "feat(candidate-lock): dumb persistence port"`

---

### Task 9: `employee_id → email` resolver (code now; SQL pending partner confirm)

**Files:**
- Create: `lib/partner-pg/employee.ts`
- Test: `lib/partner-pg/employee.test.ts`

> Pattern after an existing partner-pg query helper (e.g. `lib/partner-pg/recruiting-jobs.ts`). **Column names are a partner confirmation** — mark with `TODO(partner)`. Inert in P0 (no caller until P3).

- [ ] **Step 1: Write the failing test** — `resolveRecruiterEmail(employeeId)` returns `{ email, name }` on a row; returns `null` on no-row OR null/empty email (caller must fail-OPEN, never fabricate). Mock the partner-pg `query`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `SELECT email, name FROM employee WHERE employee_id = $1 LIMIT 1` (`TODO(partner): confirm table/column names emp/email`), small `globalThis` Map cache (10-min positive / short negative TTL, HMR-safe like the pool), null on missing/empty.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -- lib/partner-pg/employee.ts lib/partner-pg/employee.test.ts -m "feat(partner-pg): employee_id→email resolver (column names TODO partner)"`

---

### Task 10: Phone-primary dedup behind `DEDUP_PHONE_PRIMARY` (flag OFF)

**Files:**
- Modify: `lib/partner-pg/candidates.ts` (`normalizeMobile` ~77-81; dedup tiers ~238-260)
- Test: `lib/partner-pg/candidates.dedup.test.ts` (new, or extend existing dedup test)

> READ the current tiers first. Change is **flag-gated**; email+name fallback tier MUST stay untouched (it closed the 2026-05-26 merge bug).

- [ ] **Step 1: Failing tests** — with `DEDUP_PHONE_PRIMARY` on: (a) same strong mobile + different name → ONE candidate (phone-only tier); (b) `<11`-digit / missing mobile → does NOT hit phone tier, falls to email+name guard; (c) placeholder name `未命名候选人` never merges via phone tier. With flag off: behavior identical to today.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — tighten `normalizeMobile` to require ≥11 digits / return last-11 + `isStrongMobile`; when flag on AND strong mobile → primary tier `WHERE mobile_normalized = $1 ORDER BY created_at ASC LIMIT 1` (drop `AND name`); keep email+name fallback EXACTLY; set `needs_mobile_review = (mobile_normalized IS NULL)`; apply partner `normalizeName` to residual name compares.
- [ ] **Step 4: Run, verify pass** + `npm test` (no regressions in existing candidates tests).
- [ ] **Step 5: Commit** — `git commit -- lib/partner-pg/candidates.ts lib/partner-pg/candidates.dedup.test.ts -m "feat(partner-pg): phone-primary dedup behind DEDUP_PHONE_PRIMARY flag"`

> **Before flipping the flag in any env:** dry-run COUNT of rows whose dedup decision changes (the ≥7-but-<11 now-rejected set), via existing partner-pg read paths — no ad-hoc probe scripts.

---

### Task 11: Wire the ingestion seam — INERT (all flags OFF)

**Files:**
- Modify: `server/inngest/agents/resume-parser-agent.ts` (new step after save-candidate ~300; gate at announcers ~412-425)
- Modify: `.env.example`

> Wire the structure so flipping a flag activates it — but with flags OFF the path is byte-identical to today.

- [ ] **Step 1: Add the step skeleton** — new `step.run('rmhr-lock-check', ...)` placed after save-candidate, before `processedPayload`. Body: if `LOCK_CHECK_ENABLED !== '1'` → return `{ decision: 'proceed', reason: 'newly-locked' }` immediately (inert). Legacy `parsedFromEvent` path (no bytes) → also return `proceed`. (Real call body added in P3.)
- [ ] **Step 2: Gate the announcers** — wrap BOTH `step.sendEvent('emit-resume-processed', …)` AND `notifyRecruitmentLifecycle(…)` at ~412-425 in `if (lockDecision !== 'lock-only') { … }`. With `LOCK_CHECK_ENABLED` off, `lockDecision` is always `proceed` → both still fire (no behavior change).
- [ ] **Step 3: Document flags + env** in `.env.example` — `LOCK_CHECK_ENABLED`, `CANDIDATE_LOCK_PG_WRITE`, `DEDUP_PHONE_PRIMARY`, `RESUME_SOURCE_MAP_ENABLED` (all OFF/absent), `RMHR_INTERNAL_HOST`, `RMHR_INTERNAL_API_KEY`, `RMHR_TIMEOUT_MS`, `DEFAULT_RESUME_SOURCE_ID`.
- [ ] **Step 4: Verify no behavior change** — `npm run build`; run the resume-parser agent test(s) — Expected: identical to baseline (flags off). Confirm `retries:0` still on the function.
- [ ] **Step 5: Commit** — `git commit -- server/inngest/agents/resume-parser-agent.ts .env.example -m "feat(candidate-lock): wire ingestion seam (inert, flags off)"`

---

### Task 12: P0 integration sanity

- [ ] **Step 1:** `npm test` — all green.
- [ ] **Step 2:** `npm run build` — typecheck + lint clean.
- [ ] **Step 3:** Confirm zero behavior change: with all flags absent, resume ingestion path is identical to baseline (no RMHR call, both announcers fire, no CandidateLock writes).

---

## Chunk 1: P1–P4 — gated outlines (detail when unblocked)

> These are NOT ready for bite-sized TDD: each needs a partner deliverable that would otherwise be guesswork. Expand each into full TDD tasks (like Chunk 0) once its dependency lands.

### P1 — employee→email correctness
**Blocked on:** partner confirms `employee` table column names + that `email` is the address RMHR validates `recruiterEmail` against / returns as `lockByEmail`.
**Then:** finalize `lib/partner-pg/employee.ts` SQL; add a test against confirmed columns.

### P2 — flip `DEDUP_PHONE_PRIMARY`
**Blocked on (de-risk):** partner says whether their worker dedup also moves to phone-primary; optional backfill/merge pass for historically split rows.
**Then:** dry-run count → enable in dev → validate → prod.

### P3 — dark-launch (`LOCK_CHECK_ENABLED=1`, observe only)
**Blocked on:** partner delivers `RMHR_INTERNAL_HOST` + `X-Internal-Api-Key` + full query string; `resumeSourceId` code table + confirmed default.
**Then:** fill the `rmhr-lock-check` step body — `getResumeBuffer(bucket, object_key)` re-fetch, `resolveRecruiterEmail` (null → 故障失败 `email-unresolvable`, log, do NOT block), `resolveResumeSourceId`, `uploadByRecruiterEmail`, `classifyRmhr`, `decide()`. **Persist OFF, announcers NOT gated** — only log the decision + record 故障失败 outcomes. Validate `lockedByEmail` accuracy + decision distribution against real traffic. Test env values already in hand (host/key from chat → put in `.env.local`, never commit).

### P4 — enforce (`CANDIDATE_LOCK_PG_WRITE=1`)
**Blocked on:** P3 validated; partner confirms (a) AO may write `is_locked`/`lock_start_time` to canonical Candidate (vs hsm), (b) blacklist mutually exclusive with lockState 1/2/3, (c) ontology extension for `lock_state`/`lock_owner_email`/`is_protected` or accept lossy mapping.
**Then:** call `persistLock`; gate BOTH announcers on `lock-only`; emit distinct `RESUME_LOCKED_CONFLICT` (register its schema in `server/em/schemas/builtin.ts` first — it's in the catalog but not the EM registry); 故障 → recoverable park (not fail-open); add the **upload_id idempotency guard** (Decision 3) before enabling — replay of same `upload_id` short-circuits to stored snapshot; ontology mirror behind the flag; rule-check reads AO-local `lockState` so PROTECTED isn't re-submitted.

---

## Open questions (carry from spec)
- `CandidateLock` key: `(candidateId, rmhrResumeId)` composite — confirm.
- Fail-closed (park) permanence when `recruiterEmail` unresolvable.
- `expiresAt` nullable + `@@index([clientId, expiresAt])` implies a non-existent sweeper — drop index or define TTL.
- PROTECTED(3) downstream parity with LOCKED.
- Idempotency-guard granularity for manual replay.
