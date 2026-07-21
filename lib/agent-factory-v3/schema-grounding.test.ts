// P5 — constrained decoding. After read_ontology, the brain's design_agent /
// refine_agent tool schemas get their `action` + `tools` fields constrained to a
// JSON-schema enum of REAL ontology action names + real registry tool names, so
// invented symbols ("parseResumeFile", a non-existent action) are ungeneratable
// at the source (when the gateway honors enum). Adaptive: the enum is rebuilt
// per-domain from the live ontology/registry — zero hardcoded names.

import { describe, it, expect } from "vitest";
import { injectGroundingEnums } from "./schema-grounding";

const designAgentSchema = {
  type: "function" as const,
  function: {
    name: "design_agent",
    description: "d",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "the action" },
        tools: { type: "array", items: { type: "string" }, description: "tools" },
        system_prompt: { type: "string" },
      },
      required: ["action", "system_prompt"],
    },
  },
};

const otherSchema = {
  type: "function" as const,
  function: { name: "read_ontology", description: "r", parameters: { type: "object", properties: {} } },
};

describe("injectGroundingEnums (P5)", () => {
  it("constrains design_agent.action to the real action names", () => {
    const out = injectGroundingEnums([designAgentSchema], { actionNames: ["parseResume", "ruleCheck"], toolNames: [] });
    const props = out[0].function.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(["parseResume", "ruleCheck"]);
  });

  it("constrains design_agent.tools.items to the real registry names", () => {
    const out = injectGroundingEnums([designAgentSchema], { actionNames: ["a"], toolNames: ["robohire.parseResume", "minio.getResume"] });
    const props = out[0].function.parameters.properties as Record<string, { items?: { enum?: string[] } }>;
    expect(props.tools.items?.enum).toEqual(["robohire.parseResume", "minio.getResume"]);
  });

  it("does NOT add a tools enum when there are no registry tools (must not forbid every tool)", () => {
    const out = injectGroundingEnums([designAgentSchema], { actionNames: ["a"], toolNames: [] });
    const props = out[0].function.parameters.properties as Record<string, { items?: { enum?: string[] } }>;
    expect(props.tools.items?.enum).toBeUndefined();
  });

  it("leaves non-design/refine tool schemas untouched", () => {
    const out = injectGroundingEnums([otherSchema], { actionNames: ["a"], toolNames: ["t"] });
    expect(out[0]).toEqual(otherSchema);
  });

  it("does not mutate the input schema (returns new objects)", () => {
    const input = [designAgentSchema];
    const before = JSON.stringify(input);
    injectGroundingEnums(input, { actionNames: ["a"], toolNames: ["t"] });
    expect(JSON.stringify(input)).toBe(before);
  });
});
