// RANK-4: verify_chain computes the event-chain break point deterministically
// (an upstream emit ∩ downstream trigger = ∅) instead of leaving it to a possibly
// -hallucinating LLM. It names exactly which agent is unreachable and why.

import { describe, it, expect } from "vitest";
import { P1_TOOLS } from "./index";
import type { BrainCtx } from "../brain/types";

const verify_chain = P1_TOOLS.find((t) => t.name === "verify_chain")!;

function specOf(o: { short: string; actionName: string; trigger: string[]; emit: string[] }) {
  return {
    ...o, key: o.actionName, slug: `s-${o.actionName}`, domainId: "d", nameZh: o.short, kind: "llm",
    tools: [], unresolvedTools: [], objects: [], systemPrompt: "x", userPrompt: "x", steps: [],
    ruleRefs: [], retries: 1, hitl: false, confidence: 0.9, promptSource: "llm",
  };
}
function ontAction(name: string, trigger: string[], emit: string[]) {
  return { name, actor: ["Agent"], trigger, triggered_event: emit };
}
function ctxOf(specs: ReturnType<typeof specOf>[], ontologyActions: ReturnType<typeof ontAction>[]): BrainCtx {
  return { specs, lastSandbox: null, ontology: { actions: ontologyActions } } as unknown as BrainCtx;
}

describe("verify_chain", () => {
  it("OK when every agent's trigger is produced upstream or is a real ontology entry", async () => {
    const ont = [ontAction("a", ["ENTRY"], ["E1"]), ontAction("b", ["E1"], ["E2"]), ontAction("c", ["E2"], ["DONE"])];
    const r = await verify_chain.execute({}, ctxOf([
      specOf({ short: "A", actionName: "a", trigger: ["ENTRY"], emit: ["E1"] }),
      specOf({ short: "B", actionName: "b", trigger: ["E1"], emit: ["E2"] }),
      specOf({ short: "C", actionName: "c", trigger: ["E2"], emit: ["DONE"] }),
    ], ont));
    expect(r.ok).toBe(true);
    expect((r.output as { breaks: unknown[] }).breaks).toEqual([]);
  });

  it("names the broken agent + the orphan trigger (a typo that isn't a real entry)", async () => {
    const ont = [ontAction("a", ["ENTRY"], ["E1"]), ontAction("b", ["E1"], ["E2"])];
    const r = await verify_chain.execute({}, ctxOf([
      specOf({ short: "A", actionName: "a", trigger: ["ENTRY"], emit: ["E1"] }),
      // B listens on a typo'd event nobody emits + it's NOT a real ontology entry
      specOf({ short: "B", actionName: "b", trigger: ["E1_TYPO"], emit: ["E2"] }),
    ], ont));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("B");
    const breaks = (r.output as { breaks: Array<{ agent: string; orphanTriggers: string[] }> }).breaks;
    expect(breaks[0].agent).toBe("B");
    expect(breaks[0].orphanTriggers).toContain("E1_TYPO");
  });

  it("the recruitment-style mismatch (emit RESUME_PARSED vs real RESUME_PROCESSED) is caught", async () => {
    // ontology says processResume emits RESUME_PROCESSED; the brain hallucinated RESUME_PARSED
    const ont = [
      ontAction("processResume", ["RESUME_DOWNLOADED"], ["RESUME_PROCESSED"]),
      ontAction("deduplicateCandidate", ["RESUME_PROCESSED"], ["DEDUP_PASSED"]),
    ];
    const r = await verify_chain.execute({}, ctxOf([
      specOf({ short: "Parse", actionName: "processResume", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PARSED"] }),
      specOf({ short: "Dedup", actionName: "deduplicateCandidate", trigger: ["RESUME_PROCESSED"], emit: ["DEDUP_PASSED"] }),
    ], ont));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("Dedup");
  });
});
