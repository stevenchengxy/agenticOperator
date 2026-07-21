import { describe, it, expect } from "vitest";
import { modelChain, tierForContext } from "./model-router";

// #7 — config-driven tiered model routing with fallback chains.
describe("modelChain (#7 — no hardcoded model ids beyond FLASH/STRONG defaults)", () => {
  const env = { FACTORY_AI_MODEL: "flash/x", FACTORY_STRONG_MODEL: "strong/y" };

  it("an unset tier falls back to the tier's base model (fast→flash, default/hard→strong) + flash", () => {
    expect(modelChain("fast", env)).toEqual(["flash/x"]);
    expect(modelChain("default", env)).toEqual(["strong/y", "flash/x"]);
    expect(modelChain("hard", env)).toEqual(["strong/y", "flash/x"]);
  });

  it("parses a comma-separated chain and appends the base + flash as fallbacks", () => {
    expect(modelChain("hard", { ...env, FACTORY_MODEL_HARD: "a/1, b/2" })).toEqual(["a/1", "b/2", "strong/y", "flash/x"]);
  });

  it("dedupes when the chain already contains a fallback model", () => {
    expect(modelChain("hard", { ...env, FACTORY_MODEL_HARD: "strong/y, c/3" })).toEqual(["strong/y", "c/3", "flash/x"]);
  });

  it("routes each tier from its own env var independently", () => {
    const e = { ...env, FACTORY_MODEL_FAST: "f/1", FACTORY_MODEL_DEFAULT: "d/1", FACTORY_MODEL_HARD: "h/1" };
    expect(modelChain("fast", e)[0]).toBe("f/1");
    expect(modelChain("default", e)[0]).toBe("d/1");
    expect(modelChain("hard", e)[0]).toBe("h/1");
  });
});

describe("tierForContext (#7 — difficulty heuristic)", () => {
  it("is fast while only reading/planning (no plan, no specs)", () => {
    expect(tierForContext({ specs: [], currentPlan: null })).toBe("fast");
  });
  it("is default once a plan exists but nothing is designed", () => {
    expect(tierForContext({ specs: [], currentPlan: { v: 1 } })).toBe("default");
  });
  it("is hard the moment any spec is being designed/coded", () => {
    expect(tierForContext({ specs: [{}], currentPlan: { v: 1 } })).toBe("hard");
  });
});
