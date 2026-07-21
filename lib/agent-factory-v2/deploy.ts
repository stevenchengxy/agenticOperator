// The v2 → real-Inngest bridge.
//
// The conductor used to STOP at an in-process simulation (smoke.ts) — its
// generated specs were returned and then discarded by the build route, so
// nothing v2 produced ever became a running agent. This module closes that gap:
// it takes the conductor's GeneratedAgentSpec[] and actually
//
//   ship():    persistSpecs → flip status='active' → registerDomainApp → resync
//              (the SAME path /api/factory/deploy uses, so the deployed rows run
//               the REAL registry-backed make-factory-executor, not a sim).
//   observe(): fire the chain's entry events into the per-domain Inngest app and
//              poll the Postgres archive until the chain reaches a terminal event.
//
// Side effects are real (Postgres rows + Inngest functions + a live run); tools
// still execute as dry-run mocks for FORCE_DRYRUN domains (recruit-gen-v1 /
// agents-generation) — that's a registry/trust-boundary decision, not a sim.

import { prisma } from "@/server/db";
import { persistSpecs } from "@/lib/agent-factory-gen/persist";
import { registerDomainApp, resyncDomainApp } from "@/server/inngest/domain-app";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import type { Deployer, ShipReport, RunReport, CaseResult } from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Entry events = consumed by some spec but produced by none (external triggers). */
function entryEvents(specs: GeneratedAgentSpec[]): string[] {
  const produced = new Set<string>();
  for (const s of specs) for (const e of s.emit) if (e && e !== "—") produced.add(e);
  const entry = new Set<string>();
  for (const s of specs) for (const e of s.trigger) if (e && e !== "—" && !produced.has(e)) entry.add(e);
  return [...entry];
}

/** Terminal events = emitted by some spec but consumed by none (chain endpoints). */
function terminalEvents(specs: GeneratedAgentSpec[]): string[] {
  const consumed = new Set<string>();
  for (const s of specs) for (const e of s.trigger) if (e && e !== "—") consumed.add(e);
  const terminal = new Set<string>();
  for (const s of specs) for (const e of s.emit) if (e && e !== "—" && !consumed.has(e)) terminal.add(e);
  return [...terminal];
}

/**
 * Persist the specs as deployable AgentVersion rows and bring the per-domain
 * Inngest app online — the exact mechanics of /api/factory/deploy, reused here.
 *
 * liveExecution stays false (dry-run mock tools) — a v2 build never silently
 * runs real external side effects; a force-dry-run domain can't go live anyway.
 */
export async function shipAgents(
  domain: string,
  specs: GeneratedAgentSpec[],
  opts: { deployDomain?: string } = {},
): Promise<ShipReport> {
  if (specs.length === 0) {
    return { versionLabel: "", deployed: [], appRegistered: false, error: "no specs to ship" };
  }
  // The Inngest app / serve route / AgentVersion.domain to deploy under. For a
  // sandbox test this is `sandbox-<domain>` (a DEDICATED app, isolated from the
  // domain's own `agentic-operator-<domain>` app); the specs keep spec.domainId =
  // real domain so the runtime registry + dry-run still resolve correctly.
  const deployDomain = opts.deployDomain ?? domain;

  // 1. persist as draft rows under the deploy domain (idempotent via versionLabel)
  const persisted = await persistSpecs(specs, { deployDomain });
  const versionLabel = persisted.versionLabel;
  const slugs = [...new Set(specs.map((s) => s.slug))];

  // 2. demote ALL previously-active agents in this (deploy) domain.
  await prisma.agentVersion.updateMany({
    where: { domain: deployDomain, capturedFrom: "ontology-gen", status: "active", versionLabel: { not: versionLabel } },
    data: { status: "offline" },
  });

  // 3. flip this version's rows to active.
  const flip = await prisma.agentVersion.updateMany({
    where: { domain: deployDomain, capturedFrom: "ontology-gen", versionLabel },
    data: { status: "active", deployedAt: new Date() },
  });

  // 4. register + resync the per-(deploy-)domain Inngest app so it introspects the new fns
  let appRegistered = false;
  let error: string | undefined;
  let functionsRegistered = 0;
  try {
    const reg = await registerDomainApp(deployDomain);
    appRegistered = reg.ok;
    if (!reg.ok) error = reg.error;
    await resyncDomainApp(deployDomain);
    // Verify the Inngest dev server actually introspected the functions (not just
    // that the app row exists). Poll briefly — a fresh sync round-trips.
    const { getDomainApp } = await import("@/server/inngest/domain-app");
    for (let i = 0; i < 8; i++) {
      try {
        const st = await getDomainApp(deployDomain);
        functionsRegistered = st.sync?.functionCount ?? 0;
        if (functionsRegistered > 0) break;
      } catch { /* keep polling */ }
      await sleep(1_200);
    }
  } catch (e) {
    error = (e as Error).message;
  }

  return {
    versionLabel,
    deployed: flip.count > 0 ? slugs : [],
    appRegistered,
    error,
    appId: `agentic-operator-${deployDomain}`,
    functionsRegistered,
  };
}

/**
 * Send a just-verified version's agents back to DRAFT. The factory verifies a
 * chain by really deploying + running it (shipAgents flips rows to 'active');
 * but the deploy decision belongs to the operator in the Fleet, so after the
 * sandbox proves the chain we revert those rows to 'draft' and resync the domain
 * app (the now-draft fns drop out of the live set). Idempotent + best-effort.
 */
export async function revertToDraft(domain: string, versionLabel: string): Promise<number> {
  if (!versionLabel) return 0;
  const res = await prisma.agentVersion.updateMany({
    where: { domain, capturedFrom: "ontology-gen", versionLabel, status: "active" },
    data: { status: "draft", deployedAt: null },
  });
  await resyncDomainApp(domain).catch(() => {});
  return res.count;
}

/**
 * Tear down a DEDICATED sandbox app after a test session. The sandbox deploys
 * ephemeral copies of the generated agents to `sandbox-<domain>` (its own Inngest
 * app, isolated from the real domain's app); once the brain is done we delete
 * those rows + resync so the sandbox app serves zero functions (it disappears as
 * a live app). The real domain's Fleet drafts are SEPARATE (persisted under the
 * real domain by design_agent) and untouched. Best-effort; never blocks.
 */
export async function teardownSandbox(sandboxDomain: string): Promise<number> {
  if (!sandboxDomain) return 0;
  const res = await prisma.agentVersion.deleteMany({
    where: { domain: sandboxDomain, capturedFrom: "ontology-gen" },
  });
  // Mark the per-domain app offline + resync so its function set empties out.
  await prisma.domainInngestApp.updateMany({ where: { domain: sandboxDomain }, data: { status: "offline" } }).catch(() => {});
  await resyncDomainApp(sandboxDomain).catch(() => {});
  return res.count;
}

/**
 * Fire the chain's entry events into the deployed domain app, then poll the
 * Postgres archive (write-through, no lag) until the chain reaches a terminal
 * event or the timeout elapses. The returned runIds + events ARE the proof a
 * real run happened — they are queryable rows in inngest_run_archive /
 * inngest_event_archive, not an in-process claim.
 */
export async function fireAndObserve(
  domain: string,
  specs: GeneratedAgentSpec[],
  opts: {
    timeoutMs?: number;
    settleMs?: number;
    /** R2-2: per-poll progress callback so a caller (e.g. sandbox_run) can
     *  stream phase updates to the UI instead of a 50s silent wait. */
    onProgress?: (snap: { runsSoFar: number; eventsSoFar: number; reachedTerminal: boolean }) => void;
    /** P2 (audit): checked each poll tick — return true to bail out early (e.g. a
     *  human message arrived mid-sandbox, so settle now and let the conductor drain
     *  it at the next turn boundary instead of after the full 50s observe). */
    shouldCancel?: () => boolean | Promise<boolean>;
    /** Feature 2: user-approved test cases to fire instead of the hardcoded seed.
     *  Each fires its entryEvent with (base seed ⊕ its payload) so the proven run
     *  uses the reviewed inputs. `kind` drives the per-case behavioral assertion
     *  (pass→non-failure terminal, reject→failure terminal, edge→tolerant). */
    cases?: Array<{ entryEvent: string; payload: Record<string, unknown>; kind?: string; name?: string; expectedOutcome?: string }>;
  } = {},
): Promise<RunReport> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const settleMs = opts.settleMs ?? 1_500;
  const since = new Date();

  const entries = entryEvents(specs);
  const nsTerminals = new Set(terminalEvents(specs).map((e) => `${domain}/${e}`));

  // Wait until Inngest has actually introspected the just-registered functions
  // before firing. A brand-new per-domain app needs a sync round-trip; firing
  // before that arrives means the entry events reach no subscriber and trigger
  // nothing (the runs:[] failure mode). Poll the app's functionCount.
  const { getDomainApp } = await import("@/server/inngest/domain-app");
  const appId = `agentic-operator-${domain}`;
  let functionsRegistered = 0;
  for (let i = 0; i < 12; i++) {
    try {
      const st = await getDomainApp(domain);
      functionsRegistered = st.sync?.functionCount ?? 0;
      if (functionsRegistered > 0) break;
    } catch { /* keep waiting */ }
    await sleep(settleMs);
  }
  // Registration assertion: if the Inngest server never introspected any
  // function, firing the entry events reaches no subscriber (the runs:[] trap
  // that looks like a logic bug). Report it as a DEPLOY failure, not a chain
  // that "ran but didn't reach terminal".
  if (functionsRegistered === 0) {
    return { fired: [], runs: [], events: [], reachedTerminal: false, appId, functionsRegistered: 0 };
  }

  // RANK-3: schema-shaped, non-empty seed so the happy-path chain can flow + so a
  // directly-fired branch agent has realistic data (matches the dry-run GOLDEN
  // fixtures). id-only payloads gave agents nothing to reason over → failure branch.
  const { inngest } = await import("@/server/inngest/client");
  const seedData = (tag: string) => ({
    _runId: `factory2-fire-${domain}-${tag}-${since.getTime()}`,
    _demo: true,
    candidate_id: "cand_demo_001", resume_id: "resume_demo_001",
    resume_file_path: "demo/zhangsan.pdf", job_requisition_id: "jr_demo_001",
    name: "张三", phone: "13800000000",
    skills: ["Java", "Spring Boot", "分布式系统"], workYears: 6, education: "本科",
  });

  const fired: string[] = [];
  // ② track each case's unique _runId so we can later trace which terminal it reached
  // and assert it against the case's kind.
  const caseFires: Array<{ c: NonNullable<typeof opts.cases>[number]; runId: string }> = [];
  // Feature 2: fire the user-approved test cases when provided (each = base seed ⊕
  // its reviewed payload), else the default seed per entry event.
  const approvedCases = (opts.cases ?? []).filter((c) => c.entryEvent && entries.includes(c.entryEvent));
  if (approvedCases.length) {
    let n = 0;
    for (const c of approvedCases) {
      const data = { ...seedData(`case-${n++}`), ...c.payload };
      const runId = String((data as { _runId?: unknown })._runId ?? "");
      await inngest.send({ name: `${domain}/${c.entryEvent}`, data });
      fired.push(`${domain}/${c.entryEvent}`);
      caseFires.push({ c, runId });
    }
    // any entry event not covered by a case still gets a default fire so the whole
    // graph is exercised.
    for (const e of entries) if (!approvedCases.some((c) => c.entryEvent === e)) { const evt = `${domain}/${e}`; await inngest.send({ name: evt, data: seedData(e) }); fired.push(evt); }
  } else {
    for (const e of entries) {
      const evt = `${domain}/${e}`;
      await inngest.send({ name: evt, data: seedData(e) });
      fired.push(evt);
    }
  }

  const fnPrefix = `agentic-operator-${domain}-`;
  let runs: RunReport["runs"] = [];
  let eventNames: string[] = [];
  let reachedTerminal = false;
  let degradedFns = new Set<string>(); // agent fns whose decision was a degraded fallback
  const deadline = Date.now() + timeoutMs;

  // One archive poll — updates runs / eventNames / degradedFns / reachedTerminal.
  const pollOnce = async () => {
    const [runRows, eventRows] = await Promise.all([
      prisma.inngestRunArchive.findMany({
        where: { functionSlug: { startsWith: fnPrefix }, startedAt: { gte: since } },
        orderBy: { startedAt: "desc" }, take: 200,
        select: { runId: true, status: true, functionSlug: true, output: true },
      }),
      prisma.inngestEventArchive.findMany({
        where: { name: { startsWith: `${domain}/` }, archivedAt: { gte: since } },
        orderBy: { archivedAt: "desc" }, take: 400, select: { name: true },
      }),
    ]);
    runs = runRows.map((r) => ({ runId: r.runId, status: r.status, fn: r.functionSlug }));
    degradedFns = new Set<string>();
    for (const r of runRows) {
      if (!r.output) continue;
      try { if ((JSON.parse(r.output) as { degraded?: boolean }).degraded) degradedFns.add(r.functionSlug); } catch { /* not our shape */ }
    }
    eventNames = [...new Set(eventRows.map((r) => r.name))];
    reachedTerminal = eventNames.some((n) => nsTerminals.has(n));
  };

  // Quiescence settle: poll until run+event counts stop growing AND nothing is
  // still Running AND a terminal was reached — so every entry-rooted chain and
  // parallel branch finishes before we judge.
  const settle = async (requireTerminal: boolean) => {
    let lastSig = "";
    let stablePolls = 0;
    while (Date.now() < deadline) {
      await sleep(1_500);
      // P2: bail out of the long observe early if the caller says so (e.g. a human
      // injected a steering message mid-sandbox) — settle now with what we have so
      // the conductor can react at the next turn boundary instead of after ~50s.
      if (opts.shouldCancel && (await opts.shouldCancel())) break;
      await pollOnce();
      opts.onProgress?.({ runsSoFar: runs.length, eventsSoFar: eventNames.length, reachedTerminal });
      const sig = `${runs.length}:${eventNames.length}`;
      if (sig === lastSig) stablePolls += 1; else { lastSig = sig; stablePolls = 0; }
      const noneRunning = runs.length > 0 && runs.every((r) => /complete|fail|cancel/i.test(r.status));
      if ((!requireTerminal || reachedTerminal) && noneRunning && stablePolls >= 3) break;
    }
  };

  await settle(true); // happy-path chain from the entry events

  // COVERAGE PASS: the happy path only exercises one branch — branch agents (e.g.
  // the MATCH_FAILED handler) never run, so "some agents weren't tested". Fire the
  // trigger of every agent that hasn't run yet (with seed data), up to 3 rounds,
  // so EVERY deployed agent executes at least once and the behavioral gate is
  // satisfiable. (Without this the gate would correctly-but-permanently block.)
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  for (let round = 0; round < 3 && Date.now() < deadline; round++) {
    const ranSlugs = [...new Set(runs.map((r) => r.fn.replace(fnPrefix, "")))];
    const unrun = specs.filter((s) => { const k = slugify(s.actionName); return !ranSlugs.some((rs) => rs.includes(k)); });
    if (!unrun.length) break;
    let firedAny = false;
    for (const s of unrun) {
      const trig = (s.trigger ?? []).find((t) => t && t !== "—");
      if (!trig) continue;
      await inngest.send({ name: `${domain}/${trig}`, data: seedData(`cover-${slugify(s.actionName)}`) });
      fired.push(`${domain}/${trig}`);
      firedAny = true;
    }
    if (!firedAny) break;
    await settle(false); // settle the coverage fires (terminal not required here)
  }

  const agentsRan = new Set(runs.map((r) => r.fn)).size;
  const degradedAgents = [...degradedFns].map((fn) => fn.replace(fnPrefix, ""));
  // ② assert each fired case reached the terminal its KIND expects.
  const caseResults = caseFires.length ? await assertCases(domain, caseFires, since, specs) : undefined;
  return { fired, runs, events: eventNames, reachedTerminal, appId, functionsRegistered, agentsRan, degradedAgents, caseResults };
}

/** ② Per-case behavioral assertion. Each fired case has a unique `_runId` that the
 *  whole chain it triggered carries (the agent derives runId from data._runId and
 *  re-emits with it). So we group archived events by _runId, find the terminal each
 *  case reached, and check it against the case's kind — pass→non-failure terminal,
 *  reject→failure terminal, edge→tolerant. This is what turns the sandbox from "the
 *  chain runs" into "the chain DECIDES CORRECTLY". */
const CASE_FAILISH = /FAIL|REJECT|ERROR|CONFLICT|MISSING|DENIED/i;
async function assertCases(
  domain: string,
  caseFires: Array<{ c: { entryEvent: string; kind?: string; name?: string; expectedOutcome?: string }; runId: string }>,
  since: Date,
  specs: GeneratedAgentSpec[],
): Promise<CaseResult[]> {
  const termSet = new Set(terminalEvents(specs)); // bare terminal event names
  let rows: Array<{ name: string; data: string }> = [];
  try {
    rows = await prisma.inngestEventArchive.findMany({
      where: { name: { startsWith: `${domain}/` }, archivedAt: { gte: since } },
      orderBy: { archivedAt: "asc" }, take: 1000,
      select: { name: true, data: true },
    });
  } catch { /* archive unreachable → cases read as unverified */ }
  const reachedByRun = new Map<string, string[]>();
  for (const r of rows) {
    let rid: string | undefined;
    try { rid = (JSON.parse(r.data) as { _runId?: string })._runId; } catch { /* not our shape */ }
    if (!rid) continue;
    const bare = r.name.replace(`${domain}/`, "");
    const arr = reachedByRun.get(rid) ?? [];
    arr.push(bare);
    reachedByRun.set(rid, arr);
  }
  return caseFires.map(({ c, runId }) => {
    const reached = reachedByRun.get(runId) ?? [];
    const terminalsReached = reached.filter((e) => termSet.has(e));
    const reachedTerminal = terminalsReached.length ? terminalsReached[terminalsReached.length - 1] : null;
    const isFailureTerminal = reachedTerminal ? CASE_FAILISH.test(reachedTerminal) : false;
    const kind = c.kind ?? "pass";
    let ok: boolean;
    let detail: string;
    if (!reachedTerminal) {
      ok = kind === "edge";
      detail = ok ? "未到明确终态（边界用例容忍降级/兜底）" : "没走到任何终态——事件链可能断在中途";
    } else if (kind === "reject") {
      ok = isFailureTerminal;
      detail = ok ? `正确走到失败终态 ${reachedTerminal}` : `预期被拒，却走到非失败终态 ${reachedTerminal}`;
    } else if (kind === "edge") {
      ok = true;
      detail = `到达 ${reachedTerminal}（边界用例）`;
    } else {
      ok = !isFailureTerminal;
      detail = ok ? `正确走到成功终态 ${reachedTerminal}` : `预期通过，却走到失败终态 ${reachedTerminal}`;
    }
    return { name: c.name ?? c.entryEvent, kind, expectedOutcome: c.expectedOutcome ?? "", reachedTerminal, isFailureTerminal, ok, detail };
  });
}

/** The real deployer injected by the build route. */
export const realDeployer: Deployer = {
  ship: shipAgents,
  observe: fireAndObserve,
};
