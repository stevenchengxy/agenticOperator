import { describe, it, expect } from "vitest";
import { parseJobAnalysis } from "./job-analysis";

describe("parseJobAnalysis", () => {
  it("parses diagnosis + clusters + recommendations", () => {
    const a = parseJobAnalysis(
      '{"diagnosis":"流失集中在预筛","failureClusters":[{"reason":"竞业限制","count":5},{"reason":"学历不符","count":"2"}],"highlights":"通过率高","recommendations":["放宽竞业","补充JD"]}',
    );
    expect(a.diagnosis).toBe("流失集中在预筛");
    expect(a.failureClusters).toEqual([
      { reason: "竞业限制", count: 5 },
      { reason: "学历不符", count: 2 },
    ]);
    expect(a.recommendations).toEqual(["放宽竞业", "补充JD"]);
  });

  it("strips fences and drops malformed clusters", () => {
    const a = parseJobAnalysis('```json\n{"diagnosis":"d","failureClusters":[{"count":3},{"reason":"ok","count":1}]}\n```');
    expect(a.failureClusters).toEqual([{ reason: "ok", count: 1 }]); // cluster without reason dropped
    expect(a.highlights).toBe("");
    expect(a.recommendations).toEqual([]);
  });

  it("throws when no JSON", () => {
    expect(() => parseJobAnalysis("nope")).toThrow();
  });
});
