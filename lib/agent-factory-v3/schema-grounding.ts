// P5 — constrained decoding (source-level hallucination control). Inject
// JSON-schema `enum`s into the brain's design_agent / refine_agent tool schemas
// so the model can only emit a REAL ontology action name (`action`) and REAL
// registry tool names (`tools[]`). Invented symbols ("parseResumeFile", a
// non-existent action) become ungeneratable — when the LLM gateway honors enum
// constraints. If it doesn't, P1 (visible bridge / De-Hallucinator) and P2
// (ungrounded-reference rejection) still catch them post-hoc, so this is a
// strengthening layer, not a single point of failure.
//
// Adaptive, not hardcoded: the enum lists ARE the live ontology/registry, rebuilt
// per domain — no tool or action name is named in code.

import type { ToolSchema } from "./brain/stream-gateway";

/** Return a NEW schema array with design_agent/refine_agent `action` + `tools`
 *  constrained to the given names. Pure + immutable (never mutates the input).
 *  An empty `toolNames` adds NO tools enum (so a domain with no registry tools
 *  isn't forbidden from binding anything). */
export function injectGroundingEnums(
  schemas: ToolSchema[],
  grounding: { actionNames?: string[]; toolNames?: string[] },
): ToolSchema[] {
  return schemas.map((s) => {
    if (s.function.name !== "design_agent" && s.function.name !== "refine_agent") return s;
    const params = JSON.parse(JSON.stringify(s.function.parameters)) as {
      properties?: Record<string, Record<string, unknown>>;
    };
    const props = params.properties ?? {};
    if (grounding.actionNames?.length && props.action) {
      props.action = { ...props.action, enum: grounding.actionNames };
    }
    if (grounding.toolNames?.length && props.tools && props.tools.items) {
      props.tools = {
        ...props.tools,
        items: { ...(props.tools.items as Record<string, unknown>), enum: grounding.toolNames },
      };
    }
    params.properties = props;
    return { ...s, function: { ...s.function, parameters: params } };
  });
}
