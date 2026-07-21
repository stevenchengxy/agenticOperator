// P3 — independent review. The DETERMINISTIC half lives here (pure code, free +
// reliable): branch coverage, tool grounding, degraded flag. The review_agent
// tool layers an INDEPENDENT LLM judge on top, scoped strictly to the one
// semantic check the code can't do — "are the mandatory rules actually encoded
// in the prompt" — framed as cite-the-span (see tools/index.ts).
//
// Why deterministic-first: the self-correction literature shows LLM self-grading
// is unreliable, so anything checkable by code (set membership / string presence)
// must NOT be delegated to a judge. The judge handles only genuine semantics.

import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

export type ReviewFinding = {
  slug: string;
  actionName: string;
  kind: "branch-uncovered" | "ungrounded-tool" | "degraded" | "rules-not-encoded";
  detail: string;
};

/** Pure, deterministic review of a generated spec set. */
export function reviewSpecsDeterministic(specs: GeneratedAgentSpec[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const s of specs) {
    // Branch coverage: a multi-emit agent's prompt should mention each branch
    // event so its decision logic is actually expressed.
    if (s.emit.length > 1) {
      const missing = s.emit.filter((ev) => ev && ev !== "—" && !s.systemPrompt.includes(ev));
      if (missing.length) {
        findings.push({
          slug: s.slug,
          actionName: s.actionName,
          kind: "branch-uncovered",
          detail: `多分支 agent 的 prompt 未提及分支事件：${missing.join("、")}（决策逻辑不全，补进 prompt）`,
        });
      }
    }
    // Tool grounding: any tool the agent references that didn't resolve to a real
    // registry tool (a hallucinated / not-yet-built capability).
    if ((s.unresolvedTools?.length ?? 0) > 0) {
      findings.push({
        slug: s.slug,
        actionName: s.actionName,
        kind: "ungrounded-tool",
        detail: `引用了工具库没有的工具：${s.unresolvedTools.join("、")}（换成真实工具，或确认需补到工具库）`,
      });
    }
    // Degraded shell: an auto-generated fallback that still needs human/LLM work.
    if (s.degraded) {
      findings.push({
        slug: s.slug,
        actionName: s.actionName,
        kind: "degraded",
        detail: "这是自动降级占位 agent，prompt/工具都是兜底——需要重新 design_agent 或人工完善",
      });
    }
  }
  return findings;
}
