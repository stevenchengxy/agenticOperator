// Shared human-in-the-loop decision bridge for the runnable domains (energy +
// 费控). The companion 值班工作台 calls this when an operator clicks a gate
// decision. It (1) records the decision on the notification(s) so the card
// leaves the 人工待办 tab, and (2) sends `<eventNs>/HUMAN_DECISION` — the event
// the paused step.waitForEvent is keyed on (caseId + gate) — resuming the chain.
//
// Domain-agnostic: the event namespace + dedupe prefix derive from the domain id
// (eventNsForDomain), so one route serves every domain. Per-domain gate decision
// allowlists are validated here (unknown gates are unrestricted).

import { inngest } from "@/server/inngest/client";
import { prisma } from "@/server/db";
import { resolveAlerts } from "@/server/notifications/resolve";
import { eventNsForDomain, ENERGY_DOMAIN_ID, COST_CONTROL_DOMAIN_ID } from "@/lib/domain-ids";

/** Per-domain gate → allowed decision verbs. Drives both validation here and the
 *  button set the companion renders. */
export const GATE_DECISIONS: Record<string, Record<string, string[]>> = {
  [ENERGY_DOMAIN_ID]: {
    manualConfirm: ["采纳", "退回", "否决", "暂缓"],
    handleFloodControl: ["放行", "暂缓", "上报"],
    handleGridSecurity: ["放行", "暂缓", "上报"],
    handleEquipmentFault: ["放行", "暂缓", "上报"],
    handleRenewableCurtailment: ["放行", "暂缓", "上报"],
    finalizePlan: ["确认封口", "不通过"],
  },
  [COST_CONTROL_DOMAIN_ID]: {
    manualReview: ["确认核准", "降额", "退回", "驳回"],
    disposeRiskEvent: ["放行", "暂缓", "上报"],
  },
};

export function gateDecisionsFor(domain: string): Record<string, string[]> {
  return GATE_DECISIONS[domain] ?? {};
}

export type HumanDecisionInput = {
  domain: string;
  caseId: string;
  gate: string;
  decision: string;
  notificationId?: string | null;
  edits?: string | null;
  reason?: string | null;
  operator?: string;
};

export type HumanDecisionResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

export async function resolveHumanDecision(input: HumanDecisionInput): Promise<HumanDecisionResult> {
  const domain = input.domain.trim();
  const caseId = input.caseId.trim();
  const gate = input.gate.trim();
  const decision = input.decision.trim();
  const operator = input.operator?.trim() || "值班人员";

  const eventNs = eventNsForDomain(domain);
  if (!eventNs) return { ok: false, status: 400, error: `domain "${domain}" has no runnable agent pack` };
  if (!caseId || !gate || !decision) return { ok: false, status: 400, error: "domain, caseId, gate, decision are required" };

  const allowed = GATE_DECISIONS[domain]?.[gate];
  if (allowed && !allowed.includes(decision)) {
    return { ok: false, status: 400, error: `decision "${decision}" not valid for gate ${gate} (${allowed.join("/")})` };
  }

  // 1. Resolve every card for this (caseId, gate): a replay can leave a duplicate
  //    firing row, and the operator decides a gate once. Soft-fail so a DB hiccup
  //    never blocks the resume.
  //    走 resolveAlerts(先删同 key 旧 resolved 行)— 直接 updateMany 翻 resolved
  //    会在同 key 第二个 incarnation 上撞 @@unique([dedupeKey,status]),P2002
  //    被吞后 needs_human 卡永远清不掉(2026-06-11 审计实锤过 2 对)。
  const action = `${decision} · ${operator}`;
  let notificationUpdated = false;
  try {
    const key = `${eventNs}_human_gate.${gate}.${caseId}`;
    const count = await resolveAlerts([key], { managerAction: action, disposition: "auto_handled" });
    if (input.notificationId && count === 0) {
      // 兜底:卡片行不带该 dedupeKey(旧数据/手工行)时按 id 标记已处理。
      await prisma.notification
        .update({
          where: { id: input.notificationId },
          data: { managerAction: action, disposition: "auto_handled", readAt: new Date() },
        })
        .catch(() => {});
    }
    notificationUpdated = count > 0 || !!input.notificationId;
  } catch {
    /* soft-fail */
  }

  // 2. Wake the suspended agent: the waitForEvent matches on caseId + gate.
  const sent = await inngest.send({
    name: `${eventNs}/HUMAN_DECISION`,
    data: { caseId, gate, decision, edits: input.edits ?? null, reason: input.reason ?? null, operator },
  });

  return { ok: true, body: { ok: true, domain, caseId, gate, decision, operator, notificationUpdated, eventIds: sent.ids } };
}
