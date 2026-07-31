# Codegen Phase 4 / 5 — Decision: Defer

> 2026-05-25 · Decision doc
> Companion to [research](./2026-05-25-ao-behavior-codegen-research.md) and [use cases](./2026-05-25-codegen-use-cases.md).
> Status: **Phase 4 deferred**, **Phase 5 deferred**, both gated on Phase 1 v2 + Phase 2 MVP usage data.

---

## TL;DR

| Phase | Research-doc estimate | Decision now | Gate to revisit |
|---|---|---|---|
| **4 — Agentic loop** (LLM self-iterates with read/write/compile/test tools) | 4-8 weeks | **defer** | After 10+ successful Phase 1 v2 codegen sessions reveal which shapes the template-fill path cannot express |
| **5 — Hot-reload** (Inngest function runtime registration without process restart) | 2-4 weeks + research | **defer** | After we have a real save-as-version → run-in-prod loop and the cost of "re-deploy to ship" becomes the bottleneck |

Both can land later; neither should land now.

---

## Phase 4 — why not yet

The research doc compared Phase 1 (template-fill) and Phase 4 (agentic loop) side-by-side:

| | Phase 1 v2 (today) | Phase 4 (agentic loop) |
|---|---|---|
| LLM scope | Fill `steps[]` + per-step body | Read/write any file, run any command |
| Cost / call | ~$0.40 | ~$2-5 |
| Wall time | 60-90s | 3-8 min |
| Failure mode | LLM may write a bad import → TS2307 → operator fixes 1 line | LLM can wander down a totally wrong exploration path; debugging is expensive |
| Production-readiness needed | Sandbox not strictly required (compiler is in-process, can't escape TS world) | Hard requirement — LLM must not be able to write into the main repo or shell out destructively |

**What we'd be paying for**: the ability to generate agents whose shape doesn't match the 5 production agents — e.g., needing a brand-new `lib/*` helper, complex recovery state machine, multi-event fan-out.

**What we have data on**: zero usage of Phase 1 v2 yet. We literally do not know which agent shapes Phase 1 v2 cannot express. Building Phase 4 now is solving an unmeasured problem.

**The right gate**: ship Phase 1 v2 to internal users. Catch the cases where they hit the template's expressiveness ceiling. *Those specific cases* are the requirements doc for Phase 4. Without that, the agent's tool set, the system prompt, the loop control are all guesswork.

**Concrete recommendation**:
1. Use Phase 1 v2 to regenerate 3-5 production agents and accept the diffs into prod (manual file write + restart).
2. Build out 2-3 NEW agents end-to-end via Phase 1 v2.
3. Track every "needed to drop to hand-written code" event — that's a Phase 4 candidate row.
4. After 30 days of usage data, reassess. If <5 rows → don't build Phase 4. If 5-15 → consider a narrow scope ("agentic loop only for steps marked complex"). If >15 → green-light full Phase 4.

---

## Phase 5 — why not yet

**The problem Phase 5 solves**: when codegen saves a new agent, the `codeBlob` is in `AgentVersion` but Inngest doesn't know about it. To make it live you must:
1. Write `codeBlob` to `server/inngest/agents/<slug>.ts`
2. Add the import + registration to `server/inngest/functions.ts`
3. Restart the Next.js process
4. Inngest dev server picks up the new function on the sync

This is 3 manual steps + a process restart per save.

**Why Phase 5 is hard**:
- Inngest's TypeScript SDK does not expose `inngest.registerFunction(fn)` as a runtime API. Functions are registered by being present in the `serve({ functions: [...] })` call during process boot. There is no documented hot-add.
- Workarounds:
  - **Fork Inngest SDK** — high maintenance cost forever
  - **Monkey-patch the serve handler** — fragile across SDK upgrades, breaks on minor version bumps
  - **Use Node.js `--experimental-vm-modules` to dynamic-import the new agent** — works for the module itself but doesn't help Inngest discover the function unless we also re-trigger the serve handler register, and `serve({...})` is built around a static array
  - **In-process `fetch('/api/inngest', { method: 'PUT' })` to re-sync** — possible but only re-runs the discovery; if the new file isn't in the static array, the discovery doesn't see it

**The pragmatic alternative**: ship a CI redeploy webhook. When operator clicks "Deploy this version to prod", AO:
1. Writes the codeBlob into a branch (`codegen/<slug>-<versionLabel>`), pushes to GitHub
2. CI auto-creates a PR
3. Operator reviews + merges
4. Vercel / Render / your platform redeploys
5. New function is live in 2-5 minutes

This loop has lower total time-to-prod than fighting Inngest's runtime model, AND it inherits the PR review gate (which we want for safety anyway — a bad codegen output should NOT auto-deploy).

**Concrete recommendation**:
1. Don't build Phase 5 as researched.
2. When operator clicks "Save as version" AND the version is marked `ready` (not `draft`), open a "Open PR for this version" button.
3. The button writes the file + opens a GitHub PR via the existing gh CLI / API. Branch convention: `codegen/<slug>-<versionLabel>`.
4. Operator (or auto-approver bot) merges → CI deploys.

This is ~1 week of work and gets the value of Phase 5 with none of the Inngest-internals risk.

---

## Status update — what *is* shipped (recap for reviewers)

| Phase | Status | Commit |
|---|---|---|
| 0a Domain container | ✅ | `f38ec50` |
| 0b AgentVersion table | ✅ (bundled with codegen save-as-version) | `fe27145` |
| 0c In-process TS compiler + API | ✅ | `4208e19` |
| 1a Codegen page UI skeleton | ✅ | `f1e94e1` |
| 1b End-to-end LLM pipeline (free-form prompt) | ✅ (superseded by 1c v2) | `c66a5eb` |
| 1c Ground-truth registries + UI polish + diff + save | ✅ (superseded by v2 reframe) | `fe27145` |
| 1d (v2 reframe) Form-first + steps-only LLM | ✅ | `ad0168b` |
| 2 Library codegen MVP (curl mode, http-client kind) | ✅ MVP | `d0fc3ce` |
| 3 Cross-model compare + eval harness | ❌ not started | — |
| 4 Agentic loop | ❌ **deferred** (this doc) | — |
| 5 Hot-reload | ❌ **deferred** (this doc, recommends CI-redeploy instead) | — |

---

## Recommended next bundle (when ready)

Not for this turn — but the obvious next step after Phase 4 / 5 are deferred:

**Bundle D — "ship the version to prod" loop** (~1 week)
- "Open PR for this version" button on AgentVersion rows where `capturedFrom='codegen'` and `status='draft'`
- Server-side: `gh api repos/.../pulls` to open a PR with the codeBlob written to `server/inngest/agents/<slug>.ts` on a branch named `codegen/<slug>-<versionLabel>`
- Operator reviews + merges normally
- CI auto-deploys; the version row gets its `deployedAt` set when the new commit is on main

That replaces Phase 5 entirely with existing engineering primitives and is the *honest* path to "AI Native code that ships."

**Bundle E — Eval harness** (Phase 3 in research doc, ~2-3 weeks)
- Same spec, multiple model runs side-by-side
- Replay real events against the generated agent in a sandbox
- Compare emit shapes against the active version's emits
- Rank "AI-quality" of competing model outputs on the same spec

Bundle E unlocks the data we need to even know if Phase 4 is worth building.

---

## What this doc *isn't*

- Not a "Phase 4/5 are bad ideas" doc. They're potentially valuable, just not next.
- Not a permanent ban. Each gate above is measurable; revisit when the data is in.
- Not a blocker on shipping codegen — Phase 1 v2 + Phase 2 MVP are fully production-shape; the deferred phases are quality-of-life multipliers.
