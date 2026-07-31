# Codegen Use Cases — 5 Production Agents as Ground Truth

> 2026-05-25 · Codegen **v2 (form-first)**
> Adapted from v1 — split human-decision form from LLM-fill prompt.
> Page: [`/behavior/codegen`](../../app/behavior/codegen/page.tsx)
> Model: `AI_CODEGEN_MODEL` env (defaults to `gpt-4o-mini`)

---

## 0. v2 design recap

The page now has a **two-segment input** on the left rail:

| Segment | Decides | Who fills it |
|---|---|---|
| **Form** (top) | slug · displayName · stage · owner · triggerEvent · emitEvents · retries · errorHandling | Operator (you) |
| **Business description** (bottom) | what each step should do, in prose | Operator (you) — the LLM reads this |

The LLM **never** picks identity / wire-up / behavior — those are human decisions and would be wrong half the time if delegated. The LLM only produces:
1. The `steps[]` array (LLM Call A) — 3-6 steps that implement your prose
2. Each step's TypeScript body (LLM Call B) — grounded in the 5 production agents' few-shot bodies

This makes "regenerate existing agent" safe: pick an agent from the dropdown → the form prefills → just edit the business description → re-generate.

Ground truth registries unchanged:
- [tool-registry.raas.ts](../../lib/agent-codegen/registries/tool-registry.raas.ts) — 23 wrappers used by 5 real agents
- [event-registry.raas.ts](../../lib/agent-codegen/registries/event-registry.raas.ts) — 30+ events; trigger / emits dropdowns read this
- [few-shot-index.ts](../../lib/agent-codegen/few-shot-index.ts) — 10 real step.run bodies, scored by stage + tool overlap

---

## Form quick reference

```
┌────────────────────────────────────┐
│ MODE                               │
│ [🔁 Regenerate existing] [✨ New]  │
│ (regen) → dropdown of 22 agents    │
├────────────────────────────────────┤
│ IDENTITY                           │
│ Slug:    create-jd-agent           │
│ Name:    Create JD Agent           │
│ Stage:   [jd ▾]                    │
│ Owner:   [HSM·交付 ▾]              │
├────────────────────────────────────┤
│ WIRE-UP                            │
│ Trigger: [REQUIREMENT_LOGGED ▾]    │
│ Emits:   [JD_GENERATED]            │
│          [+ add emit]              │
├────────────────────────────────────┤
│ BEHAVIOR                           │
│ Retries: [2]                       │
│ Errors:  [retry ▾]                 │
├────────────────────────────────────┤
│ BUSINESS DESCRIPTION (LLM reads)   │
│ [textarea — describe each step]    │
│ [Generate Agent →]                 │
└────────────────────────────────────┘
```

---

## Use Case 1 · Regenerate `JDGenerator`

**Goal**: try a v2 of the JD generator that adds a RoboHire health-check step before the actual generate call.

### Form

1. Click **🔁 Regenerate existing** → select `JDGenerator` from the dropdown
2. Form auto-fills:
   - Slug `create-jd-agent`
   - Name `Create JD Agent`
   - Stage `jd`
   - Owner `HSM·交付`
   - Trigger `REQUIREMENT_LOGGED`
   - Emits `[JD_GENERATED]`
   - Retries `2`, Errors `retry`

### Business description (paste into textarea)

```
1. Pull job_requisition from partner Postgres
2. Mirror the requirement into Allmeta Neo4j (Job_Requisition node)
3. Build the prompt from the requirement fields and call RoboHire /generate-jd
   - 4xx → NonRetriableError
4. Write the generated JD into partner Postgres job_posting
5. Mirror the job_posting into Allmeta Neo4j
6. Emit JD_GENERATED
```

### Click **Generate Agent →**

- Pipeline stepper lights up: ① ✓ → ② active → … → ⑤ active → ✓
- Total ~30-60s
- Spec tab populates (you can read it; not editable in v2 — Form is the source of truth)
- Code tab populates with a real Inngest agent
- CompilerPanel shows ✓ OK · 0 diag (if all goes well)

### Spec the LLM produced (read-only on Spec tab)

```json
{
  "slug": "create-jd-agent",           // ← from form, not LLM
  "displayName": "Create JD Agent",    // ← from form
  "stage": "jd",                       // ← from form
  "ownerTeam": "HSM·交付",             // ← from form
  "triggerEvent": "REQUIREMENT_LOGGED",// ← from form
  "emitEvents": ["JD_GENERATED"],      // ← from form
  "retries": 2,                        // ← from form
  "errorHandling": "retry",            // ← from form
  "steps": [                           // ← LLM Call A produced
    { "id": "fetch-requirement", "callsLib": "partner-pg.getRequirement", ... },
    { "id": "write-jr-neo4j",    "callsLib": "allmeta.writeJobRequisition", ... },
    { "id": "generate-jd",       "callsLib": "robohire.generateJd", ... },
    { "id": "sync-jd",           "callsLib": "partner-pg.syncJd", ... },
    { "id": "write-jp-neo4j",    "callsLib": "allmeta.writeJobPosting", ... },
    { "id": "emit-jd-generated", "callsLib": "inngest.send", ... }
  ]
}
```

Notice the slug, stage, trigger, emits **exactly match** what you typed in the form. No LLM drift.

### Save as version

CompilerPanel footer: **保存为版本 → JDGenerator** is enabled (compile is green + slug matches AGENT_MAP).
- Click → POST `/api/agents/JDGenerator/versions` with codegen payload
- Confirmation pill: **✓ 已保存版本 · 2026-05-25-1830**
- See it at [`/fleet/JDGenerator?tab=versions`](http://localhost:3002/fleet/JDGenerator?tab=versions)

### Diff tab

If you've already saved a previous codegen version, the Diff tab shows side-by-side compare against it. First time: shows a placeholder explaining "no saved version yet."

---

## Use Case 2 · Regenerate `ResumeParser` with a size guard

**Goal**: add a `stat-resume` pre-check that rejects files >10MB.

### Form

1. Mode: **🔁 Regenerate** → `ResumeParser`
2. Auto-fills: `resume-parser-agent`, stage `resume`, owner `招聘运营`, trigger `RESUME_DOWNLOADED`, emits `[RESUME_PROCESSED, RESUME_PARSE_ERROR]`

### Business description

```
1. minio.statResume on event.data.minio_object_key
   - if size > 10MB throw NonRetriableError "resume too large"
2. minio.getResumeBuffer to download
3. Call RoboHire /parse-resume on the buffer
   - 4xx RobohireApiError → NonRetriableError
4. saveCandidateToPartnerPg with the parsed JSON
5. Mirror candidate + resume into Allmeta Neo4j
6. emit RESUME_PROCESSED on success; if step 3 failed, emit RESUME_PARSE_ERROR
```

### Expected steps[]

```json
[
  { "id": "stat-resume",         "callsLib": "minio.statResume",         ... },
  { "id": "download-and-parse",  "callsLib": "robohire.parseResume",     ... },
  { "id": "save-candidate",      "callsLib": "partner-pg.saveCandidate", ... },
  { "id": "write-candidate-neo4j","callsLib": "allmeta.writeCandidate",  ... },
  { "id": "write-resume-neo4j",  "callsLib": "allmeta.writeResume",      ... },
  { "id": "emit-resume-processed","callsLib": "inngest.send",            ... }
]
```

### What the few-shot drives

`download-and-parse` body should land near identical to the production agent because the few-shot has the exact pattern:

```ts
const pdf = await getResumeBuffer(objectKey);
try {
  const r = await parseResumeDirect(pdf, { traceId });
  logger.info(`[${AGENT_NAME}] parsed resume ${objectKey} chars=${r.data.text?.length ?? 0}`);
  return r;
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    throw new NonRetriableError(`RoboHire parse-resume 4xx: ${e.httpStatus} ${e.code}`);
  }
  throw e;
}
```

### Save → Diff

Save as version, then next time you regenerate with a tweaked prompt the Diff tab will let you see exactly what changed step-by-step.

---

## Use Case 3 · Regenerate `Matcher` — soften 4xx

**Goal**: instead of throwing, catch RoboHire 4xx and emit `MATCH_FAILED` directly.

### Form

- Mode: **🔁 Regenerate** → `Matcher`
- Auto-fills: trigger `MATCH_RULE_CHECK_PASSED`, emits `[MATCH_PASSED_NEED_INTERVIEW, MATCH_PASSED_NO_INTERVIEW, MATCH_FAILED]`

### Business description

```
1. Fetch the requirement detail from partner-pg (jrId from event)
2. Build resume text + jd text
3. Call RoboHire /match-resume
   - 4xx error: DO NOT throw — return { ok: false, error } and skip to emit MATCH_FAILED
4. If matchResult.ok: saveMatchResultsToPartnerPg
5. Mirror Candidate_Match_Result into Allmeta Neo4j
6. Decide emit by score: high+need_interview → MATCH_PASSED_NEED_INTERVIEW;
   high+no_interview → MATCH_PASSED_NO_INTERVIEW; low → MATCH_FAILED
```

### What you get back

The `match` step body should mirror the production agent's pattern from few-shot:

```ts
try {
  const r = await matchResumeDirect({ resume: resumeText, jd: jdText }, { traceId });
  return { ok: true as const, data: r.data };
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    return { ok: false as const, error: `${e.code}: ${e.message}` };
  }
  throw e;
}
```

---

## Use Case 4 · Regenerate `RuleCheck` (most complex)

**Goal**: stress-test codegen on the 649-line agent.

### Form

- Mode: **🔁 Regenerate** → `RuleCheck`
- Auto-fills: trigger `RESUME_PROCESSED`, emits `[MATCH_RULE_CHECK_PASSED, MATCH_RULE_CHECK_FAILED]`

### Business description

```
Triggered by RESUME_PROCESSED (data has candidate_id, parsed_resume_json, upload_id).

Per JR:
1. List recruiting jobs as requirements (the JR fan-out is implicit; just describe one JR)
2. getParsedResume by candidate_id
3. Mirror the requirement into Allmeta Neo4j (JR node)
4. Run rule check (buildRuleCheckInput + runRuleCheck)
5. Write the audit row back to partner-pg
6. Write Candidate_Match_Result.rule_check_* fields into Allmeta
7. Emit MATCH_RULE_CHECK_PASSED on verdict='pass', else MATCH_RULE_CHECK_FAILED
```

### Expected outcome

- Spec will have 6-7 steps (the LLM won't replicate 649 lines, but the skeleton will be right)
- Compile **may have 1-2 errors** — `buildRuleCheckInput`'s input shape isn't fully expressed in the tool registry; LLM may guess fields
- Operator role: read the compile diagnostics → fix the Code tab → re-compile → save

This is the **realistic codegen workflow**: MVP draft, operator polishes, save.

---

## Use Case 5 · Regenerate `InterviewInviter`

**Goal**: verify the v2 prompt reproduces the GoHire-2xx-but-success-false fix correctly.

### Form

- Mode: **🔁 Regenerate** → `InterviewInviter`
- Auto-fills: trigger `INTERVIEW_INVITATION_REQUESTED`, emits `[INTERVIEW_INVITATION_SENT, INTERVIEW_INVITATION_FAILED]`

### Business description

```
1. If event payload missing resume_text, backfill via getParsedResume(candidate_id)
2. If event payload missing jd_text, backfill via getRequirementDetail(job_requisition_id)
3. Call RoboHire /invite-candidate
   - 4xx → NonRetriableError
   - HTTP 2xx but body.success === false → ALSO NonRetriableError (GoHire rejection)
4. On success: write a CommunicationLog row into Allmeta Neo4j
5. Write an InterviewRecord (status=invited) into Allmeta Neo4j
6. Emit INTERVIEW_INVITATION_SENT; failures emit INTERVIEW_INVITATION_FAILED
```

### Few-shot match

The `invite` step body should reproduce the production agent's GoHire pattern (it's in the few-shot index):

```ts
try {
  const r = await inviteCandidateDirect(input, { traceId });
  if (!r.data.success) {
    throw new NonRetriableError(`GoHire rejected invite: ${JSON.stringify(r.data)}`);
  }
  logger.info(`[${AGENT_NAME}] invite sent · candidate=${candidateId} url=${r.data.invite_url}`);
  return r;
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    throw new NonRetriableError(`RoboHire invite-candidate 4xx: ${e.code}`);
  }
  throw e;
}
```

### Save → Diff

After save, the Diff tab compares against the production agent — useful for measuring "LLM-generated vs hand-written" quality gap on a real codebase target.

---

## What each pipeline stage hands you

| Stage | UI surface | Persisted? |
|---|---|---|
| **Form** | Left rail form state | localStorage (browser only) |
| **LLM A — steps[]** | Spec tab populates (read-only) | No |
| **Template render** | Code tab populates | No |
| **LLM B — step bodies** | Code tab `step.run` callbacks fill in | No |
| **Compile** | Right rail ✓ OK or grouped diagnostics | No |
| **Save as version** | Confirmation pill with new version label | ✅ AgentVersion row, capturedFrom='codegen' |
| **Diff tab** | Side-by-side vs the active saved version | (read-only view) |

Iteration loop:
- Tweak Form / business description → regenerate
- Hand-edit Code tab → re-compile
- Satisfied → Save as version
- Diff against previous saves to confirm intent

## v2 limits (carried over from research doc §10)

- ~30-90s per generate. LLM A + LLM B + project tsc overlay.
- Per-step body quality tracks few-shot match — same-stage + same-tool targets do best.
- **Code is not hot-loaded into Inngest.** Save as version stores the codeBlob; getting it running still requires (a) writing the file to `server/inngest/agents/<slug>.ts`, (b) restarting Next.js. Phase 5 (see [phase-4-5 decision doc](./2026-05-25-codegen-phase4-phase5-decision.md)) addresses this — deferred for now in favor of CI-redeploy.
