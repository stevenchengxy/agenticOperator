// RANK-5 (human-in-the-loop) inbound channel. The SSE stream is one-way; this is
// the return path: the user POSTs a message for a running brain, it lands in the
// in-process mailbox, and the conductor drains it at the next turn boundary and
// feeds it to the brain as an authoritative user turn (which the brain can then
// freely analyze / re-plan / verify with tools — it is steering, not a command).
//
// POST /api/factory-v3/brain/inject   body: { runId: string, text: string }

import { pushHumanMsg } from "@/lib/agent-factory-v3/brain/mailbox";

export async function POST(req: Request): Promise<Response> {
  let body: { runId?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!runId || !text) {
    return Response.json({ ok: false, error: "runId and text are required" }, { status: 400 });
  }
  const ok = await pushHumanMsg(runId, text.slice(0, 4000));
  return Response.json({ ok, queued: ok });
}
