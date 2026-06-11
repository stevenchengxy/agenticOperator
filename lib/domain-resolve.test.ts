import { afterEach, describe, expect, it } from "vitest";
import { RECRUITMENT_DOMAIN_ID } from "./domain-ids";
import {
  resolveRecruitmentDomainId,
  recruitmentDomainId,
  recruitmentReadDomain,
  setResolvedRecruitmentDomainId,
} from "./domain-resolve";

const SAVED_ALLMETA_DOMAIN = process.env.ALLMETA_DOMAIN;

afterEach(() => {
  delete process.env.RECRUITMENT_DOMAIN_ALIASES;
  if (SAVED_ALLMETA_DOMAIN === undefined) delete process.env.ALLMETA_DOMAIN;
  else process.env.ALLMETA_DOMAIN = SAVED_ALLMETA_DOMAIN;
  // reset module cache back to the constant default
  setResolvedRecruitmentDomainId(null);
});

describe("resolveRecruitmentDomainId", () => {
  it("returns exact when the canonical id is present in the live list", () => {
    expect(resolveRecruitmentDomainId(["R7-001", RECRUITMENT_DOMAIN_ID, "费控-v1"])).toEqual({
      id: RECRUITMENT_DOMAIN_ID,
      status: "exact",
    });
  });

  it("falls back to a known alias id when the canonical id is absent", () => {
    expect(resolveRecruitmentDomainId(["RAAS-v1", "能源调度-v1"])).toEqual({
      id: "RAAS-v1",
      status: "alias",
    });
  });

  it("returns missing (canonical constant) when no alias is present in the live list", () => {
    expect(resolveRecruitmentDomainId(["能源调度-v1", "费控-v1"])).toEqual({
      id: RECRUITMENT_DOMAIN_ID,
      status: "missing",
    });
  });

  it("returns missing for an empty live list", () => {
    expect(resolveRecruitmentDomainId([])).toEqual({
      id: RECRUITMENT_DOMAIN_ID,
      status: "missing",
    });
  });

  it("prefers the canonical id over an alias when both are live", () => {
    expect(resolveRecruitmentDomainId(["RAAS-v1", RECRUITMENT_DOMAIN_ID])).toEqual({
      id: RECRUITMENT_DOMAIN_ID,
      status: "exact",
    });
  });

  it("picks aliases in declared precedence order when multiple are live", () => {
    // RAAS-v1 is declared before raas in the default alias list
    expect(resolveRecruitmentDomainId(["raas", "RAAS-v1"])).toEqual({
      id: "RAAS-v1",
      status: "alias",
    });
  });

  it("honors extra aliases from RECRUITMENT_DOMAIN_ALIASES (comma-separated)", () => {
    process.env.RECRUITMENT_DOMAIN_ALIASES = "招聘-v2, recruitment-prod";
    expect(resolveRecruitmentDomainId(["recruitment-prod"])).toEqual({
      id: "recruitment-prod",
      status: "alias",
    });
  });
});

describe("recruitmentDomainId / setResolvedRecruitmentDomainId", () => {
  it("defaults to the canonical constant before any resolution", () => {
    expect(recruitmentDomainId()).toBe(RECRUITMENT_DOMAIN_ID);
  });

  it("returns the cached resolved id after it is set", () => {
    setResolvedRecruitmentDomainId("RAAS-v1");
    expect(recruitmentDomainId()).toBe("RAAS-v1");
  });

  it("falls back to the constant when reset with null", () => {
    setResolvedRecruitmentDomainId("RAAS-v1");
    setResolvedRecruitmentDomainId(null);
    expect(recruitmentDomainId()).toBe(RECRUITMENT_DOMAIN_ID);
  });
});

describe("recruitmentReadDomain (escape hatch precedence)", () => {
  it("returns ALLMETA_DOMAIN verbatim when explicitly set (operator override wins)", () => {
    process.env.ALLMETA_DOMAIN = "manual-override-v9";
    setResolvedRecruitmentDomainId("RAAS-v1");
    expect(recruitmentReadDomain()).toBe("manual-override-v9");
  });

  it("uses the resolved id when ALLMETA_DOMAIN is unset", () => {
    delete process.env.ALLMETA_DOMAIN;
    setResolvedRecruitmentDomainId("RAAS-v1");
    expect(recruitmentReadDomain()).toBe("RAAS-v1");
  });

  it("falls back to the constant when ALLMETA_DOMAIN unset and nothing resolved", () => {
    delete process.env.ALLMETA_DOMAIN;
    expect(recruitmentReadDomain()).toBe(RECRUITMENT_DOMAIN_ID);
  });
});
