import { describe, it, expect } from "vitest";
import { classifySource } from "./event-direction";

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
