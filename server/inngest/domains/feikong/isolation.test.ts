import { describe, it, expect } from "vitest";
import { allFunctions } from "@/server/inngest/functions";

// The recruitment main app (agentic-operator-main, /api/inngest) must NEVER serve
// the 费控 or energy packs — those run on their own per-domain apps. This guards
// the "no pollution" contract structurally.
function fnId(fn: unknown): string {
  const f = fn as { opts?: { id?: string }; id?: (p?: string) => string };
  return f.opts?.id ?? (typeof f.id === "function" ? f.id() : "");
}

describe("isolation: recruitment main app never serves feikong/energy", () => {
  it("allFunctions has zero feikong- slugs", () => {
    const ids = allFunctions.map(fnId);
    expect(ids.filter((id) => id.startsWith("feikong-"))).toEqual([]);
  });
  it("allFunctions has zero energy- slugs", () => {
    const ids = allFunctions.map(fnId);
    expect(ids.filter((id) => id.startsWith("energy-"))).toEqual([]);
  });
});
