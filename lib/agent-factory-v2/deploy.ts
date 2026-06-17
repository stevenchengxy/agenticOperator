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
import { isForceDryRunDomain } from "@/lib/tools/resolve-registry";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import type { Deployer, ShipReport, RunReport } from "./types";

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
export async function shipAgents(domain: string, specs: GeneratedAgentSpec[]): Promise<ShipReport> {
  if (specs.length === 0) {
    return { versionLabel: "", deployed: [], appRegistered: false, error: "no specs to ship" };
  }

  // 1. persist as draft rows (idempotent: versionLabel = content hash)
  const persisted = await persistSpecs(specs);
  const versionLabel = persisted.versionLabel;
  const slugs = [...new Set(specs.map((s) => s.slug))];

  // 2. demote ALL previously-active agents in this domain (not just same-named
  //    slugs). The de-anchored Planner can produce a DIFFERENT decomposition each
  //    build, so replace the whole set — otherwise agents from an old plan linger
  //    active and pollute the chain.
  await prisma.agentVersion.updateMany({
    where: { domain, capturedFrom: "ontology-gen", status: "active", versionLabel: { not: versionLabel } },
    data: { status: "offline" },
  });

  // 3. flip this version's rows to active. liveExecution = false (dry-run mocks);
  //    force-dry-run domains can never go live regardless.
  const effLive = false && !isForceDryRunDomain(domain);
  const flip = await prisma.agentVersion.updateMany({
    where: { domain, capturedFrom: "ontology-gen", versionLabel },
    data: { status: "active", deployedAt: new Date(), liveExecution: effLive },
  });

  // 4. register + resync the per-domain Inngest app so it introspects the new fns
  let appRegistered = false;
  let error: string | undefined;
  try {
    const reg = await registerDomainApp(domain);
    appRegistered = reg.ok;
    if (!reg.ok) error = reg.error;
    await resyncDomainApp(domain);
  } catch (e) {
    error = (e as Error).message;
  }

  return {
    versionLabel,
    deployed: flip.count > 0 ? slugs : [],
    appRegistered,
    error,
  };
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
  opts: { timeoutMs?: number; settleMs?: number } = {},
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
  for (let i = 0; i < 12; i++) {
    try {
      const st = await getDomainApp(domain);
      if ((st.sync?.functionCount ?? 0) > 0) break;
    } catch { /* keep waiting */ }
    await sleep(settleMs);
  }

  // Fire each entry event, namespaced — the convention make-factory-executor
  // registers its triggers under (`${domain}/${event}`).
  const { inngest } = await import("@/server/inngest/client");
  const fired: string[] = [];
  for (const e of entries) {
    const evt = `${domain}/${e}`;
    await inngest.send({
      name: evt,
      data: {
        _runId: `factory2-fire-${domain}-${e}-${since.getTime()}`,
        _demo: true,
        candidate_id: "demo-cand",
        resume_id: "demo-resume",
        job_requisition_id: "demo-jr",
      },
    });
    fired.push(evt);
  }

  // Poll the archive until a terminal event lands (or timeout).
  const fnPrefix = `agentic-operator-${domain}-`;
  let runs: RunReport["runs"] = [];
  let eventNames: string[] = [];
  let reachedTerminal = false;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(1_500);

    const [runRows, eventRows] = await Promise.all([
      prisma.inngestRunArchive.findMany({
        where: { functionSlug: { startsWith: fnPrefix }, startedAt: { gte: since } },
        orderBy: { startedAt: "desc" },
        take: 100,
        select: { runId: true, status: true, functionSlug: true },
      }),
      prisma.inngestEventArchive.findMany({
        where: { name: { startsWith: `${domain}/` }, archivedAt: { gte: since } },
        orderBy: { archivedAt: "desc" },
        take: 200,
        select: { name: true },
      }),
    ]);

    runs = runRows.map((r) => ({ runId: r.runId, status: r.status, fn: r.functionSlug }));
    eventNames = [...new Set(eventRows.map((r) => r.name))];
    reachedTerminal = eventNames.some((n) => nsTerminals.has(n));

    // Stop early once a terminal event has been observed AND at least one run
    // has reconciled to a terminal status (Completed/Failed/Cancelled).
    const anyRunSettled = runs.some((r) => /complete|fail|cancel/i.test(r.status));
    if (reachedTerminal && anyRunSettled) break;
  }

  return { fired, runs, events: eventNames, reachedTerminal };
}

/** The real deployer injected by the build route. */
export const realDeployer: Deployer = {
  ship: shipAgents,
  observe: fireAndObserve,
};
