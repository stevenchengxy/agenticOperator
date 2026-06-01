import { describe, it, expect } from "vitest";
import { loadSnapshotOntology } from "./ontology-source";
import { deriveAgents, findEvent } from "./analyze";

describe("deriveAgents — nengyuandiaodu-v1", () => {
  const onto = loadSnapshotOntology("nengyuandiaodu-v1");
  const agents = deriveAgents(onto);

  it("derives one agent per action", () => {
    expect(agents.length).toBe(28);
  });

  it("splits 17 llm agents and 11 simulated-human responders", () => {
    expect(agents.filter((a) => a.kind === "llm").length).toBe(17);
    expect(agents.filter((a) => a.kind === "simulated-human").length).toBe(11);
  });

  it("derives forecastOutput as a wired llm agent", () => {
    const f = agents.find((a) => a.actionName === "forecastOutput")!;
    expect(f.kind).toBe("llm");
    expect(f.slug).toBe("energy-forecast-output");
    expect(f.short).toBe("ForecastOutputAgent");
    expect(f.triggerEvents).toContain("DATA_INTERPRETED");
    expect(f.emitEvents).toContain("FORECAST_COMPLETED");
    expect(f.systemPrompt.length).toBeGreaterThan(0);
    expect(f.userPrompt.length).toBeGreaterThan(0);
    expect(f.tools.length).toBeGreaterThan(0);
    expect(f.objects.length).toBeGreaterThan(0);
  });

  it("marks manualConfirm as a simulated-human responder", () => {
    const m = agents.find((a) => a.actionName === "manualConfirm")!;
    expect(m.kind).toBe("simulated-human");
    expect(m.emitEvents).toContain("MANUAL_REVIEW_DECIDED");
  });

  it("slugs are unique", () => {
    const slugs = new Set(agents.map((a) => a.slug));
    expect(slugs.size).toBe(agents.length);
  });

  it("findEvent resolves an emitted event's payload schema", () => {
    const evt = findEvent(onto, "FORECAST_COMPLETED");
    expect(evt).toBeDefined();
    expect(Array.isArray(evt!.payload.event_data)).toBe(true);
  });
});
