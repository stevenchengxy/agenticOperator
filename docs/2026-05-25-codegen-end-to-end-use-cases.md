# Codegen End-to-End — Use Cases, Inputs, and Production Gap Analysis

> 2026-05-25 · Replaces the earlier 5-agent use case doc with a wider scope
> Covers: Agent Codegen (form-first v2) + Library Codegen (NL + structured)
> Frames each case against the matching **production code** so we can see what
> the algorithm gets right and where it needs more tuning.

---

## How to read this doc

Each use case is a triplet:

1. **What the operator types** — exact form values + business description / curl examples
2. **What codegen returns** — the spec / methods / code shape the pipeline produces
3. **What the production code actually looks like** — pulled from `server/inngest/agents/*.ts` or `lib/*` and a gap-analysis pointing at **which tuning lever** (prompt / few-shot / template / tool registry entry) closes the gap

If you skip ahead, **Part 4** is the consolidated tuning-lever index.

---

# Part 1 — Agent Codegen use cases (5 agents)

All cases use the form-first v2 flow at `/behavior/codegen`. Mode = **🔁 Regenerate existing** + pick the agent from the dropdown → form auto-fills → operator only edits the **business description** textarea + clicks **Generate Agent →**.

## UC-A1 · JDGenerator (`create-jd-agent.ts`, 606 lines)

### Inputs

| Form field | Value (prefilled when mode=Regenerate) |
|---|---|
| slug | `create-jd-agent` |
| displayName | `Create JD Agent` |
| stage | `jd` |
| ownerTeam | `HSM·交付` |
| triggerEvent | `REQUIREMENT_LOGGED` |
| emitEvents | `[JD_GENERATED]` |
| retries | `2` · errorHandling | `retry` |

**Business description (textarea):**

```
1. Pull job_requisition from partner Postgres by event.data.job_requisition_id
2. Mirror the requirement into Allmeta Neo4j as a Job_Requisition node
3. Build a prompt from requirement.client_job_title + must_have_skills +
   nice_to_have_skills + work_years + salary_range_raw + city
4. Call RoboHire /generate-jd with { prompt, language: 'zh', companyName }
   - 4xx errors → NonRetriableError; 5xx allowed to retry
5. Write the generated JD into partner Postgres job_posting via syncJdToPartnerPg
   (returns { synced, job_posting_id, reason? } — throw NonRetriableError when
   reason is set and job_posting_id is missing)
6. Mirror the new job_posting into Allmeta Neo4j as a Job_Posting node
7. emit JD_GENERATED with { job_requisition_id, job_posting_id, jd_content }
```

### Predicted codegen output (steps + bodies summary)

| Step (LLM) | callsLib | Body skeleton (LLM, drawn from few-shot) |
|---|---|---|
| `fetch-requirement` | `partner-pg.getRequirement` | `getRequirementDetail(id)` + null-check + `NonRetriableError` |
| `write-jr-neo4j` | `allmeta.writeJobRequisition` | `writeJobRequisitionInstance({ requirement })` + soft-fail log |
| `generate-jd` | `robohire.generateJd` | `try { generateJdDirect(...) } catch (e) { if (RobohireApiError 4xx) throw NonRetriable }` |
| `sync-jd` | `partner-pg.syncJd` | `syncJdToPartnerPg(input)` + check `reason`/`job_posting_id` |
| `write-jp-neo4j` | `allmeta.writeJobPosting` | `writeJobPostingInstance({ job_posting_id, job_requisition_id })` + soft-fail log |
| `emit-jd-generated` | `inngest.send` | `step.sendEvent('emit-jd-generated-' + stepKey, { name: 'JD_GENERATED', data })` |

### What the production code actually does (highlights)

```ts
// server/inngest/agents/create-jd-agent.ts:149
const detail = await step.run(`fetch-requirement-${sanitize(requisitionId)}`, async () => {
  const r = await getRequirementDetail(requisitionId);
  if (!r) {
    throw new NonRetriableError(
      `[${AGENT_NAME}] partner Postgres: job_requisition ${requisitionId} 不存在`,
    );
  }
  logger.info(...);
  return r;
});
```

### Gap analysis (codegen vs prod)

| Gap | Codegen v2 today | Production | Tuning lever (concrete) |
|---|---|---|---|
| **Step IDs carry `sanitize(requisitionId)` suffix** for per-input idempotency | `'fetch-requirement'` (static) | `` `fetch-requirement-${sanitize(requisitionId)}` `` | Few-shot entry pattern is fine, but the **template renderer** strips the `${expr}` interpolation. Add support in [render-agent.ts](../lib/agent-codegen/templates/render-agent.ts): if spec.steps[i].id contains a `:input` marker, render as template literal. **Lever: template** |
| **Build-prompt step is a pure helper, not a step.run** | Codegen LLM may try to put `buildPromptFromRequirement` inside its own step | Production calls `buildPromptFromRequirement(...)` synchronously **between** step.runs | Step body filler prompt should explicitly note "pure-compute transformations between steps live outside step.run". **Lever: spec-extractor prompt rule** |
| **Banner has business-context paragraph** | Template emits brief `// {slug} — {displayName}` header | Production has 18-line Chinese comment header explaining workflow position | Template renderer should optionally accept a `bannerNotes` field; UI form gets a small textarea for it. **Lever: template + form** |

**Score prediction**: ~75-85% structural match. Functional parity ~90% if operator hand-fixes step IDs.

---

## UC-A2 · ResumeParser (`resume-parser-agent.ts`, 470 lines)

### Inputs

| Form field | Value |
|---|---|
| slug | `resume-parser-agent` |
| displayName | `Resume Parser Agent` |
| stage | `resume` |
| ownerTeam | `招聘运营` |
| triggerEvent | `RESUME_DOWNLOADED` |
| emitEvents | `[RESUME_PROCESSED, RESUME_PARSE_ERROR]` |

**Business description:**

```
On RESUME_DOWNLOADED (data: { minio_object_key, upload_id, filename }):
1. minio.statResume on the key — if size > 10MB throw NonRetriableError
2. minio.getResumeBuffer to download the PDF buffer
3. RoboHire parse-resume on the buffer (pass filename + trace_id)
   - 4xx RobohireApiError → NonRetriableError + emit RESUME_PARSE_ERROR
4. partner-pg saveCandidateToPartnerPg with { upload_id, parsed_resume_json, source }
5. Mirror candidate into Allmeta (writeCandidateInstance)
6. Mirror resume into Allmeta (writeResumeInstance)
7. emit RESUME_PROCESSED on success
```

### Gap analysis

| Gap | Codegen | Prod | Lever |
|---|---|---|---|
| **`parseResumeDirect` signature** — codegen v1 had only `(pdf, opts)` in registry, but prod takes `(pdf, filename, opts)` | Codegen could miss the filename param | Production passes filename explicitly | Already fixed in D2 — verify tool-registry signature matches. **Lever: tool registry signature** |
| **Step error-recovery emit** — production conditionally emits PARSE_ERROR when parse fails | LLM tends to put both emits at the end | Production emits PARSE_ERROR mid-flow via step.sendEvent then returns | Few-shot needs a "conditional emit mid-flow" example. **Lever: few-shot** |
| **`stepKey` derivation** — production computes `const stepKey = uploadId ?? sanitize(filename)` once at handler top | LLM may inline `event.data.upload_id` everywhere | Add a `// before step.run blocks: helper-var construction` instruction. **Lever: spec extractor prompt** |

---

## UC-A3 · Matcher (`match-resume-agent.ts`, 336 lines)

### Inputs

| Form field | Value |
|---|---|
| slug | `match-resume-agent` |
| triggerEvent | `MATCH_RULE_CHECK_PASSED` |
| emitEvents | `[MATCH_PASSED_NEED_INTERVIEW, MATCH_PASSED_NO_INTERVIEW, MATCH_FAILED]` |

**Business description:**

```
On MATCH_RULE_CHECK_PASSED:
1. Fetch the requirement (jrId from event.data.job_requisition_id)
2. Flatten requirement into jdText; build resumeText from event.data.parsed_resume_json
3. Call RoboHire /match-resume
   - 4xx → return { ok: false, error } and immediately step.sendEvent MATCH_FAILED
4. On ok=true: saveMatchResultsToPartnerPg with full envelope
5. Mirror Candidate_Match_Result.overall_* into Allmeta (PK = cmr_<candidate>_<jr>)
6. Decide emit by score:
   - if matching_score === null → MATCH_FAILED
   - else if needsInterview(score) → MATCH_PASSED_NEED_INTERVIEW
   - else → MATCH_PASSED_NO_INTERVIEW
```

### Gap analysis

| Gap | Codegen | Prod | Lever |
|---|---|---|---|
| **Branched emits** — prod emits *one* of three events based on score | LLM may emit all three OR forget the decision logic | Decision-emit pattern in spec extractor prompt; few-shot for "branch then sendEvent" | **Lever: spec extractor prompt + few-shot** |
| **`saveMatchResultsToPartnerPg` input shape** — has `source: 'need_interview'` literal and `created_by: 'ai_engine'` | LLM may invent different literal values | Tool registry exampleCalls now shows production literal values. **Lever: tool registry exampleCalls (already added in D2)** |
| **PK derivation `cmr_<candidate>_<jr>`** — must be consistent across match-agent and rule-check-agent or rows duplicate | LLM may pick different naming | Production uses fixed `cmr_${candidateId || 'unknown'}_${data.job_requisition_id}` — new few-shot entry (#14) captures this. **Lever: few-shot (added in D2)** |

---

## UC-A4 · RuleCheck (`rule-check-agent.ts`, 649 lines — most complex)

### Inputs

| Form field | Value |
|---|---|
| slug | `rule-check-agent` |
| triggerEvent | `RESUME_PROCESSED` |
| emitEvents | `[MATCH_RULE_CHECK_PASSED, MATCH_RULE_CHECK_FAILED]` |

**Business description:**

```
On RESUME_PROCESSED (data: { candidate_id, upload_id, parsed_resume_json }):

1. List current open requirements via getRecruitingJobsAsRequirements
2. Optionally enrich with getRequirementsAgentView for rule fields
3. Pull the parsed resume (canonical row) via getParsedResume(candidate_id)
4. For each requirement (the spec describes one JR — fan-out is implicit):
   a. Mirror the JR into Allmeta (writeJobRequisitionInstance)
   b. buildRuleCheckInput({ requirement, candidate, parsedResume })
   c. runRuleCheck(input) → { verdict, dims, auditId }
   d. Write the audit row back to partner-pg
   e. Write Candidate_Match_Result.rule_check_* fields into Allmeta
5. Emit MATCH_RULE_CHECK_PASSED on verdict='pass', MATCH_RULE_CHECK_FAILED on 'fail'
```

### Gap analysis

| Gap | Codegen | Prod | Lever |
|---|---|---|---|
| **Per-JR fan-out** — production uses `for (const jr of requirements)` around step blocks | Codegen v2 doesn't generate for-loops around steps | Production hand-codes the loop because spec doesn't model it | Document this limitation; treat each generated step as **per-instance**. Operator post-edits in Code tab to add loops. **Lever: spec-types extension OR docs/limits** |
| **`buildRuleCheckInput` input shape unknown to LLM** | LLM will guess incorrect input fields → TS2353 | Production input shape is documented in `@/lib/rule-check` type | Add `paramsType` detail to tool registry entry for `rule-check.run` so LLM sees the exact param keys. **Lever: tool registry signature detail** |
| **Audit write step writes to TWO places** (partner-pg AND Allmeta `rule_check_*` columns) | LLM produces one step | Production has two separate step.runs | Few-shot needs "split write into 2 steps" example. **Lever: few-shot** |

**Realistic expectation**: this is the hardest agent to fully regenerate. ~60-70% structural match. Operator workflow: codegen MVP → fix compile errors in Code tab → save.

---

## UC-A5 · InterviewInviter (`interview-inviter-agent.ts`, 527 lines)

### Inputs

| Form field | Value |
|---|---|
| slug | `interview-inviter-agent` |
| triggerEvent | `INTERVIEW_INVITATION_REQUESTED` |
| emitEvents | `[INTERVIEW_INVITATION_SENT, INTERVIEW_INVITATION_FAILED]` |

**Business description:**

```
On INTERVIEW_INVITATION_REQUESTED (data: { candidate_id, job_requisition_id, resume_text?, jd_text?, candidate_email? }):

1. If resume_text missing, getParsedResume(candidate_id) and use the canonical resume
2. If jd_text missing, getRequirementDetail(job_requisition_id) and flatten to jd text
3. Build InviteCandidateInput { candidate_email, resume, jd, interview_type: 'video' }
4. Call RoboHire /invite-candidate with traceId
   - 4xx → NonRetriableError + emit INTERVIEW_INVITATION_FAILED
   - HTTP 2xx but body.success === false → ALSO NonRetriableError (GoHire rejected)
5. On success, write CommunicationLog into Allmeta (channel=email, subject=AI interview invitation, status=sent, login_url=invite_url)
6. Write InterviewRecord into Allmeta (status=invited, interview_type=video)
7. emit INTERVIEW_INVITATION_SENT
```

### Gap analysis

| Gap | Codegen | Prod | Lever |
|---|---|---|---|
| **The "2xx + success=false" corner case** — easy for LLM to miss | Generated body might only check `response.ok` (HTTP status) | Production explicitly checks `if (!r.data.success)` after the http-ok branch | Few-shot has it (entry #9 added in Phase 1c). Verify the system prompt explicitly mentions "RoboHire returns 2xx with success flag — check both". **Lever: step body filler prompt rule** |
| **Backfill steps** — conditional reads | LLM may generate them as unconditional fetches | Production: `if (!event.data.resume_text) { ... }` then merges | Step body filler needs "conditional inputs from event payload" guidance. **Lever: prompt** |
| **CommunicationLog write extra fields** — production passes `login_url`, `external_message_id` (GoHire response fields) | LLM-generated body may omit these | Add `Communication_Log canonical fields` to tool registry exampleCalls. **Lever: tool registry exampleCalls** |

---

# Part 2 — Library Codegen use cases (4 representative libs)

All cases use `/behavior/codegen/library`. Each shows **both** NL mode and structured mode. The "what production looks like" column references the real hand-written file in `lib/`.

## UC-L1 · `robohire-client.ts` (most-used external API, 448 lines)

The grand-daddy of external integrations. Used by 4 of 5 production agents.

### NL mode input

```
Wrapper for RoboHire's resume & JD AI APIs.

Endpoints:
- POST /api/v1/parse-resume  multipart upload of a PDF; returns parsed resume JSON
- POST /api/v1/match-resume  JSON body { resume, jd }; returns matchScore + recommendation
- POST /api/v1/jobs/generate-jd  JSON body { prompt, language }; returns generated JD
- POST /api/v1/invite-candidate  JSON body with candidate_email + resume; returns invite_url

Auth: bearer token via Authorization header. Env vars: ROBOHIRE_API_BASE_URL, ROBOHIRE_API_KEY.
Timeout: 120s default (configurable via ROBOHIRE_TIMEOUT_MS).
All endpoints can return 429 (rate-limited) and 402 (quota exhausted) which the wrapper should distinguish from other 4xx.
```

The NL drafter (`/api/codegen/library/draft-examples`) returns:
```json
{
  "examples": [
    { "httpVerb": "POST", "httpPath": "/api/v1/parse-resume",      "description": "Upload a PDF resume; return parsed JSON" },
    { "httpVerb": "POST", "httpPath": "/api/v1/match-resume",      "description": "Score a resume against a JD" },
    { "httpVerb": "POST", "httpPath": "/api/v1/jobs/generate-jd",  "description": "Synthesize a JD from a prompt" },
    { "httpVerb": "POST", "httpPath": "/api/v1/invite-candidate",  "description": "Send an AI interview invitation" }
  ]
}
```

Operator then refines: opens Examples mode, adds request/response sample JSON for each, runs `Generate Library →`.

### Structured mode input (alternative — operator skips NL)

```
Form:
  name: robohire-client
  description: Direct client for RoboHire AI endpoints (parse / match / JD-gen / invite)
  baseUrl: https://api.robohire.io
  authStyle: bearer
  envVarsRequired: [ROBOHIRE_API_BASE_URL, ROBOHIRE_API_KEY]

Endpoint examples (with response samples):
  1. POST /api/v1/parse-resume
     description: Upload a PDF resume; return parsed JSON
     requestSample: (multipart form, not shown; description note: multipart with file field)
     responseSample: '{"data": {"name": "...", "email": "...", "skills": [...], "workExperience": [...]}, "cached": false, "requestId": "req_abc"}'
  2. POST /api/v1/match-resume
     description: Score a resume against a JD
     requestSample: '{"resume": "string", "jd": "string"}'
     responseSample: '{"data": {"matchScore": 78, "recommendation": "GOOD_MATCH", "summary": "..."}, "requestId": "req_xyz"}'
  ...
```

### Production code (lib/robohire-client.ts)

Production has substantially more sophistication than codegen v2 emits today:

- **`instrumentedFetch<T>` wrapper** around every call (logs req/response via `currentLogger().apiCall(...)`)
- **`RobohireApiError`** class with discriminated `code` field ('CLIENT' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'SERVER' | 'NETWORK')
- **`AbortSignal.timeout(timeoutMs)`** per call
- **Network-error wrapping**: fetch rejection → `RobohireApiError(0, 'NETWORK', ...)`
- **Per-status mapping**: 429 → RATE_LIMITED, 402 → QUOTA_EXHAUSTED, 4xx → CLIENT, 5xx → SERVER
- **Multipart for parse-resume** (Blob/FormData)
- **TraceId header** (X-Trace-Id) when opts.traceId provided

### Gap analysis

| Gap | Codegen v2 MVP | Production | Tuning lever |
|---|---|---|---|
| **Logger wrapping** | Plain `fetch()` calls; no logging | `instrumentedFetch()` wraps every call with `currentLogger().apiCall(label, …)` | Template renderer should optionally generate a `instrumentedFetch` helper when `category=robohire` or any external. **Lever: template** |
| **Error code classification** | Only `ClientApiError` with `isClientError = status >= 400` | 5-way discriminated union: CLIENT / RATE_LIMITED / QUOTA_EXHAUSTED / SERVER / NETWORK | Template's `ClientApiError` should generate the discriminated `code` field; auth-style → known status mappings (429 = RATE_LIMITED, 402 = QUOTA_EXHAUSTED) baked into the template. **Lever: template renderer (significant)** |
| **Timeout via AbortSignal** | Not generated | Every call has `AbortSignal.timeout(timeoutMs)` | Template should include `DEFAULT_TIMEOUT_MS` const + signal injection. **Lever: template** |
| **TraceId propagation** | Not modeled | All calls accept `opts: CommonOpts & { traceId? }` and stamp `X-Trace-Id` | Generated method signatures should include `opts?: { traceId?: string }` by convention; template auto-stamps header. **Lever: template + LLM Call C prompt** |
| **Multipart form support** | LLM-generated body for parse-resume would try JSON.stringify a Buffer | Production builds `FormData` and appends `Blob` | Step body filler / lib spec extractor needs an explicit "multipart endpoint" hint in CurlExample schema. **Lever: lib-spec-types (add `bodyFormat: 'json' \| 'multipart'` to CurlExample)** |

**Recommendation**: this lib is too sophisticated for codegen MVP. Realistic next step is to **regenerate just the new methods** (e.g., a new `/api/v1/parse-job-description` endpoint), let the operator paste them into the existing hand-written `robohire-client.ts`. Codegen full RoboHire wrapper from scratch is Phase 2.5.

---

## UC-L2 · `partner-pg/requirements.ts` (60 lines — representative SQL read)

The simplest library. Pure read.

### NL mode input

```
A read-only library for fetching one job_requisition row by id from the partner Postgres database.

The job_requisition table has these columns: job_requisition_id, client_id, client_job_title, must_have_skills (array), nice_to_have_skills (array), work_years (number), degree_requirement, education_requirement, salary_range_raw, city, recruitment_type, interview_mode, language_requirements, expected_level, negative_requirement, job_requisition_specification_id (FK).

There's a 1:1 sibling table job_requisition_specification that holds extra fields (status, urgency, etc.) — should be LEFT JOINed.

Return shape: full requirement row merged with the spec row nested as .specification (or null).
Return null when not found (caller handles).
```

NB: this lib is **not HTTP** — it's SQL via a postgres pool. Library Codegen MVP only does HTTP wrappers; this case **falls outside MVP scope**.

### Production code (lib/partner-pg/requirements.ts)

```ts
import { query } from './client';

export async function getRequirementDetail(jobRequisitionId: string): Promise<RequirementDetail | null> {
  const sql = `
    SELECT row_to_json(r.*) AS requirement_json,
           row_to_json(s.*) AS specification_json
      FROM job_requisition r
      LEFT JOIN job_requisition_specification s
        ON s.job_requisition_specification_id = r.job_requisition_specification_id
     WHERE r.job_requisition_id = $1
     LIMIT 1
  `;
  const result = await query<{ requirement_json: JobRequisition; specification_json: ... }>(sql, [jobRequisitionId]);
  const row = result.rows[0];
  if (!row) return null;
  return { ...row.requirement_json, specification: row.specification_json };
}
```

### Gap analysis

| Gap | Codegen v2 | Prod | Lever |
|---|---|---|---|
| **DB wrappers not supported** | MVP only does HTTP | Production is SQL via `pg` pool | Phase 2.5: add `kind: 'http-client' \| 'db-wrapper'` to LibraryFormFields. db-wrapper renderer emits `query()` calls + named SQL templates. **Lever: lib-spec-types extension + new template** |

This is the most actionable Phase 2.5 expansion. Until then, partner-pg reads are hand-written.

---

## UC-L3 · `partner-pg/candidates.ts` (560 lines — complex SQL upsert)

The biggest hand-written lib. Multi-table upsert with conflict resolution + audit trail.

Verdict: **out of scope for any codegen MVP**. Complex domain logic (idempotency keys, dedup on upload_id, resolving candidate identity across uploads). A meaningful codegen would need:
- Multi-table schema seeding
- Transaction support
- Conflict-resolution policy as a first-class spec field

These add up to Phase 3 territory. For now: hand-write. Tool registry already references it correctly.

---

## UC-L4 · `allmeta-writers/job-requisition.ts` (representative soft-fail write)

Eight writers under `lib/allmeta-writers/`. All follow the same shape:
- Input: typed entity object
- Behavior: filter fields against canonical schema → POST to allmeta API → catch all errors
- Output: `{ ok: boolean; error?: string }`

### NL mode input

```
A soft-fail writer for the Allmeta Neo4j ontology API.

This writer specifically writes Job_Requisition instances. Input is a typed
requirement object; it filters out fields not in the canonical schema (only
keeps fields documented in neo4j_data/objects_v0_1_015.json), then POSTs to
/api/instances/Job_Requisition with the cleaned body.

Errors must NEVER throw — caller treats Postgres as source of truth and
allmeta as best-effort. Return { ok: true } on 2xx, { ok: false, error } on
anything else.

Auth: bearer token via ALLMETA_API_KEY env var. Base URL: ALLMETA_API_BASE_URL.
```

### Production pattern

```ts
export async function writeJobRequisitionInstance(input: { requirement: Record<string, unknown> }): Promise<{ ok: boolean; error?: string }> {
  try {
    const body = filterToCanonical(input.requirement, JOB_REQUISITION_CANONICAL_FIELDS);
    const res = await allmetaFetch('POST', '/api/instances/Job_Requisition', body);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
```

### Gap analysis

| Gap | Codegen v2 MVP | Production | Lever |
|---|---|---|---|
| **Soft-fail return shape `{ok, error}`** | MVP always throws on non-2xx | Production catches everything and returns | Add `errorStyle: 'throw' \| 'soft-fail'` to LibraryFormFields. **Lever: lib-spec-types + template renderer** |
| **Schema field filtering** | Not modeled | Production loads a canonical-fields list per type and filters input | Operator must hand-write this part. Library Codegen could accept a `canonicalFields?: string[]` per method, but it's domain-specific. Defer to Phase 2.5. **Lever: parking lot** |
| **One-file vs file-per-method** | MVP emits one client.ts | Production has 8 writers, one per type, all re-exported from index.ts | Add `outputStyle: 'one-file' \| 'file-per-method'` to LibraryFormFields. **Lever: template variant** |

---

# Part 3 — Full end-to-end loop: invent a NEW external integration

Story: imagine RAAS just landed a contract with **LinkedIn Recruiter** and we need a thin wrapper + an agent that posts open requirements to LinkedIn.

### Step 1 — Use Library Codegen NL mode to bootstrap

Page: `/behavior/codegen/library` → Mode: **💬 Natural language**

```
A wrapper for LinkedIn Recruiter's job posting API.

Endpoints:
- POST /v2/jobs                  Create a new job post (returns posting_id + status)
- GET  /v2/jobs/:id              Fetch posting status
- DELETE /v2/jobs/:id            Take down a posting
- GET  /v2/jobs/:id/applicants   List applicants who applied via this posting

Auth: OAuth2 bearer token. Env vars: LINKEDIN_API_BASE_URL, LINKEDIN_ACCESS_TOKEN.
Standard JSON request/response.
```

Click **Draft endpoints →** → 4 entries land in the structured list.

### Step 2 — Refine with response samples

Operator manually adds request/response samples (the part LLM CAN'T fabricate safely):

```
POST /v2/jobs
  request:  {"title": "Senior SRE", "description": "...", "location": "Beijing", "level": 5}
  response: {"posting_id": "li_job_abc123", "status": "PENDING_REVIEW", "url": "https://linkedin.com/jobs/abc123"}
```

(And similar for the other 3 endpoints.)

### Step 3 — Generate Library

Click **Generate Library →** → `/api/codegen/library/generate` runs the pipeline → `lib/generated/linkedin-recruiter/client.ts` rendered. Right rail shows compile ✓ OK.

Switch to **TOOL_REGISTRY suggestions** tab → see 4 suggested entries:

```ts
{
  id: 'linkedin-recruiter.createJob',
  importFrom: '@/lib/generated/linkedin-recruiter/client',
  importName: 'createJob',
  signature: "createJob({ title: string; description: string; ... }): Promise<{ posting_id: string; status: string; url: string }>",
  summary: 'Create a new job posting on LinkedIn Recruiter',
  sideEffects: 'external HTTP',
  category: 'partner-pg', // ← adjust manually (probably 'robohire' or new 'partner-api')
},
// ... 3 more
```

### Step 4 — Paste into `tool-registry.raas.ts`

Manual paste (Phase 2 MVP doesn't auto-write). Adjust `category` field per entry. Add `exampleCalls` after first use.

### Step 5 — Use Agent Codegen with the new tools

Page: `/behavior/codegen` → Mode: **✨ New**

```
Form:
  slug: linkedin-poster-agent
  displayName: LinkedIn Job Poster
  stage: jd
  ownerTeam: 招聘运营
  triggerEvent: JD_APPROVED
  emitEvents: [CHANNEL_PUBLISHED, CHANNEL_PUBLISHED_FAILED]
  retries: 3
  errorHandling: hitl-fallback

Business description:
On JD_APPROVED:
1. Fetch the job_posting from partner-pg (need title + description + city)
2. Call linkedin-recruiter.createJob with the JD fields
3. On success, store the LinkedIn posting_id back in partner-pg (extend job_posting schema, or use a separate posting_external table)
4. Mirror the publish into Allmeta (Communication_Log channel=linkedin)
5. emit CHANNEL_PUBLISHED on 2xx, CHANNEL_PUBLISHED_FAILED on error
```

→ Generate → compile → save as version → open PR (Bundle D future).

### Predicted result

- Spec generated cleanly because `linkedin-recruiter.*` tools are in registry
- LinkedIn createJob step body might still over-simplify error handling vs the 5-way RobohireApiError pattern — operator hand-tweaks
- `CHANNEL_PUBLISHED_FAILED` emit branch may or may not be in step ordering; operator fixes
- Time: ~3-5 minutes operator-time + ~60-90s pipeline time

---

# Part 4 — Consolidated tuning lever index

Sorted by impact + effort. Each item closes one or more gaps from Parts 1-2.

## Quick wins (≤1 day, high impact)

| # | Lever | Implementation | Closes |
|---|---|---|---|
| T-1 | **More exampleCalls in tool registry** | Add 2 more snippets each for `robohire.parseResume`, `robohire.matchResume`, `robohire.inviteCandidate`, `allmeta.writeCandidate`, `partner-pg.saveCandidate` | UC-A2 gap #1, UC-A3 gap #2, UC-A5 gap #3 |
| T-2 | **Spec-extractor prompt: emit pattern rule** | Add explicit rule "emit downstream events via `step.sendEvent(stepKey, {...})` not `inngest.send()` — retries are then idempotent per step" | UC-A3 gap #1 (branched emits) |
| T-3 | **Spec-extractor prompt: conditional inputs rule** | Rule "when a step backfills from optional event payload, generate guard at top: `if (!event.data.X) { ... }` then merge" | UC-A2 gap #2, UC-A5 gap #2 |
| T-4 | **Template: bannerNotes field** | Form text-area for "extra banner / workflow notes"; renderer prepends as comment block | UC-A1 gap #3 |

## Medium ($2-4 day items, structural)

| # | Lever | Implementation | Closes |
|---|---|---|---|
| T-5 | **Step ID template interpolation** | If a step describes per-input idempotency, allow `id: 'fetch-requirement-${requisitionId}'` template syntax; renderer emits as TS template literal | UC-A1 gap #1 |
| T-6 | **Tool registry signature detail expansion** | Add `paramsType?: TypeScriptObjectShape` to ToolRegistryEntry for the wider-shape libs (rule-check.run, saveMatchResults) | UC-A4 gap #2, UC-A3 gap #2 |
| T-7 | **Library spec extension: bodyFormat field** | Add `bodyFormat: 'json' \| 'multipart'` to CurlExample; renderer handles multipart for PDF uploads | UC-L1 gap #5 (partial) |
| T-8 | **Library spec extension: errorStyle field** | Add `errorStyle: 'throw' \| 'soft-fail'` to LibraryFormFields; renderer emits matching template | UC-L4 gap #1 |

## Phase 2.5 (week+ items)

| # | Lever | Implementation | Closes |
|---|---|---|---|
| T-9 | **Library Codegen DB-wrapper kind** | `kind: 'http-client' \| 'db-wrapper'`; db-wrapper renderer uses `query()` helper + named SQL templates with `$1, $2...` | UC-L2 entire case |
| T-10 | **Library template: discriminated error class** | When `category=external-api` and method count >3, emit `RobohireApiError`-style code-discriminated class + per-status mapping | UC-L1 gap #2 |
| T-11 | **Library template: instrumented fetch helper** | When `authStyle != 'none'` AND any method calls external, emit `instrumentedFetch<T>` that wraps fetch with optional `currentLogger().apiCall(...)` | UC-L1 gap #1 |
| T-12 | **Multi-file output mode** | `outputStyle: 'one-file' \| 'file-per-method'`; file-per-method emits index.ts barrel + one file per method | UC-L4 gap #3 |

---

# Part 5 — Eval harness (D4)

The tuning levers above are predictions. To know what's actually broken, we need a repeatable eval loop:

```bash
npm run codegen:eval -- --fixture=create-jd-agent
```

Reads a fixture (form + business description), runs the pipeline through real LLM, diffs the output against `server/inngest/agents/<slug>.ts`, prints a structural score breakdown.

Implementation lands in next commit. See [eval harness scaffold](../lib/agent-codegen/eval/) for the structure.

Score dimensions (each 0-100%):
1. **Import overlap** — `imports actually present / imports in production`
2. **Step ID overlap** — `step.run('id', ...)` IDs that match
3. **Tool call overlap** — `tool_id` appearance count match
4. **Pattern adherence** — try/catch + NonRetriableError + logger.info presence
5. **LOC ratio** — generated / production (cap at 1.5x for full credit)

Composite = weighted mean, default weights `[0.2, 0.2, 0.25, 0.25, 0.1]`.

When run with the 5 production agents as fixtures, this number is our **codegen quality KPI**. Improvement targets:
- v2 baseline (today): unknown — needs first run
- Target after T-1 through T-4 (quick wins): +5-10 points
- Target after T-5 through T-8 (medium): +10-15 points
- Phase 4 (agentic loop): +20-30 points but $$$

---

# Limits (carried over)

- LLM cost / latency: ~$0.40 + 30-90s per generate
- Operator-in-the-loop required for every generation — codegen is a starting point, not a 1-click ship
- New agents not in AGENT_MAP still require manual registration to enable Save-as-Version
- Library codegen MVP doesn't auto-update tool-registry.raas.ts (manual paste from output tab)
- Code落盘 still doesn't hot-reload Inngest — Bundle D future replaces with CI redeploy
