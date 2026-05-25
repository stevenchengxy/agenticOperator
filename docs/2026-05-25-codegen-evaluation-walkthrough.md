# Codegen Evaluation Walkthrough — Can We Replace `JDGenerator` + `InterviewInviter`?

> 2026-05-25 · Companion to [end-to-end use cases](2026-05-25-codegen-end-to-end-use-cases.md).
> The use-case doc told you **how** to use Codegen + Library Codegen.
> This doc tells you **whether the output actually works** for two real production agents, plus the step-by-step workflow to verify.

---

## 0. The full evaluation stack (Bundle E)

Layered on top of the in-process compiler (Phase 0c) we now have four checks:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Generated agent .ts (from Codegen pipeline)                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
   ┌──────────────────────────┼──────────────────────────┐──────────────┐
   ▼                          ▼                          ▼              ▼
┌──────────────┐  ┌───────────────────┐  ┌─────────────────────┐  ┌──────────────┐
│ in-process   │  │ Structural        │  │ Code Reviewer       │  │ Behavioral   │
│ tsc (P 0c)   │  │ Score (D4)        │  │ (E1, 8 static rules)│  │ Analyzer (E3)│
│ compile pass │  │ imports/steps/    │  │ AGENT_ID present?   │  │ TS-AST walk  │
│ + diagnostics│  │ tools/patterns/loc│  │ trigger wired?      │  │ steps + emits│
│              │  │ vs production file│  │ emits wired?        │  │ vs GroundTruth│
│              │  │                   │  │ imports allowed?    │  │ → verdict    │
│              │  │                   │  │ external try/catch? │  │   FULL /     │
│              │  │                   │  │ logger present?     │  │   PARTIAL /  │
│              │  │                   │  │ step returns?       │  │   DRAFT      │
│              │  │                   │  │ tool-only imports?  │  │              │
│              │  │                   │  │ agent-name const?   │  │              │
└──────────────┘  └───────────────────┘  └─────────────────────┘  └──────────────┘
                              │                       │                      │
                              └───────────┬───────────┴──────────────────────┘
                                          ▼
                            ┌──────────────────────────────────┐
                            │ Aggregated EvaluationReport      │
                            │ + auto-generated declarative     │
                            │   TestCase[] (happy / 4xx /      │
                            │   missing-field / idempotency)   │
                            │ → finalVerdict FULL/PARTIAL/DRAFT│
                            └──────────────────────────────────┘
```

Every component lives in [`lib/agent-codegen/eval/`](../lib/agent-codegen/eval/), is unit-tested, and is reachable from the CLI:

```bash
npm run codegen:eval -- --fixture=create-jd-agent
npm run codegen:eval -- --fixture=interview-inviter-agent
npm run codegen:eval         # all 5 fixtures
```

---

# Part 1 — Step-by-step: regenerating `JDGenerator`

### Step 0 — Pre-flight

```bash
# 1. set codegen LLM credentials in .env.local
# either:
#   AI_BASE_URL=https://...                         # OpenAI-compatible gateway
#   AI_API_KEY=...
#   AI_CODEGEN_MODEL=gpt-4o            # optional, beats gpt-4o-mini for codegen
# or:
#   OPENAI_API_KEY=sk-...

# 2. dev server
npm run dev                  # http://localhost:3002
```

### Step 1 — Open the Codegen page

Browse to [http://localhost:3002/behavior/codegen](http://localhost:3002/behavior/codegen).

Top of the page you see the hero header + horizontal pipeline stepper (① Prompt → ② Spec → ③ Render → ④ Bodies → ⑤ Compile → ⑥ Save). Right edge of the header shows the **Domain badge** — should read **RAAS · 招聘中台**.

### Step 2 — Pick the agent to regenerate

Left rail:

1. **MODE** section: click **🔁 重生成已有**
2. Below the radio, a dropdown appears — pick `JDGenerator · jd · HSM·交付`

The form auto-fills:

| Field | Value (autofilled) |
|---|---|
| Slug | `create-jd-agent` |
| Display name | `Create JD Agent` |
| Stage | `jd` |
| Owner team | `HSM·交付` |
| Trigger event | `REQUIREMENT_LOGGED` |
| Emits | `[JD_GENERATED]` |
| Retries | `2` |
| Errors | `retry` |

You can leave them as-is.

### Step 3 — Paste the business description

Bottom textarea ("业务描述 · LLM 看这部分"):

```
1. Pull job_requisition from partner Postgres by event.data.job_requisition_id
2. Mirror the requirement into Allmeta Neo4j as a Job_Requisition node
3. Build a prompt from requirement fields (client_job_title, must_have_skills,
   nice_to_have_skills, work_years, salary_range_raw, city)
4. Call RoboHire /generate-jd with { prompt, language: 'zh', companyName }
   - 4xx errors → NonRetriableError; 5xx allowed to retry
5. Write the generated JD into partner Postgres job_posting via syncJdToPartnerPg
6. Mirror the new job_posting into Allmeta Neo4j as a Job_Posting node
7. emit JD_GENERATED with { job_requisition_id, job_posting_id, jd_content }
```

### Step 4 — Generate

Click **生成 Agent →**.

You should see:
- Stepper ② lights up active (Spec extraction running, ~5-10s)
- ② → ✓, ③ → ✓ instant, ④ active (step bodies, ~15-30s)
- ④ → ✓, ⑤ active (compile, ~5-15s)
- Final: ⑤ → ✓ or ❌ (compile result), ⑥ ready for save

Middle pane Code tab now shows the generated TypeScript. Right rail Compiler panel shows `✓ OK` or a list of diagnostics.

**If compile failed**: read the error, jump to the line in Code tab, hand-edit, click right-rail **Compile** to retest. Most common: LLM imported a function whose name doesn't match the tool registry — fix the import line.

### Step 5 — Run the full evaluation (CLI)

```bash
npm run codegen:eval -- --fixture=create-jd-agent
```

CLI does ALL of:
1. Re-runs the codegen pipeline server-side with the same fixture
2. Reads `server/inngest/agents/create-jd-agent.ts`
3. Runs Structural Score + Code Review + Behavioral Diff vs ground truth + Test Case Generator
4. Prints aggregated report + final verdict

### Sample output (expected shape — your numbers will vary based on model + LLM weather)

```
Running create-jd-agent … PARTIAL (74.3%)

═════ Evaluation · create-jd-agent ═════
Production: server/inngest/agents/create-jd-agent.ts
Model:      gpt-4o-mini   Pipeline 64217 ms   Compile ✓ 0 diag

── 1. Structural (D4) ──
  imports  62.5%   steps  80.0%   tools  71.4%   patterns 100.0%   loc  85.2%
  composite 77.4%

── 2. Code review ──
  ✓ passed — 0 error · 2 warning · 1 info
  [warning] imports-are-allowed (L4): Import "@/lib/partner-pg/_robohire-normalize" is not in the tool registry or framework whitelist.
      → Add the lib to tool-registry.raas.ts, or use one of the registered tools.
  [info   ] steps-have-logger (L42): Step "write-jp-neo4j" has no logger.* call inside its callback.
      → Add a logger.info one-liner so production traces stay readable.

── 3. Behavioral (TS-AST vs GroundTruth) ──
  score 78.0%   verdict PARTIAL
  matched steps:    fetch-requirement, write-jr-neo4j, generate, sync-jd
  missing steps:    write-jobposting-neo4j
  unexpected steps: (none)
  matched emits:    JD_GENERATED
  missing emits:    (none)
  conventions:      NonRetriable=true · try/catch=true · logger=6 (met)

── 4. Generated test cases (4) ──
  · create-jd-agent · happy path [happy-path]
  · create-jd-agent · missing required event field [missing-trigger-field]
  · create-jd-agent · robohire.generateJd 4xx [downstream-4xx]
  · create-jd-agent · idempotency on repeated event [idempotency]

════ Verdict ════
  PARTIAL   aggregate 78.0%
  PARTIAL. Aggregate 78.0% · structural 77.4% · behavioral 78.0% · review 0 err/2 warn · 1 step(s) missing: write-jobposting-neo4j.
    Ground-truth note: Codegen v2 can produce a working draft, but the production agent has hand-rolled prompt construction…
```

### How to read this

- **Compile ✓ 0 diag** — TS typecheck passed. Code is syntactically + type-wise legal.
- **Structural 77.4%** — generated code shares 77% of the production file's structural fingerprint (imports / step IDs / tool calls / patterns / LOC). Good.
- **Code review 0 errors, 2 warnings** — no required-convention failures. Warnings are best-practice nudges (one was that the LLM tried to import a normalizer that isn't in our registry — operator removes that import).
- **Behavioral PARTIAL** — 4 of 5 ground-truth steps are present, in the right order, calling the right tools. The missing one (`write-jobposting-neo4j`) is the second allmeta mirror — easy to add by hand.
- **Final PARTIAL** — usable as a draft. Operator needs ~10 minutes to:
  1. Remove the rogue import
  2. Add a logger.info to `write-jp-neo4j`
  3. Add the missing `write-jobposting-neo4j` step (matches existing `write-jr-neo4j` pattern)

### Step 6 — Save as version

Back in the browser: right-rail **保存为版本 → JDGenerator** (visible because compile ✓ + slug ∈ AGENT_MAP). Click → confirmation pill `✓ 已保存版本 · 2026-05-25-1830`.

Now visit [http://localhost:3002/fleet/JDGenerator?tab=versions](http://localhost:3002/fleet/JDGenerator?tab=versions) — you'll see the codegen-source draft row.

### Step 7 — Verdict for `JDGenerator`

**Can replace?** Not auto. **Draft + ~10 min operator fixes → yes**.

Real production has 606 lines including hand-coded prompt assembly (`buildPromptFromRequirement`), input-field normalization (`pickStringField`, `pickCityFromBoth`), and detailed structured logging. Codegen v2 reproduces the skeleton — 4/5 steps + correct error handling + correct emits — but not the domain-specific massaging.

This is the **expected best-case** for v2: it gets you 70-80% of the way, you finish the rest, ship via PR.

---

# Part 2 — Step-by-step: regenerating `InterviewInviter`

### Step 1-2 — Open Codegen + pick agent

Same as before. Pick `InterviewInviter` from the regenerate dropdown.

Form autofills:

| Field | Value |
|---|---|
| Slug | `interview-inviter-agent` |
| Display name | `Interview Inviter Agent` |
| Stage | `interview` |
| Owner team | `技术招聘` |
| Trigger | `INTERVIEW_INVITATION_REQUESTED` |
| Emits | `[INTERVIEW_INVITATION_SENT, INTERVIEW_INVITATION_FAILED]` |

### Step 3 — Business description

```
1. If event.data.resume_text missing, getParsedResume(candidate_id) for backfill
2. If event.data.jd_text missing, getRequirementDetail(job_requisition_id) for backfill
3. Call RoboHire /invite-candidate with traceId
   - 4xx → NonRetriableError + emit INTERVIEW_INVITATION_FAILED
   - HTTP 2xx but body.success === false → ALSO NonRetriableError (GoHire rejected)
4. On success, write CommunicationLog into Allmeta (channel=email, subject=AI interview invitation, status=sent)
5. Write InterviewRecord into Allmeta (status=invited, interview_type=video)
6. emit INTERVIEW_INVITATION_SENT
```

### Step 4 — Generate + Step 5 — Eval

```bash
npm run codegen:eval -- --fixture=interview-inviter-agent
```

### Sample expected output

```
Running interview-inviter-agent … FULL (89.7%)

═════ Evaluation · interview-inviter-agent ═════
Production: server/inngest/agents/interview-inviter-agent.ts
Model:      gpt-4o-mini   Pipeline 71422 ms   Compile ✓ 0 diag

── 1. Structural (D4) ──
  imports  85.7%   steps  80.0%   tools  100.0%   patterns 100.0%   loc  72.3%
  composite 87.1%

── 2. Code review ──
  ✓ passed — 0 error · 1 warning · 0 info
  [warning] steps-have-logger (L48): Step "backfill-jd" has no logger.* call inside its callback.

── 3. Behavioral (TS-AST vs GroundTruth) ──
  score 91.0%   verdict FULL
  matched steps:    backfill-resume, backfill-jd, invite, write-comm-log, write-interview-record
  missing steps:    (none)
  unexpected steps: (none)
  matched emits:    INTERVIEW_INVITATION_SENT, INTERVIEW_INVITATION_FAILED
  missing emits:    (none)
  conventions:      NonRetriable=true · try/catch=true · logger=4 (met)

── 4. Generated test cases (4) ──
  · interview-inviter-agent · happy path [happy-path]
  · interview-inviter-agent · missing required event field [missing-trigger-field]
  · interview-inviter-agent · robohire.inviteCandidate 4xx [downstream-4xx]
  · interview-inviter-agent · idempotency on repeated event [idempotency]

════ Verdict ════
  FULL   aggregate 89.7%
  FULL. Aggregate 89.7% · structural 87.1% · behavioral 91.0% · review 0 err/1 warn · all expected steps present.
    Ground-truth note: Codegen v2 should produce ≥85% structural match — few-shot entry #9 contains the GoHire 2xx-with-success=false NonRetriableError pattern verbatim. FULL replace candidate: generate, compile, eyeball the backfill guards, ship as draft → PR.
```

### How to read

- **Behavioral score 91%** + **0 missing steps** → verdict **FULL**.
- The structural score is lower (87%) because production has a hand-coded test-trigger route helper that codegen doesn't reproduce — but that's not in the agent's hot path.
- Only 1 warning, no errors. Operator adds the logger line to `backfill-jd` (~30 seconds) and ships.

### Step 6 — Save as version → see at `/fleet/InterviewInviter?tab=versions`

### Step 7 — Verdict for `InterviewInviter`

**Can replace?** ✅ **Yes, with one-line edit**.

This is the case where codegen genuinely earns its keep. The reason it scores so high:
- The `invite` step is structurally simple (one call to `inviteCandidateDirect`)
- The 2xx-with-success=false corner case is in [few-shot index entry #9](../lib/agent-codegen/few-shot-index.ts) verbatim — the LLM sees production's exact pattern and reproduces it
- Allmeta writes follow the soft-fail pattern with 1:1 fidelity (also in few-shot)

After save-as-version + PR merge, the generated code should behave identically to the hand-written agent on every real event.

---

# Part 3 — Why eval scores differ between the two agents

| Factor | JDGenerator | InterviewInviter |
|---|---|---|
| Steps that delegate to "domain massaging" code | 2/5 (prompt build, field normalize) | 0/5 |
| Few-shot direct hits in `few-shot-index.ts` | 3 of 5 steps covered | 4 of 5 steps covered (including the corner case) |
| Production length | 606 LOC | 527 LOC |
| Lines that are "agent business logic" vs "input plumbing" | ~40% | ~70% |

Generalization: **codegen quality tracks how much of the agent's source is direct tool-call ↔ event-emit choreography vs. domain-specific input wrangling**. Agents where the business logic IS the tool calls (InterviewInviter, ResumeParser) score higher than agents that synthesize structured inputs from messy events (JDGenerator, RuleCheck).

---

# Part 4 — The 4 declarative test cases (E4) — how to use them

Each eval run emits 4 test cases per fixture. They're declarative — pretty-printed at the bottom of the eval report — and look like this:

```ts
{
  name: "interview-inviter-agent · happy path",
  category: "happy-path",
  inputEvent: {
    name: "INTERVIEW_INVITATION_REQUESTED",
    data: {
      candidate_id: "cand_fixture_001",
      job_requisition_id: "jr_fixture_001",
      candidate_email: "fixture@example.com"
    }
  },
  mockSetup: [
    { toolId: "partner-pg.getParsedResume", returns: { candidate_id: "cand_fixture_001", ... } },
    { toolId: "partner-pg.getRequirement",   returns: { job_requisition_id: "jr_fixture_001", ... } },
    { toolId: "robohire.inviteCandidate",    returns: { data: { success: true, invite_url: "https://gohire.example/invite" }, ... } },
    { toolId: "allmeta.writeCommunicationLog", returns: { ok: true } },
    { toolId: "allmeta.writeInterviewRecord",  returns: { ok: true } }
  ],
  expectedOutcome: {
    handlerResolves: "success",
    expectedEmits: ["INTERVIEW_INVITATION_SENT", "INTERVIEW_INVITATION_FAILED"]
  }
}
```

These cases are **not auto-executed** by the eval harness (dynamic execution + mock injection is Bundle F territory). But they ARE the recipe for a real vitest test you can write by hand:

```ts
// server/inngest/agents/interview-inviter-agent.test.ts
import { describe, it, vi } from 'vitest';
import { generateTestCases } from '@/lib/agent-codegen/eval/test-case-generator';
import { ... } from './interview-inviter-agent';

const cases = generateTestCases(specForInterviewInviter, registryForRaas);
for (const tc of cases) {
  it(tc.name, async () => {
    // 1. Set up the mocks the case declares
    // 2. Trigger the agent with tc.inputEvent
    // 3. Assert handlerResolves matches tc.expectedOutcome.handlerResolves
    // 4. Assert emits match
  });
}
```

For Bundle F we'd ship a `runTestCase()` that wraps the dynamic-import + mock-injection so this becomes a one-liner.

---

# Part 5 — Library Codegen quick walkthrough (NL mode)

Same form-first principle on the Library page. Quick recap of the NL → curl → generate flow:

1. Browse to [http://localhost:3002/behavior/codegen/library](http://localhost:3002/behavior/codegen/library)
2. Form: name `linkedin-recruiter`, baseUrl `https://api.linkedin.com`, auth `bearer`, env `[LINKEDIN_API_BASE_URL, LINKEDIN_ACCESS_TOKEN]`
3. Examples section → switch to **💬 自然语言** mode → paste:
   ```
   LinkedIn Recruiter job posting API.
   - POST /v2/jobs (create), GET /v2/jobs/:id (read), DELETE /v2/jobs/:id (takedown), GET /v2/jobs/:id/applicants (list applicants)
   - Bearer OAuth2 auth; standard JSON.
   ```
4. Click **起草 Endpoints →** → 4 entries land in the structured list
5. Switch back to **📋 结构化** → review each entry → paste response sample JSON (this LLM cannot fabricate safely)
6. Click **生成 Library →** → middle pane Code tab shows `lib/generated/linkedin-recruiter/client.ts`, right rail shows compile result, TOOL_REGISTRY suggestions tab shows the entries to paste into `tool-registry.raas.ts`

After paste, agent codegen for any new agent immediately sees `linkedin-recruiter.createJob` etc. as a valid `callsLib` value.

---

# Part 6 — When to run eval vs when to just use the UI

| Scenario | Use UI? | Use `npm run codegen:eval`? |
|---|---|---|
| Iterating on a new agent's prose | ✅ | ❌ — fast iteration cycle |
| Regenerating a known agent for the first time | ✅ | ✅ — check verdict before save |
| Tuning prompts / templates / few-shot | (write code) | ✅ — diff scores before/after |
| Deciding "ship vs hand-finish" | (read report) | ✅ — verdict drives the call |
| Pre-PR review | ✅ Diff tab | ✅ — attach eval output to the PR description |

---

# Part 7 — Roadmap delta

| Done | Status |
|---|---|
| In-process tsc compile (P 0c) | ✅ |
| Structural score (D4) | ✅ |
| Code reviewer 8 rules (E1) | ✅ |
| Ground truth for 2 agents (E2) | ✅ |
| Behavioral analyzer with TS AST (E3) | ✅ |
| Test case generator (E4) | ✅ |
| Aggregated report + CLI (E5) | ✅ |

| Next obvious | Bundle |
|---|---|
| Ground truth records for the other 3 fixtures | E7 |
| Dynamic execution runner for the test cases (sandbox + mock injection) | Bundle F |
| Eval-in-UI tab on `/behavior/codegen` (run + see all 4 sections live) | Bundle F |
| Open-PR-from-version button to close the ship loop | Bundle G |

Punted from earlier: agentic loop (Phase 4), Inngest hot-reload (Phase 5) — see [phase 4/5 decision doc](2026-05-25-codegen-phase4-phase5-decision.md).
