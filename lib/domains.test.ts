import { describe, it, expect } from "vitest";
import { DOMAINS, DEFAULT_DOMAIN, isDomainId, getDomain } from "./domains";

describe("DOMAINS registry", () => {
  it("contains raas as the first / default domain", () => {
    expect(DOMAINS[0].id).toBe("raas");
    expect(DEFAULT_DOMAIN).toBe("raas");
  });

  it("contains r7 provisioned for future use", () => {
    expect(DOMAINS.find((d) => d.id === "r7")).toBeDefined();
  });

  it("every domain has zh + en labels", () => {
    for (const d of DOMAINS) {
      expect(d.label.zh.length).toBeGreaterThan(0);
      expect(d.label.en.length).toBeGreaterThan(0);
    }
  });
});

describe("isDomainId", () => {
  it("accepts known ids", () => {
    expect(isDomainId("raas")).toBe(true);
    expect(isDomainId("r7")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isDomainId("foo")).toBe(false);
    expect(isDomainId(undefined)).toBe(false);
    expect(isDomainId(null)).toBe(false);
    expect(isDomainId(42)).toBe(false);
  });
});

describe("getDomain", () => {
  it("returns the matching domain entry", () => {
    expect(getDomain("raas").id).toBe("raas");
    expect(getDomain("r7").id).toBe("r7");
  });
});
