# AI-Native Codegen — Feasibility, Layered Evaluation, and Roadmap

> 2026-05-25 · Companion to
> [evaluation walkthrough](./2026-05-25-codegen-evaluation-walkthrough.md) and
> [end-to-end use cases](./2026-05-25-codegen-end-to-end-use-cases.md).
>
> Scope: what "AI-native generation of workflow agents that actually run"
> means, what we've already covered, what's missing, and what the next
> bundles should be.

---

## Part 1 — Eight layers of correctness

"The generated agent runs" is not one fact — it's eight. Each layer adds
real-world confidence and costs more to verify.

| # | Layer | What it proves | Mechanism (existing) | Status |
|---|---|---|---|---|
| L1 | Compiles | TS legal | `tsc --noEmit` overlay (Phase 0c) | ✅ |
| L2 | Matches AO patterns | NonRetriableError, try/catch, logger present | static reviewer 8+1 rules (E1+J4) | ✅ |
| L3 | Structural match to production | imports/step IDs/tool refs overlap | structural diff (D4) | ✅ |
| L4 | Behavioral sequence matches | step.run order + emit names ≈ ground truth | TS-AST behavioral analyzer (E3) | ✅ |
| L5 | Runs in sandbox under mocks | handler resolves, emits expected event | vm dynamic runner (Bundle H) | ✅ |
| **L6** | **Real tool wrappers accept payload** | **canonical Allmeta fields, partner-pg column names, RoboHire request shape** | **Bundle J (this commit)** | ✅ new |
| L7 | Real event payloads drive handler correctly | event.data shape from RAAS matches what code reads | Bundle N (planned) | ❌ |
| L8 | Inngest accepts registration + first invocation | function id unique, trigger event reachable, retries config valid | Bundle L (planned) | ❌ |

L1-L6 done as of this commit. L7-L8 are the open frontier.

---

## Part 2 — Where AI agents replace humans in the loop

Mapping the AI-native pattern to our pipeline:

```
                            (today)               (target — bundles below)
                            ────────              ──────────────────────
spec design                 LLM                   ✓
tool selection (callsLib)   LLM, sees signatures  LLM, sees signatures + canonical fields (J ✓)
step body                   LLM + few-shot        LLM + few-shot + ontology + real call patterns (J ✓)
test case design            LLM (declarative)     ✓
mock fidelity               always-OK stubs       strict-validating Allmeta mocks (J ✓)
                                                  real-event-shape mocks (N ✗)
verdict decision            human reads report    LLM reads report → decide refine vs accept (M ✗)
prose refinement            human edits           LLM rewrites prose to fix gaps (M ✗)
Inngest reg check           human starts dev      child_process spawn + introspect (L ✗)
ship to prod                human pastes commands ✓ Open-PR helper (G-lite ✓)
```

The pieces in `✗` are what AI-native fully means. We have the first half;
bundles K/L/M close the rest.

---

## Part 3 — What Bundle J just shipped

**Goal**: close L6 — when the generated code mutates an Allmeta entity, the
fields it sends must be ontology-canonical, not LLM-guessed from
parsed-resume JSON.

### J1 — `canonical-schemas.ts`

Static snapshot of the 8 Allmeta entities AO writes:

| Entity | PK | Field count | Writer |
|---|---|---|---|
| Job_Requisition | job_requisition_id | 39 | writeJobRequisitionInstance |
| Job_Posting | job_posting_id | 19 | writeJobPostingInstance |
| Candidate | candidate_id | 31 | writeCandidateInstance |
| Resume | resume_id | 24 | writeResumeInstance |
| Candidate_Match_Result | candidate_match_result_id | 10 | writeCandidateMatchResultInstance |
| Communication_Log | communication_log_id | 8 | writeCommunicationLogInstance |
| Interview_Record | interview_record_id | 16 | writeInterviewRecordInstance |
| Application | application_id | 10 | writeApplicationInstance |

Each field carries: `name`, `type` (string/integer/date/List<string>/…), and
optional `pk`, `required`, `fk`, `note` markers.

Lifted from the production writer files' banner comments. Source path
embedded in the file so re-sync is one grep away.

### J2 — `ToolRegistryEntry.canonicalEntity`

7 allmeta writer entries in `tool-registry.raas.ts` now point at their
canonical entity. Codegen knows which entity each tool writes.

### J3 — Prompts inject the canonical block

When the LLM is filling a step body that `callsLib: 'allmeta.writeCandidate'`,
the step body filler prompt now contains:

```
- allmeta.writeCandidate [allmeta]
    import { writeCandidateInstance } from '@/lib/allmeta-writers';
    writeCandidateInstance(input: { candidate_id: string; [k: string]: unknown }): Promise<{ ok: boolean; error?: string }>
    Mirror a candidate row into the Allmeta Neo4j ontology.
    Canonical Candidate fields (from AllmetaOntology v0.1.015):
      Guidance: Codegen MUST call writeCandidateInstance({ candidate_id, parsed: parsedResume.data }) — pass the WHOLE parsed-resume object under `parsed`, the writer normalizes field names internally (name / phone / address / work_years). Do NOT manually map each canonical field — too easy to typo.
        candidate_id                          string         PK, required
        employee_id                           string
        is_locked                             boolean
        name                                  string         default '未命名候选人' if parser missed
        phone                                 string
        email                                 string
        gender                                string
        birth_date                            date
        ...
      STRICT: allmeta rejects unknown fields. The writeXInstance functions normalize internally — operator-supplied keys outside this list are silently dropped.
```

LLM now has the *exact* canonical list + the AO normalizer convention. Should
default to passing `parsed: parsedResume.data` instead of hand-mapping 30
fields wrong.

### J4 — Reviewer rule `allmeta-canonical-fields-only`

Scans the source for every `writeXInstance({...})` call site, extracts
top-level object-literal keys, flags any key not in the canonical schema
(allowing the `parsed` / `requirement` wrappers because the writers normalize
inside).

3 new tests:
- Bad field (`full_name` instead of `name`) → warning fires
- `parsed: {...}` wrapper → no warning
- Pure canonical fields → no warning

### J5 — Dynamic runner: strict Allmeta mocks

Previously when the test case didn't specifically mock an allmeta call, the
runner installed a permissive `{ ok: true }` returner. Bundle J replaces this
with a **strict mock** that mirrors real allmeta server behavior: unknown
fields cause `{ ok: false, error: 'unknown_field_X' }`.

Effect: if the LLM generated `writeCandidateInstance({ candidate_id, full_name })`,
the dynamic runner now returns `ok: false`, the agent's `if (!r.ok)
logger.warn(...)` branch fires, and the test case can detect that allmeta
"silent rejection" is happening.

Catches the production bug at sandbox time.

---

## Part 4 — Worked example: Resume Parser with + without Bundle J

### Without J (pre this commit)

Operator generates Resume Parser. LLM sees `writeCandidateInstance(input: {
candidate_id: string; [k: string]: unknown })` only. It writes:

```ts
await writeCandidateInstance({
  candidate_id: r.candidate_id,
  full_name: parsed.data.name,   // ← wrong: canonical is 'name'
  phone_number: parsed.data.phone,  // ← wrong: canonical is 'phone'
  birthday: parsed.data.birthDate,  // ← wrong: canonical is 'birth_date'
});
```

- Compile: ✓ (because `[k: string]: unknown`)
- Reviewer: ✓ (no canonical-field rule existed)
- Behavioral: ✓ (step ran, tool called)
- Dynamic: ✓ (mock returned `{ ok: true }`)
- Save as version → Open PR → ship → **production silently drops these
  3 fields**. Candidate has no name/phone/birth in Neo4j. Discovered weeks
  later when a downstream query for "candidates born after 1995" returns
  empty.

### With J

Same generation, but now the LLM prompt also contained the canonical schema
+ the "pass WHOLE parsed object under `parsed`" guidance. LLM writes:

```ts
await writeCandidateInstance({
  candidate_id: r.candidate_id,
  parsed: parsedResume.data,   // ← writer normalizes
});
```

- Compile: ✓
- **Reviewer: ✓** (no unknown fields)
- Behavioral: ✓
- **Dynamic: ✓** (strict mock accepts canonical input)
- Ship → real allmeta accepts → Neo4j has name/phone/birth populated.

OR: if LLM still got it wrong (~10% chance after Bundle J), say it wrote
`birthday` instead of `birth_date`:

- Compile: ✓
- **Reviewer: ❌ warning** `birthday is not in the canonical Candidate
  schema`
- Behavioral: ✓
- **Dynamic: ❌** `unknown_field_birthday (not in canonical Candidate schema)`
  → test case for happy-path now FAILS

Two layers catch it pre-merge. Operator clicks ✨ Suggest fix → LLM patches
it → re-evaluate → green → ship.

---

## Part 5 — Roadmap to L7 + L8

### Bundle N — Real event payloads as test fixtures

Today: `test-case-generator.ts` synthesizes event payloads from heuristics
based on the event name. Bundle N reads a real recent EventInstance row
from the local DB matching the agent's trigger event and uses its `data`
as the happy-path event payload.

**Architecture:**
- `lib/agent-codegen/eval/real-event-fixtures.ts` — Prisma query to pull
  recent EventInstance rows by `name`, picks one with non-trivial payload
- New TestCase category: `real-event-replay`
- Operator UI shows the picked event's id + timestamp for traceability

**Impact:**
- Catches "code reads `event.data.requirement_id` but production events have
  `event.data.job_requisition_id`" class of bug
- ~2 hours of work, low risk

### Bundle L — Inngest registration smoke

Today: generated agent might have a function id that collides, an unreachable
trigger event, or a runtime registration error — we don't know until prod.

**Architecture:**
- New API `POST /api/codegen/inngest-smoke` writes the generated code to
  `/tmp/codegen-smoke-<uuid>/agent.ts`, spawns a child node process that:
  - Imports the agent
  - Calls `serve({ functions: [agent] })` in an ephemeral namespace
  - Pings local Inngest dev's `GET /v0/functions` to confirm the function appeared
  - Reports success / failure (with error message)
- UI: new "Smoke test in Inngest" button in EvaluationPanel; result shown
  as L8 row in the verdict

**Impact:**
- L8 confidence: "Inngest dev server actually registered this function"
- ~3-4 hours, medium complexity (child_process management + Inngest CLI dependency)

### Bundle M — AI auto-iteration

The most "AI-native" piece: when verdict is PARTIAL or DRAFT, an LLM agent
reads the eval report, identifies the gap, refines the business description
prose, and re-runs codegen + eval. Up to N=3 iterations with monotonic
improvement guard.

**Architecture:**
- `lib/agent-codegen/llm/auto-iterator.ts` — single LLM call:
  - Input: (form, current businessLogic, current code, full EvaluationReport)
  - Output: { refinedBusinessLogic, rationale, expectedDelta }
- API: `POST /api/codegen/auto-iterate` — runs the full loop server-side
- UI: "Auto-iterate ≤ 3 rounds" toggle in EvaluationPanel
- Stop conditions: (a) verdict = FULL, (b) score did not improve from previous
  round (avoid infinite waste), (c) 3 iterations reached

**Impact:**
- True closed-loop AI: AI generates → AI evaluates → AI refines → AI
  regenerates. Operator can sit back unless the loop bails.
- Cost: 1-3x current generation cost
- Bounded scope: refines PROSE only, not Form. Identity / wire-up stay
  human (no scope creep where AI rewrites slug).

### Why this order

| Bundle | Closes layer | Risk | Operator value |
|---|---|---|---|
| **J (✓ done)** | L6 | low | catches silent allmeta rejection — big quality jump |
| **N** | L7 | low | catches event-shape mismatch — second biggest quality jump |
| **L** | L8 | medium (child_process) | confidence "really runs" — high-stakes feature |
| **M** | meta-loop | medium (cost runaway) | hands-off iteration — true AI-native feel |

Recommendation: ship J (done), then N, then either L or M depending on
which gap operators hit more in real use.

---

## Part 6 — When this is "done"

The pipeline is fully AI-native when:

1. ✅ Operator types: business goal + identity form
2. ✅ AI extracts spec, fills bodies, renders code
3. ✅ AI evaluates structurally + statically + sandboxed
4. ✅ AI catches canonical-field violations (J)
5. ❌ AI catches real-event-shape mismatches (N)
6. ❌ AI verifies Inngest accepts registration (L)
7. ❌ AI iterates on its own output until verdict is high (M)
8. ❌ AI proposes PR with attached eval report

We're at 4/8 with Bundle J shipped. N+L+M move us to 7/8. The 8th (PR
proposal) is straightforward once N+L+M land.

---

## Limits — what AI-native can NEVER replace

| Constraint | Why |
|---|---|
| Operator picking the trigger event | Tells the workflow which incoming signal matters |
| Operator picking the agent name | Naming carries product intent |
| PR review by a human | Security + judgment + organizational responsibility |
| First production incident response | Diagnostic context AI doesn't have yet |
| Tool registry curation | Defines AI's reachable surface — too sensitive for AI to self-extend without humans approving lib boundaries |

These stay human regardless of how AI-native we go. Bundle M's prose
refinement explicitly does NOT touch the form (slug, trigger, etc.) for
this reason.
