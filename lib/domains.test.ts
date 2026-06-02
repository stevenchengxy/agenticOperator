import { describe, it, expect } from "vitest";
import {
  SYSTEM_FALLBACK_DOMAINS,
  DOMAINS,
  DEFAULT_DOMAIN,
  isDomainId,
  getDomain,
} from "./domains";
import { RECRUITMENT_DOMAIN_ID, ENERGY_DOMAIN_ID } from "./domain-ids";

// Phase 0 (2026-06-01): the static `DOMAINS` constant became a pre-fetch
// fallback (SYSTEM_FALLBACK_DOMAINS). Runtime list comes from /api/domains.
// `DOMAINS` is kept as an alias for backwards-compat; tests cover the
// fallback-shape invariants only.

describe("SYSTEM_FALLBACK_DOMAINS", () => {
  it("contains the recruitment domain as the first / default domain", () => {
    expect(SYSTEM_FALLBACK_DOMAINS[0]!.id).toBe(RECRUITMENT_DOMAIN_ID);
    expect(DEFAULT_DOMAIN).toBe(RECRUITMENT_DOMAIN_ID);
  });

  it("contains the energy pack domain in the pre-fetch fallback", () => {
    expect(SYSTEM_FALLBACK_DOMAINS.find((d) => d.id === ENERGY_DOMAIN_ID)).toBeDefined();
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
    expect(getDomain(RECRUITMENT_DOMAIN_ID).id).toBe(RECRUITMENT_DOMAIN_ID);
    expect(getDomain(ENERGY_DOMAIN_ID).id).toBe(ENERGY_DOMAIN_ID);
  });

  it("falls back to the default (recruitment) domain for unknown ids", () => {
    // Runtime ids that aren't in the static fallback resolve to the default —
    // React-tree callers should use useDomain().getById() for accurate lookups;
    // getDomain() is kept stable for non-React callers.
    expect(getDomain("procurement").id).toBe(RECRUITMENT_DOMAIN_ID);
  });
});
