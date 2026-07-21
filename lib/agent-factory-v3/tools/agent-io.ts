// Feature 2 — per-agent I/O capture. After a sandbox settles, read the Postgres
// archive and reconstruct, for each agent that ran, the REAL input it consumed,
// what it did, and what it emitted — the evidence the verification panel shows to
// prove the sandbox genuinely ran (real runId + real payloads, not a paper claim).
//
// Sources (all already written by the deployed agent + the archiver):
//   · inngest_run_archive  — eventName (trigger), eventPayload (input), output
//                            ({ runId, emitted, reasoning, degraded }), status.
//   · agent_activity       — the agent_decision row (narrative reasoning + tools).
//   · inngest_event_archive— the emitted event's data → the output payload.

import { prisma } from "@/server/db";
import { sandboxDomainFor } from "@/lib/tools/resolve-registry";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import type { AgentRunIO } from "../brain/types";

export async function collectAgentRuns(
  domain: string,
  runIds: string[],
  specs: GeneratedAgentSpec[],
): Promise<AgentRunIO[]> {
  if (!runIds.length) return [];
  const fnPrefix = `agentic-operator-${sandboxDomainFor(domain)}-`;
  const [runs, activities, events] = await Promise.all([
    prisma.inngestRunArchive.findMany({
      where: { runId: { in: runIds } },
      select: { runId: true, status: true, functionSlug: true, eventName: true, eventPayload: true, output: true },
    }),
    prisma.agentActivity.findMany({
      where: { runId: { in: runIds }, type: "agent_decision" },
      select: { runId: true, narrative: true, metadata: true },
    }),
    prisma.inngestEventArchive.findMany({
      where: { name: { startsWith: `${domain}/` } },
      orderBy: { archivedAt: "desc" }, take: 600,
      select: { name: true, data: true },
    }),
  ]);

  // Index emitted-event payloads by `${name}|${_runId}` so we can attach the
  // OUTPUT payload an agent produced (matched on the agent's internal runId).
  const evIndex = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    try {
      const d = JSON.parse(e.data) as Record<string, unknown>;
      if (d && typeof d === "object" && typeof d._runId === "string") evIndex.set(`${e.name}|${d._runId}`, d);
    } catch { /* not our shape */ }
  }

  const dash = (process.env.INNGEST_BASE_URL ?? "http://localhost:8288").replace(/\/+$/, "");
  const out: AgentRunIO[] = [];
  for (const r of runs) {
    const agentSlug = r.functionSlug.replace(fnPrefix, "");
    const spec = specs.find((s) => s.short === agentSlug || s.slug === r.functionSlug);

    let tools: string[] = [];
    let degraded = false;
    let reasoning = "";
    const act = activities.find((a) => a.runId === r.runId);
    if (act) {
      reasoning = act.narrative ?? "";
      if (act.metadata) {
        try { const m = JSON.parse(act.metadata) as { tools?: string[]; degraded?: boolean }; tools = Array.isArray(m.tools) ? m.tools : []; degraded = !!m.degraded; }
        catch { /* keep defaults */ }
      }
    }

    let outputEvent: string | null = null;
    let internalRunId: string | null = null;
    if (r.output) {
      try {
        const o = JSON.parse(r.output) as { emitted?: string; reasoning?: string; degraded?: boolean; runId?: string };
        outputEvent = o.emitted ?? null;
        internalRunId = o.runId ?? null;
        if (!reasoning && o.reasoning) reasoning = o.reasoning;
        if (o.degraded) degraded = true;
      } catch { /* keep null */ }
    }

    let inputPayload: Record<string, unknown> | null = null;
    if (r.eventPayload) { try { inputPayload = JSON.parse(r.eventPayload) as Record<string, unknown>; } catch { /* keep null */ } }

    let outputPayload: Record<string, unknown> | null = null;
    if (outputEvent && internalRunId) {
      const evData = evIndex.get(`${domain}/${outputEvent}|${internalRunId}`);
      if (evData) {
        const rest = { ...evData };
        delete rest._runId; delete rest.source; delete rest.reasoning;
        outputPayload = rest;
      }
    }

    out.push({
      agentSlug,
      agentShort: spec?.short ?? agentSlug,
      status: r.status,
      degraded,
      triggerEvent: r.eventName ? r.eventName.replace(`${domain}/`, "") : null,
      inputPayload,
      tools,
      outputEvent,
      reasoning,
      outputPayload,
      runId: r.runId,
      url: `${dash}/run?runID=${encodeURIComponent(r.runId)}`,
    });
  }

  // De-dupe by agent (the coverage pass can run an agent more than once): keep the
  // run that actually produced a decision (has an outputEvent) so the panel shows
  // the meaningful execution, not a bare re-fire.
  const byAgent = new Map<string, AgentRunIO>();
  for (const a of out) {
    const prev = byAgent.get(a.agentSlug);
    if (!prev || (!prev.outputEvent && a.outputEvent) || (prev.status !== "Completed" && a.status === "Completed")) byAgent.set(a.agentSlug, a);
  }
  return [...byAgent.values()];
}
