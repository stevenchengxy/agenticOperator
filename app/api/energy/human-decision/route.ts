// POST /api/energy/human-decision  (back-compat alias)
//
// The unified endpoint is now /api/human-decision (domain in the body). This
// route is kept so any existing energy caller keeps working; it delegates to the
// shared bridge with domain = 能源调度-v1 and the energy operator default.
// See server/inngest/human-decision.ts.

import { NextResponse } from "next/server";
import { resolveHumanDecision } from "@/server/inngest/human-decision";
import { ENERGY_DOMAIN_ID } from "@/lib/domain-ids";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const r = await resolveHumanDecision({
    domain: ENERGY_DOMAIN_ID,
    caseId: String(body.caseId ?? ""),
    gate: String(body.gate ?? ""),
    decision: String(body.decision ?? ""),
    notificationId: typeof body.notificationId === "string" ? body.notificationId : null,
    edits: typeof body.edits === "string" ? body.edits : null,
    reason: typeof body.reason === "string" ? body.reason : null,
    operator: typeof body.operator === "string" ? body.operator : "值班调度员",
  });

  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json(r.body);
}
