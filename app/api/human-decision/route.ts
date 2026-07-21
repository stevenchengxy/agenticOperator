// POST /api/human-decision
//
// The unified human-in-the-loop decision endpoint for every runnable domain
// (energy 能源调度 + 费控). The companion 值班工作台 posts here when an operator
// clicks a gate decision; the body carries `domain` so one route serves all
// domains. Sends `<eventNs>/HUMAN_DECISION` (resolved from the domain) and marks
// the matching notification resolved. See server/inngest/human-decision.ts.

import { NextResponse } from "next/server";
import { resolveHumanDecision } from "@/server/inngest/human-decision";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const r = await resolveHumanDecision({
    domain: String(body.domain ?? ""),
    caseId: String(body.caseId ?? ""),
    gate: String(body.gate ?? ""),
    decision: String(body.decision ?? ""),
    notificationId: typeof body.notificationId === "string" ? body.notificationId : null,
    edits: typeof body.edits === "string" ? body.edits : null,
    reason: typeof body.reason === "string" ? body.reason : null,
    operator: typeof body.operator === "string" ? body.operator : undefined,
  });

  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json(r.body);
}
