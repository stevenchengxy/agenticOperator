import { describe, it, expect } from "vitest";
import { buildReasoningTrace, traceTokenTarget, INFER_DURATION_MS, DETAIL_LIMIT } from "./reasoning-trace";
import type { InferredAgentCandidate, OntologyCounts } from "./types";

const COUNTS: OntologyCounts = { rules: 6, dataObjects: 6, actions: 6, events: 6, workflow: 1 };

const CAND = (over: Partial<InferredAgentCandidate> = {}): InferredAgentCandidate => ({
  key: "match-resume",
  short: "MatchResumeAgent",
  slug: "og-match-resume",
  nameZh: "岗位撮合",
  nameEn: "Job Matching",
  agentId: "MatchResumeAgent",
  descZh: "为通过预筛的候选人计算与岗位的契合度并深度评分",
  descEn: "Scores pre-screened candidates against the job for fit depth",
  triggerEvent: "MATCH_RULE_CHECK_PASSED",
  emitEvent: "MATCH_SCORED",
  rationaleZh: "下游缺少消费者",
  rationaleEn: "no downstream consumer",
  confidence: 96,
  iconChar: "岗",
  iconColor: "x",
  ...over,
});

describe("buildReasoningTrace", () => {
  it("emits a 6-step block per candidate plus opener + closer", () => {
    const steps = buildReasoningTrace([CAND(), CAND({ key: "interview", short: "InterviewInviterAgent", confidence: 92 })], COUNTS, "zh");
    // READ + DEDUCE(scan) + 2×6 candidate steps + DONE = 15
    expect(steps).toHaveLength(15);
    expect(steps[0].kind).toBe("READ");
    expect(steps[1].kind).toBe("DEDUCE");
    expect(steps[steps.length - 1].kind).toBe("DONE");
  });

  it("INFER steps carry the candidate key so a card can pop", () => {
    const steps = buildReasoningTrace([CAND()], COUNTS, "zh");
    const infer = steps.find((s) => s.kind === "INFER");
    expect(infer?.agentKey).toBe("match-resume");
  });

  it("grounds DEDUCE/LINK in the real trigger & emit events", () => {
    const steps = buildReasoningTrace([CAND()], COUNTS, "zh");
    const deduce = steps.find((s) => s.id === "match-resume-deduce");
    const link = steps.find((s) => s.id === "match-resume-link");
    expect(deduce?.text).toContain("MATCH_RULE_CHECK_PASSED");
    expect(link?.text).toContain("matchResume()"); // camelCase fn derived from short
    expect(link?.text).toContain("MATCH_SCORED");
  });

  it("derives the SCORE numbers deterministically from confidence (96 → 0.94/0.97/0.96)", () => {
    const steps = buildReasoningTrace([CAND({ confidence: 96 })], COUNTS, "zh");
    const score = steps.find((s) => s.kind === "SCORE");
    expect(score?.text).toContain("0.94");
    expect(score?.text).toContain("0.97");
    expect(score?.text).toContain("0.96");
  });

  it("is deterministic — same input yields identical output", () => {
    const a = buildReasoningTrace([CAND()], COUNTS, "en");
    const b = buildReasoningTrace([CAND()], COUNTS, "en");
    expect(a).toEqual(b);
  });

  it("assigns strictly increasing reveal fractions in (0,1)", () => {
    const steps = buildReasoningTrace([CAND()], COUNTS, "zh");
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i].at).toBeGreaterThan(0);
      expect(steps[i].at).toBeLessThan(1);
      if (i > 0) expect(steps[i].at).toBeGreaterThan(steps[i - 1].at);
    }
  });

  it("paces a longer pause before THINK than before the lighter LINK line", () => {
    const steps = buildReasoningTrace([CAND()], COUNTS, "zh");
    const at = (id: string) => steps.find((s) => s.id === id)!.at;
    const thinkGap = at("match-resume-think") - at("match-resume-weigh");
    const linkGap = at("match-resume-link") - at("match-resume-think");
    expect(thinkGap).toBeGreaterThan(linkGap); // THINK lingers
  });

  it("caps detailed candidate blocks to DETAIL_LIMIT and folds the rest into one summary line", () => {
    const many = Array.from({ length: 28 }, (_, i) =>
      CAND({ key: `a${i}`, short: `Action${i}Agent` }),
    );
    const steps = buildReasoningTrace(many, COUNTS, "zh");
    // READ + DEDUCE(scan) + DETAIL_LIMIT×6 + 1 summary INFER + DONE
    expect(steps).toHaveLength(2 + DETAIL_LIMIT * 6 + 1 + 1);
    const summary = steps.find((s) => s.id === "rest");
    expect(summary?.kind).toBe("INFER");
    expect(summary?.text).toContain(String(28 - DETAIL_LIMIT)); // "其余 26 个"
    // Cadence stays calm: the whole 10s window over this many lines means no line
    // reveals in under ~0.4s (proof the trace is bounded, not 171 lines deep).
    const minGap = Math.min(
      ...steps.map((s, i) => s.at - (i === 0 ? 0 : steps[i - 1].at)),
    );
    expect(minGap * INFER_DURATION_MS).toBeGreaterThan(400);
  });

  it("does not summarise when candidates fit within DETAIL_LIMIT", () => {
    const steps = buildReasoningTrace([CAND()], COUNTS, "zh");
    expect(steps.some((s) => s.id === "rest")).toBe(false);
  });

  it("produces a short no-gaps trace for an empty domain", () => {
    const steps = buildReasoningTrace([], COUNTS, "zh");
    expect(steps).toHaveLength(3); // READ + DEDUCE(no gaps) + DONE
    expect(steps.some((s) => s.kind === "INFER")).toBe(false);
    expect(steps[steps.length - 1].kind).toBe("DONE");
  });

  it("falls back to a generic LINK when the short isn't camelCase-derivable", () => {
    const steps = buildReasoningTrace([CAND({ short: "智能体A" })], COUNTS, "zh");
    const link = steps.find((s) => s.kind === "LINK");
    expect(link?.text).toContain("绑定动作");
  });
});

describe("traceTokenTarget", () => {
  it("scales with candidate count & confidence", () => {
    expect(traceTokenTarget([])).toBe(480);
    expect(traceTokenTarget([CAND({ confidence: 96 })])).toBeGreaterThan(480);
  });
});

describe("INFER_DURATION_MS", () => {
  it("pins the inference animation to a fixed 10s for every domain, regardless of trace length", () => {
    expect(INFER_DURATION_MS).toBe(10_000);
  });
});
