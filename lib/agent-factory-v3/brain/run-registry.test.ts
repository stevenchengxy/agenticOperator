import { describe, it, expect } from "vitest";
import { subscribeRun, abortRun, isActiveRun, hasRun } from "./run-registry";

// The stream route relies on these unknown-id contracts to decide subscribe-vs-replay
// and to no-op a stop for an already-finished run. Lock them in.
describe("run-registry — unknown-run contracts", () => {
  it("subscribeRun returns null for an unknown run (→ route falls back to the durable transcript)", () => {
    expect(subscribeRun("nope_does_not_exist", () => {})).toBeNull();
  });

  it("abortRun returns false for an unknown / already-finished run (stop is a safe no-op)", () => {
    expect(abortRun("nope_does_not_exist")).toBe(false);
  });

  it("isActiveRun / hasRun are false for an unknown run", () => {
    expect(isActiveRun("nope_does_not_exist")).toBe(false);
    expect(hasRun("nope_does_not_exist")).toBe(false);
  });
});
