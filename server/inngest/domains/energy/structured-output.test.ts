import { describe, it, expect } from "vitest";
import { buildSchemaHint, parseOrSynthesize } from "./structured-output";
import { simulateTool, simulateTools, toolResultsForPrompt } from "./sim-tools";
import type { OntologyEvent } from "@/lib/ontology-generator/ontology-source";

const EVT: OntologyEvent = {
  name: "FORECAST_COMPLETED",
  payload: {
    source_action: "forecastOutput",
    event_data: [
      { name: "forecast_id", type: "String", target_object: "Forecast" },
      { name: "accuracy_rate", type: "Number", target_object: "Forecast" },
      { name: "is_confident", type: "Boolean", target_object: null },
    ],
    state_mutations: [],
  },
};

describe("structured-output", () => {
  it("schema hint lists every event_data key", () => {
    const hint = buildSchemaHint(EVT);
    expect(hint).toContain("forecast_id");
    expect(hint).toContain("accuracy_rate");
    expect(hint).toContain("is_confident");
  });

  it("parses valid LLM JSON and keeps its values", () => {
    const { payload, synthesized } = parseOrSynthesize(
      'sure:\n```json\n{"forecast_id":"F-1","accuracy_rate":0.92,"is_confident":true}\n```',
      EVT,
    );
    expect(synthesized).toBe(false);
    expect(payload.forecast_id).toBe("F-1");
    expect(payload.accuracy_rate).toBe(0.92);
  });

  it("back-fills missing keys from a partial completion", () => {
    const { payload, synthesized } = parseOrSynthesize('{"forecast_id":"F-2"}', EVT);
    expect(synthesized).toBe(false);
    expect(payload.forecast_id).toBe("F-2");
    expect("accuracy_rate" in payload).toBe(true);
    expect("is_confident" in payload).toBe(true);
  });

  it("synthesizes a full payload when no JSON can be recovered", () => {
    const { payload, synthesized } = parseOrSynthesize("no json here, sorry", EVT);
    expect(synthesized).toBe(true);
    expect("forecast_id" in payload).toBe(true);
    expect("accuracy_rate" in payload).toBe(true);
    expect("is_confident" in payload).toBe(true);
  });

  it("handles events with no event_data", () => {
    const { payload } = parseOrSynthesize("garbage", { name: "X", payload: { source_action: null, event_data: [], state_mutations: [] } });
    expect(payload.ok).toBe(true);
  });
});

describe("sim-tools", () => {
  it("is deterministic", () => {
    expect(simulateTool("慧采-SCADA接入", "forecastOutput")).toEqual(
      simulateTool("慧采-SCADA接入", "forecastOutput"),
    );
  });

  it("simulates each tool in order and renders a prompt block", () => {
    const res = simulateTools(["A", "B"], "act");
    expect(res.map((r) => r.tool)).toEqual(["A", "B"]);
    expect(toolResultsForPrompt(res)).toContain("A:");
    expect(toolResultsForPrompt([])).toBe("(无外部工具)");
  });
});
