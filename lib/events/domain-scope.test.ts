import { describe, expect, it } from "vitest";
import {
  COST_CONTROL_DOMAIN_ID,
  ENERGY_DOMAIN_ID,
  RECRUITMENT_DOMAIN_ID,
} from "../domain-ids";
import {
  domainFromSourceApp,
  eventLeafName,
  eventMatchesDomain,
  inferEventDomain,
} from "./domain-scope";

describe("event domain scope", () => {
  it("classifies domain event namespaces", () => {
    expect(inferEventDomain({ name: "energy/HUMAN_DECISION" })).toBe(ENERGY_DOMAIN_ID);
    expect(inferEventDomain({ name: "feikong/EXPENSE_SUBMITTED" })).toBe(COST_CONTROL_DOMAIN_ID);
  });

  it("uses explicit payload domain before falling back to recruitment", () => {
    expect(inferEventDomain({ name: "CUSTOM_EVENT", data: { domain: ENERGY_DOMAIN_ID } })).toBe(ENERGY_DOMAIN_ID);
    expect(inferEventDomain({ name: "RESUME_PROCESSED", data: {} })).toBe(RECRUITMENT_DOMAIN_ID);
  });

  it("derives per-domain AO apps from sourceApp", () => {
    expect(domainFromSourceApp("agentic-operator-main")).toBe(RECRUITMENT_DOMAIN_ID);
    expect(domainFromSourceApp(`agentic-operator-${ENERGY_DOMAIN_ID}`)).toBe(ENERGY_DOMAIN_ID);
  });

  it("matches recruitment aliases and rejects other domains", () => {
    expect(eventMatchesDomain({ name: "RESUME_PROCESSED" }, "raas")).toBe(true);
    expect(eventMatchesDomain({ name: "energy/HUMAN_DECISION" }, RECRUITMENT_DOMAIN_ID)).toBe(false);
  });

  it("extracts leaf names from event namespaces", () => {
    expect(eventLeafName("sandbox-Agents-generation/RESUME_PROCESSED")).toBe("RESUME_PROCESSED");
    expect(eventLeafName("RESUME_PROCESSED")).toBe("RESUME_PROCESSED");
  });
});
