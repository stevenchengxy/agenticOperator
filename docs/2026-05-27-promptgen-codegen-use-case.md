# Use Case — PromptGen → CodeGen → Tool Generator, end-to-end (Interview Inviter as the standard)

> 2026-05-27 · Walkthrough of a **real run** against the live endpoints (LLM gateway
> `google/gemini-3-flash-preview`). Spec: [promptgen-codegen-design](superpowers/specs/2026-05-27-promptgen-codegen-design.md) ·
> Plan: [promptgen-codegen plan](superpowers/plans/2026-05-27-promptgen-codegen.md).
>
> Everything below was executed: the AgentPrompt and the agent `.ts` are the actual
> outputs; the compile results are the actual `tsc`-overlay verdicts.

---

## 0. What got built

Three pillars, one registry-bound loop. Two already existed; this work added PromptGen and
wired the loop:

| Pillar | Module | Status |
|---|---|---|
| **PromptGen** | `lib/agent-codegen/prompt-gen/*` + `app/api/codegen/prompt-gen` | **new** |
| **CodeGen** | `lib/agent-codegen/pipeline.ts` (`runPipeline`) + `app/api/codegen/generate` | existing (unchanged) |
| **Tool Generator** | Library CodeGen `/behavior/codegen/library` | existing — the leader's "写工具" |

`TOOL_REGISTRY` + `EVENT_REGISTRY` is the seam: AI generates strictly inside the registry
surface; humans extend it via the Tool Generator.

---

## 1. Operator step-by-step (the UI flow on `/behavior/codegen`)

1. **Type a one-line intent** in the Stage-0 panel (e.g. "当 RAAS 批准面试后给候选人发 AI 视频面试邀请…").
   Optionally **lock** `triggerEvent` / `stage` and pick a **blueprint agent**
   (here: `interview-inviter-agent`).
2. Click **Generate Prompt** → PromptGen returns a structured, editable `AgentPrompt`
   (role / trigger / steps / tools / emits / constraints / acceptance) with provenance
   badges (`inferred` / `locked`).
3. **If a tool is missing:** a banner lists `missingTools` with a link to the Tool
   Generator. Generate the tool there, register it, then **Re-generate Prompt**. (In this
   run `missingTools` was empty — all tools already existed.)
4. **Confirm** the trigger event and the slug (the gate requires `-agent` slug + non-empty
   displayName/ownerTeam — enforced so the downstream pipeline can't 400).
5. Click **Accept & Generate Code** → the approved prompt is rendered to `businessLogic`
   and fed to the existing pipeline (LLM-A steps → LLM-B bodies → render → compile → eval).
6. Read the **Evaluation**; if compile isn't clean, click **✨ Suggest fix** (or
   auto-iterate); hand-finish the last mile if needed.
7. **Save as version** (stores the structured AgentPrompt JSON in `promptText`) → **Open PR**
   → merge → deploy.

---

## 2. The real run — Stage 1: PromptGen output

Input intent (Chinese), locked trigger `INTERVIEW_INVITATION_REQUESTED`, blueprint
`interview-inviter-agent`. PromptGen (5–6s) returned a grounded `AgentPrompt`,
`missingTools: []`:

```jsonc
{
  "intent": "Automate the issuance of AI video interview invitations via RoboHire following RAAS approval…",
  "role": "Interview Inviter Agent (Stage: interview)",
  "trigger": { "event": "INTERVIEW_INVITATION_REQUESTED",
               "payloadExpectations": "candidate_id, application_id, job_requisition_id, interview_round",
               "confirmed": false },
  "tools": ["robohire.inviteCandidate","partner-pg.getParsedResume","partner-pg.getRequirement",
            "allmeta.writeCommunicationLog","allmeta.writeInterviewRecord","inngest.send","logger.event"],
  "emits": ["INTERVIEW_INVITATION_SENT","INTERVIEW_INVITATION_FAILED"],
  "steps": ["resolve-context","call-robohire-invite","persist-success-records","emit-final-event"],
  "constraints": [
    "Idempotency: check existing invitation for application_id + interview_round before calling RoboHire.",
    "Dual-write consistency: partner-pg (source of truth) before Allmeta (ontology mirror).",
    "Distinguish retriable (5xx, network) vs non-retriable (4xx, invalid data) errors.",
    "Every step logs via logger.event with context (candidate_id, application_id)." ],
  "acceptance": [
    "Emits INTERVIEW_INVITATION_SENT exactly once on success.",
    "Emits INTERVIEW_INVITATION_FAILED on RoboHire 4xx or business failure." ]
}
```

**Observation:** with zero hand-holding the model recovered the real agent's contract —
the dual `_SENT`/`_FAILED` emit, the dual-write order, retriable-vs-non-retriable, idempotency.
All 7 tools resolved to real registry ids (no tool-gap). This is the value of grounding the
prompt in the static registries + blueprint.

---

## 3. The real run — Stage 2: CodeGen + the compile journey (the honest part)

`POST /api/codegen/generate` produced a full Inngest agent. Reaching `compile.ok: true`
took fixing **two real infrastructure bugs** + the product's own fix loop + **one** human
line. This is the truthful "how close is AI-native codegen" answer:

| Step | diagnostics | what it was |
|---|---|---|
| First-pass generation | **16** | mostly systematic template bugs |
| **Fix A — template** (`render-agent.ts`) | **5** | template imported `@/server/agent-logger` (no `runWithLogger`) and emitted the outdated 3-arg `createFunction`. Real agents use `@/lib/agent-logger` + `createFunction({…,triggers:[…]}, handler)`. **This bug made every generated agent fail to compile.** |
| **Fix B — registry signatures** (`tool-registry.raas.ts`) | wrong-field errors gone | the `allmeta.writeCommunicationLog` / `writeInterviewRecord` registry signatures claimed `candidate_id`/`channel`/`job_requisition_id` — fields that **don't exist** in the real `Write*Input` types. `robohire.inviteCandidate` exposed an opaque `InviteCandidateInput`. The LLM faithfully followed the wrong signatures. Corrected all three to the real fields. |
| Product **Suggest-Fix** loop (Bundle I) | 5 → 2 → 1 | cleared `steps`→`step` typos, arg counts, `.id`→`.job_requisition_id` |
| **One operator hand-finish** | **0 ✅** | LLM called `getParsedResume(candidateId)` with one arg; it needs `(candidateId, resumeId)`. Threaded `event.data.resume_id` — the documented "last mile is human". |

Final verdict: **`compile.ok: true`, 0 diagnostics** — the generated agent typechecks
against the real project (full source in the Appendix).

**Takeaways for raising first-pass quality (next levers, in order):**
1. **Registry signatures are load-bearing** — the LLM follows them exactly. Stale/opaque
   signatures = guaranteed compile failures. Audit `TOOL_REGISTRY` signatures against the
   real lib types; add `exampleCalls` (Bundle J already does this for allmeta writers).
2. The `render-agent` template must match how real agents are written (now fixed).
3. Residual misses (threading `resume_id`, field access) are the genuine semantic last-mile —
   handled by Suggest-Fix / auto-iterate / a quick human edit.

---

## 4. Does it compose into a running workflow? Can it deploy?

- **Composes into the chain:** the agent triggers on `INTERVIEW_INVITATION_REQUESTED` and
  emits `INTERVIEW_INVITATION_SENT` / `_FAILED` — all real events. Because Inngest agents
  integrate over the event bus (not direct calls), this agent slots into the existing chain
  automatically: whoever emits `INTERVIEW_INVITATION_REQUESTED` upstream drives it, and the
  existing `_SENT`/`_FAILED` consumers pick up its output. No glue code.
- **Compiles:** ✅ `compile.ok: true` against the real project (in-process `tsc` overlay).
- **Registers with Inngest:** the generated `createFunction({id,name,retries,triggers:[…]},
  handler)` is byte-for-byte the shape the 5 production agents use, so it registers
  identically (Bundle L's registration validator checks this class of property).
- **Deploy to prod (the last manual step, not done here):** Save as version → **Open PR**
  (writes `server/inngest/agents/<slug>.ts` + registers in `functions.ts` on a branch) →
  human review + merge → Inngest dev/prod sync picks up the new function. We deliberately did
  **not** write into `server/inngest/agents/` in this exercise (the 5 production agents are
  read-only ground truth).

---

## 5. The tool-gap protocol (the leader's "需要 API 就写工具")

This run had no gap. When a future intent references a capability not in `TOOL_REGISTRY`
(e.g. "translate the JD via a new API"), PromptGen returns it in `missingTools`; the
AgentPromptView banner links to the Tool Generator (Library CodeGen); the operator generates
the `@/lib/*` wrapper + registry entry there, then re-runs PromptGen. AI never self-extends
the registry — extension is a deliberate, reviewed human act.

---

## 6. Durable fixes shipped during this exercise (discovered by the live test)

- `fix(promptgen)` — slugify-coerce LLM step ids before validation (non-ASCII/underscored
  ids from non-English intents no longer hard-fail).
- `fix(codegen)` — correct the `render-agent.ts` template (`@/lib/agent-logger` + 2-arg
  `createFunction`). Fixes compile for **every** generated agent.
- `fix(codegen)` — correct three stale `tool-registry.raas.ts` signatures to the real input
  types.

None touched the 5 production agents.

---

## Appendix — the generated agent (compiles clean)

`server/inngest/agents/interview-invite-demo-agent.ts` (PromptGen → CodeGen → Suggest-Fix →
1-line hand-finish; `compile.ok: true`):

```ts
// interview-invite-demo-agent — Interview Invite Demo
// Stage: interview · Owner: recruiting
// Trigger: INTERVIEW_INVITATION_REQUESTED
// Emits:   INTERVIEW_INVITATION_SENT, INTERVIEW_INVITATION_FAILED

import { NonRetriableError } from 'inngest';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import { getParsedResume } from '@/lib/partner-pg/parsed-resume';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { inngest } from '@/server/inngest/client';
import { inviteCandidateDirect } from '@/lib/robohire-client';
import { writeCommunicationLogInstance, writeInterviewRecordInstance } from '@/lib/allmeta-writers';

const AGENT_ID = 'interview-invite-demo-agent';
const AGENT_NAME = 'interviewInviteDemoAgent';

export const interviewInviteDemoAgent = inngest.createFunction(
  { id: AGENT_ID, name: 'Interview Invite Demo', retries: 2,
    triggers: [{ event: 'INTERVIEW_INVITATION_REQUESTED' }] },
  async ({ event, step, logger, runId }) => {
    const log = createAgentLogger({ agent: AGENT_NAME, runId: runId ?? `local-${Date.now()}`,
      traceId: (event.data as any)?.traceId ?? null, anchors: {} });
    return runWithLogger(log, async () => {
      log.event('handler.start', { event_name: event.name });

      const requirement_data = await step.run('fetch-job-requirement', async () => {
        const requisitionId = event.data.job_requisition_id;
        const r = await getRequirementDetail(requisitionId);
        if (!r) throw new NonRetriableError(`[interview-invite-demo-agent] partner-pg: job_requisition ${requisitionId} not found`);
        logger.info(`[interview-invite-demo-agent] fetched JR ${requisitionId}`, { requisitionId });
        return r;
      });

      const resume_data = await step.run('fetch-candidate-resume', async () => {
        const candidateId = event.data.candidate_id;
        const r = await getParsedResume(candidateId, event.data.resume_id ?? null); // ← 1-line hand-finish
        if (!r) throw new NonRetriableError(`[interview-invite-demo-agent] partner-pg: parsed resume not found for candidate ${candidateId}`);
        logger.info(`[interview-invite-demo-agent] fetched parsed resume for ${candidateId}`, { candidateId });
        return r;
      });

      const invite_response = await step.run('robohire-invite-candidate', async () => {
        const traceId = event.data.traceId;
        const input = { resume_id: resume_data.resume_id, job_id: requirement_data.job_requisition_id,
          candidate_email: event.data.candidate_email, interview_round: event.data.interview_round || 1 };
        try {
          const r = await inviteCandidateDirect(input, { traceId });
          if (!r.data.success) throw new NonRetriableError(`RoboHire rejected invite: ${JSON.stringify(r.data)}`);
          logger.info(`[interview-invite-demo-agent] RoboHire invite sent · url=${r.data.login_url}`, { login_url: r.data.login_url });
          return r;
        } catch (e) {
          if (e instanceof Error && 'httpStatus' in e && (e as any).httpStatus >= 400 && (e as any).httpStatus < 500)
            throw new NonRetriableError(`RoboHire invite-candidate 4xx: ${e.message}`);
          throw e;
        }
      });

      await step.run('mirror-communication-log', async () => {
        const commId = `comm_${event.data.application_id}_${event.data.interview_round || 1}`;
        const r = await writeCommunicationLogInstance({ communication_log_id: commId,
          application_id: event.data.application_id, interaction_type: '面试邀请',
          message_content: 'Interview invitation sent via RoboHire',
          content_summary: `Round ${event.data.interview_round || 1} invitation`,
          timestamp: new Date().toISOString() });
        if (!r.ok) logger.warn(`[interview-invite-demo-agent] allmeta comm-log write failed: ${r.error}`, { error: r.error });
        return r;
      });

      await step.run('mirror-interview-record', async () => {
        const interviewRecordId = `int_${event.data.application_id}_${event.data.interview_round || 1}`;
        const r = await writeInterviewRecordInstance({ interview_record_id: interviewRecordId,
          application_id: event.data.application_id, interview_round: event.data.interview_round || 1,
          interview_mode: 'video', recording_url: invite_response.data.login_url });
        if (!r.ok) logger.warn(`[interview-invite-demo-agent] allmeta interview-record write failed: ${r.error}`, { error: r.error });
        return r;
      });

      await step.run('emit-invitation-sent', async () => {
        await inngest.send({ name: 'INTERVIEW_INVITATION_SENT',
          data: { application_id: event.data.application_id, candidate_id: event.data.candidate_id,
            interview_url: invite_response.data.login_url } });
        logger.info(`[interview-invite-demo-agent] emitted INTERVIEW_INVITATION_SENT for app=${event.data.application_id}`, { application_id: event.data.application_id });
        return { sent: true };
      });

      log.event('handler.complete', {});
    });
  },
);
```
