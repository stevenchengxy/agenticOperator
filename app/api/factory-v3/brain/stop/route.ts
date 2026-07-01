// Stop a running background brain. POST { runId } → aborts the detached driver,
// which breaks the conductor at its next turn boundary and runs cleanup (sandbox
// teardown etc.). The run finalizes as 'aborted'; everything generated so far is
// kept. This is the explicit counterpart to the (now decoupled) client disconnect,
// which no longer stops the run.
//
// POST /api/factory-v3/brain/stop   body: { runId: string }

import { requireFactoryAuth } from "@/lib/factory-auth";
import { abortRun, forceFinalizeAborted } from "@/lib/agent-factory-v3/brain/run-registry";

export async function POST(req: Request): Promise<Response> {
  const denied = requireFactoryAuth(req, { allowQueryToken: true });
  if (denied) return denied;

  let body: { runId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (!runId) return Response.json({ ok: false, error: "runId is required" }, { status: 400 });

  const aborted = abortRun(runId);
  // If it wasn't live in the registry, it may be ORPHANED (server/HMR restart left the
  // durable row stuck 'running') — flip that row to 'aborted' so the stuck "运行中"
  // actually clears. Either way the client's intent (it's stopped) is satisfied.
  const finalized = aborted ? false : await forceFinalizeAborted(runId);
  return Response.json({ ok: true, aborted, finalized });
}
