import { describe, it, expect } from "vitest";
import {
  SYSTEM_FALLBACK_DOMAINS,
  DOMAINS,
  DEFAULT_DOMAIN,
  isDomainId,
  getDomain,
} from "./domains";

// Phase 0 (2026-06-01): the static `DOMAINS` constant became a pre-fetch
// fallback (SYSTEM_FALLBACK_DOMAINS). Runtime list comes from /api/domains.
// `DOMAINS` is kept as an alias for backwards-compat; tests cover the
// fallback-shape invariants only.

describe("SYSTEM_FALLBACK_DOMAINS", () => {
  it("contains raas as the first / default domain", () => {
    expect(SYSTEM_FALLBACK_DOMAINS[0]!.id).toBe("raas");
    expect(DEFAULT_DOMAIN).toBe("raas");
  });

  it("contains r7 provisioned for future use", () => {
    expect(SYSTEM_FALLBACK_DOMAINS.find((d) => d.id === "r7")).toBeDefined();
  });

  it("every fallback domain has a non-empty name + OKLCH color + is_system=true", () => {
    for (const d of SYSTEM_FALLBACK_DOMAINS) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.color).toMatch(/^oklch\(/);
      expect(d.is_system).toBe(true);
    }
  });

  it("DOMAINS is the backwards-compat alias of SYSTEM_FALLBACK_DOMAINS", () => {
    expect(DOMAINS).toBe(SYSTEM_FALLBACK_DOMAINS);
  });
});

describe("isDomainId", () => {
  it("accepts non-empty strings (runtime ids are dynamic now)", () => {
    expect(isDomainId("raas")).toBe(true);
    expect(isDomainId("r7")).toBe(true);
    expect(isDomainId("procurement")).toBe(true);
  });

  it("rejects non-strings and empty strings", () => {
    expect(isDomainId(undefined)).toBe(false);
    expect(isDomainId(null)).toBe(false);
    expect(isDomainId(42)).toBe(false);
    expect(isDomainId("")).toBe(false);
  });
});

describe("getDomain (legacy static lookup against fallback)", () => {
  it("returns the matching fallback row for known ids", () => {
    expect(getDomain("raas").id).toBe("raas");
    expect(getDomain("r7").id).toBe("r7");
  });

  it("falls back to raas for unknown ids (legacy stable behavior)", () => {
    // Runtime ids that aren't in the static fallback resolve to raas — the
    // intent is that React-tree callers should switch to useDomain().getById()
    // for accurate lookups; getDomain() is kept stable for non-React callers.
    expect(getDomain("procurement").id).toBe("raas");
  });
});
