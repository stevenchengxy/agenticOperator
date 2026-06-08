import { describe, it, expect } from "vitest";
import { AGENT_MAP, hasRealInngestFn } from "@/lib/agent-mapping";
import { RECRUITMENT_DOMAIN_ID } from "@/lib/domain-ids";

// Locks the "the recruitment app is exactly these 5 real agents" invariant that
// both the Fleet「部署智能体」panel scope (app/api/agent-drafts/route.ts) and the
// seed (server/inngest/recruitment-deploy.ts) depend on. If someone adds an
// inngestId to a legacy shell or renames a real agent, this fails loudly.
describe("canonical real recruitment agents", () => {
  const reals = AGENT_MAP.filter((a) => a.domain === RECRUITMENT_DOMAIN_ID && hasRealInngestFn(a.short));

  it("is exactly the 5 real agents we actually have", () => {
    expect(reals.map((a) => a.short).sort()).toEqual(
      ["InterviewInviter", "JDGenerator", "Matcher", "ResumeParser", "RuleCheck"].sort(),
    );
  });

  it("each real agent carries an explicit inngestId (deterministic, registry-free)", () => {
    for (const a of reals) expect(a.inngestId).toBeTruthy();
  });

  it("excludes legacy design-era stub/unbuilt shorts", () => {
    for (const short of ["ReqSync", "ManualEntry", "Clarifier", "ReClarifier", "PortalSubmitter"]) {
      expect(hasRealInngestFn(short)).toBe(false);
    }
  });
});
