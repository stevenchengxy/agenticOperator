import { describe, it, expect } from "vitest";
import {
  loadSnapshotOntology,
  hasSnapshot,
  fetchDomainOntology,
} from "./ontology-source";

describe("ontology-source — 能源调度-v1 snapshot", () => {
  it("has a snapshot for the energy domain", () => {
    expect(hasSnapshot("能源调度-v1")).toBe(true);
  });

  it("loads the five-piece ontology with expected counts", () => {
    const o = loadSnapshotOntology("能源调度-v1");
    expect(o.actions.length).toBe(28);
    expect(o.events.length).toBe(31);
    expect(o.objects.length).toBe(30);
    expect(o.rules.length).toBe(81);
    expect(o.source).toBe("snapshot");
  });

  it("preserves action wiring fields (actor / trigger / triggered_event / prompts)", () => {
    const o = loadSnapshotOntology("能源调度-v1");
    const forecast = o.actions.find((a) => a.name === "forecastOutput");
    expect(forecast).toBeDefined();
    expect(forecast!.actor).toContain("Agent");
    expect(forecast!.trigger).toContain("DATA_INTERPRETED");
    expect(forecast!.triggered_event).toContain("FORECAST_COMPLETED");
    expect(forecast!.system_prompt.length).toBeGreaterThan(0);
    expect(forecast!.tool_use.length).toBeGreaterThan(0);
  });

  it("fetchDomainOntology falls back to snapshot when live is empty", async () => {
    // Live Allmeta returns empty items for the new domain → snapshot wins.
    const o = await fetchDomainOntology("能源调度-v1");
    expect(o.actions.length).toBe(28);
    expect(o.source).toBe("snapshot");
  });

  it("unknown domain with no snapshot yields an empty shell", async () => {
    const o = await fetchDomainOntology("does-not-exist-v9");
    expect(o.actions).toEqual([]);
    expect(o.events).toEqual([]);
  });
});
