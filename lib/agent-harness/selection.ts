// Selection Harness (blueprint P2 — the agent router).
//
// Given a sub-goal expressed as a node need (consume these events, produce those),
// it scores every agent in the registry and decides: REUSE an existing one, or tell
// the orchestrator to GENERATE a new one. Matching is DETERMINISTIC first — the
// event signature is the cross-harness contract, so "does it consume the required
// trigger?" is the load-bearing test — with capability/domain/proven as tie-breaks.
// (An LLM semantic re-rank is the optional next layer on top of this.)

import type { RegistryAgent, SelectionRequest, ScoredAgent, SelectionResult } from "./types";
import { listRegistryAgents, domainMatches } from "./registry";

function overlap(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

/** crude token overlap for capability text (0..1) — deterministic semantic proxy. */
function tokenOverlap(text: string, query: string): number {
  const t = new Set((text.toLowerCase().match(/[a-z0-9一-龥]+/g) ?? []));
  const q = query.toLowerCase().match(/[a-z0-9一-龥]+/g) ?? [];
  if (!q.length) return 0;
  return q.filter((w) => t.has(w)).length / q.length;
}

/** Score one registry agent against a sub-goal need. */
export function scoreAgent(agent: RegistryAgent, req: SelectionRequest): ScoredAgent {
  const trigHit = overlap(agent.triggerEvents, req.triggerEvents);
  const wantEmit = req.emitEvents ?? [];
  const emitHit = wantEmit.length ? overlap(agent.emitEvents, wantEmit) : [];
  const trigOk = trigHit.length > 0;

  let signatureMatch: ScoredAgent["signatureMatch"] = "none";
  if (trigOk && wantEmit.length > 0 && emitHit.length >= wantEmit.length) signatureMatch = "exact";
  else if (trigOk && (wantEmit.length === 0 || emitHit.length > 0)) signatureMatch = "trigger";
  else if (trigOk || emitHit.length > 0) signatureMatch = "partial";

  let score = 0;
  // No signature relevance at all → the node is irrelevant; score 0 regardless of
  // domain/proven (a proven agent that consumes the wrong event still can't slot in).
  if (signatureMatch !== "none") {
    if (trigOk) score += 0.55 * (trigHit.length / Math.max(1, req.triggerEvents.length)); // primary
    if (wantEmit.length) score += 0.25 * (emitHit.length / wantEmit.length);
    if (req.domain && domainMatches(agent.domain, req.domain)) score += 0.10;
    if (req.capability) score += 0.10 * tokenOverlap(agent.capability, req.capability);
    if (agent.sandboxProven) score += 0.05;
  }
  score = Math.min(1, Number(score.toFixed(4)));

  const why = trigOk
    ? `消费 ${trigHit.join("/")}${emitHit.length ? ` · 产出 ${emitHit.join("/")}` : ""}${agent.sandboxProven ? " · 已验证" : " · 未验证"}`
    : "事件签名不匹配";
  return { agent, score, signatureMatch, why };
}

/** Pure decision core — score a fixed agent list against a need. Testable without
 *  a DB. selectAgent() is the async wrapper that feeds it the live registry. */
export function selectFromAgents(agents: RegistryAgent[], req: SelectionRequest): SelectionResult {
  const scored = agents
    .map((a) => scoreAgent(a, req))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  // Reuse ONLY when a candidate can genuinely slot into the chain: it consumes the
  // required trigger (signatureMatch trigger|exact) with a confident score.
  // Otherwise the honest answer is "generate" — don't force a wrong reuse.
  const canReuse = !!best && (best.signatureMatch === "exact" || best.signatureMatch === "trigger") && best.score >= 0.5;
  return {
    decision: canReuse ? "reuse" : "generate",
    best: canReuse ? best.agent : null,
    candidates: scored.slice(0, 5),
    reason: canReuse
      ? `复用「${best.agent.name}」(${best.agent.source === "handwritten" ? "预写" : "已生成"} · ${best.signatureMatch} · ${(best.score * 100) | 0}分)：${best.why}`
      : best
        ? `没有足够匹配的现成 agent(最佳「${best.agent.name}」仅 ${best.signatureMatch} · ${(best.score * 100) | 0}分)——建议生成新的。`
        : `注册表里没有消费 ${req.triggerEvents.join("/")} 的 agent——建议生成新的。`,
  };
}

/** Decide reuse-vs-generate against the LIVE registry (preset ∪ generated). */
export async function selectAgent(req: SelectionRequest): Promise<SelectionResult> {
  return selectFromAgents(await listRegistryAgents(req.domain), req);
}

/** Exposed for deterministic tests. */
export const __testing = { scoreAgent, tokenOverlap };
