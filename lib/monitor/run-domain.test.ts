import { describe, it, expect } from "vitest";
import { runDomainOf, slugToShort, shortToSlug } from "./run-domain";
import {
  RECRUITMENT_DOMAIN_ID,
  ENERGY_DOMAIN_ID,
  COST_CONTROL_DOMAIN_ID,
} from "../domain-ids";

const run = (slug: string) => ({ function: { slug } });

describe("runDomainOf", () => {
  it("attributes a per-domain energy app slug to the energy domain", () => {
    expect(
      runDomainOf(run(`agentic-operator-${ENERGY_DOMAIN_ID}-energy-dispatch`), new Map()),
    ).toBe(ENERGY_DOMAIN_ID);
  });

  it("attributes a per-domain cost-control app slug to 费控", () => {
    expect(
      runDomainOf(run(`agentic-operator-${COST_CONTROL_DOMAIN_ID}-budget-watch`), new Map()),
    ).toBe(COST_CONTROL_DOMAIN_ID);
  });

  it("falls back to recruitment for a main-app slug with no live map", () => {
    expect(
      runDomainOf(run("agentic-operator-main-create-jd-agent"), new Map()),
    ).toBe(RECRUITMENT_DOMAIN_ID);
  });

  it("honors the live slug→domain map for a main-app fnId", () => {
    const map = new Map<string, string>([["create-jd-agent", ENERGY_DOMAIN_ID]]);
    expect(
      runDomainOf(run("agentic-operator-main-create-jd-agent"), map),
    ).toBe(ENERGY_DOMAIN_ID);
  });

  it("defaults to recruitment for an empty / unknown slug", () => {
    expect(runDomainOf({ function: undefined }, new Map())).toBe(RECRUITMENT_DOMAIN_ID);
    expect(runDomainOf(run(""), new Map())).toBe(RECRUITMENT_DOMAIN_ID);
  });
});

describe("slugToShort / shortToSlug", () => {
  it("maps a main-app slug back to its agent short (explicit inngestId)", () => {
    expect(slugToShort("agentic-operator-main-create-jd-agent")).toBe("JDGenerator");
    expect(slugToShort("agentic-operator-main-rule-check-agent")).toBe("RuleCheck");
  });

  it("builds the slug for an agent with an explicit inngestId", () => {
    expect(shortToSlug("JDGenerator")).toBe("agentic-operator-main-create-jd-agent");
  });

  it("round-trips an agent that has no explicit inngestId (agent.<short>)", () => {
    const slug = shortToSlug("ReqSync");
    expect(slug).toBe("agentic-operator-main-agent.reqsync");
    expect(slugToShort(slug!)).toBe("ReqSync");
  });

  it("returns null for unknown shorts / slugs / undefined", () => {
    expect(slugToShort(undefined)).toBeNull();
    expect(slugToShort("agentic-operator-main-not-a-real-agent")).toBeNull();
    expect(shortToSlug("NoSuchAgent")).toBeNull();
  });
});
