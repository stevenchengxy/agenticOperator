import { describe, it, expect } from "vitest";
import { parseAnalysis } from "./event-analysis";

describe("parseAnalysis", () => {
  it("parses a clean JSON object", () => {
    const a = parseAnalysis('{"summary":"通过预筛","chainRole":"关键闸口","reasoning":"6/6规则通过","risks":["简历信息不全"],"nextStep":"进入撮合"}');
    expect(a).toEqual({
      summary: "通过预筛",
      chainRole: "关键闸口",
      reasoning: "6/6规则通过",
      risks: ["简历信息不全"],
      nextStep: "进入撮合",
    });
  });

  it("strips code fences and surrounding prose", () => {
    const a = parseAnalysis('好的，分析如下：\n```json\n{"summary":"s","chainRole":"c","reasoning":"r","risks":[],"nextStep":"n"}\n```');
    expect(a.summary).toBe("s");
    expect(a.risks).toEqual([]);
  });

  it("drops non-string risks and missing fields default to empty", () => {
    const a = parseAnalysis('{"summary":"s","risks":["ok",123,null]}');
    expect(a.risks).toEqual(["ok"]);
    expect(a.chainRole).toBe("");
    expect(a.nextStep).toBe("");
  });

  it("throws when no JSON object present", () => {
    expect(() => parseAnalysis("no json here")).toThrow();
  });
});
