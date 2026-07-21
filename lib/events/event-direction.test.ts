import { describe, it, expect } from "vitest";
import { classifySource, classifyByPublishers } from "./event-direction";

describe("classifySource", () => {
  it("raas-bridge → in", () => {
    expect(classifySource("raas-bridge")).toBe("in");
  });
  it("manual.test-trigger → in", () => {
    expect(classifySource("manual.test-trigger")).toBe("in");
  });
  it("webhook.foo → in", () => {
    expect(classifySource("webhook.foo")).toBe("in");
  });
  it("rpa.matchResumeAgent → out", () => {
    expect(classifySource("rpa.matchResumeAgent")).toBe("out");
  });
  it("agent.monitor → out", () => {
    expect(classifySource("agent.monitor")).toBe("out");
  });
  it("null / empty → unknown", () => {
    expect(classifySource(null)).toBe("unknown");
    expect(classifySource("")).toBe("unknown");
    expect(classifySource("nonsense")).toBe("unknown");
  });
  it("case-insensitive", () => {
    expect(classifySource("RAAS-BRIDGE")).toBe("in");
    expect(classifySource("RPA.matchResumeAgent")).toBe("out");
  });
});

describe("classifyByPublishers", () => {
  it("external-intake publisher → in (manualEntry)", () => {
    expect(classifyByPublishers(["manualEntry"])).toBe("in");
  });
  it("external-intake publisher → in (resumeCollection)", () => {
    expect(classifyByPublishers(["resumeCollection"])).toBe("in");
  });
  it("external-intake publisher → in (syncFromClientSystem)", () => {
    expect(classifyByPublishers(["syncFromClientSystem"])).toBe("in");
  });
  it("AO-internal agent publisher → out (matchResume)", () => {
    expect(classifyByPublishers(["matchResume"])).toBe("out");
  });
  it("AO-internal agent publisher → out (processResume, resumeFix)", () => {
    expect(classifyByPublishers(["processResume", "resumeFix"])).toBe("out");
  });
  it("any intake publisher in the list wins → in", () => {
    // a hypothetical event published by both an intake and an internal agent
    expect(classifyByPublishers(["processResume", "resumeCollection"])).toBe("in");
  });
  it("empty / undefined publishers → unknown", () => {
    expect(classifyByPublishers([])).toBe("unknown");
    expect(classifyByPublishers(undefined)).toBe("unknown");
  });
});
