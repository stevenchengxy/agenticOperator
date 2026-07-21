import { describe, it, expect } from "vitest";
import {
  loadSnapshotOntology,
  hasSnapshot,
  fetchDomainOntology,
  loadSnapshotWorkflow,
  dedupeActionsByName,
  type OntologyAction,
} from "./ontology-source";

const mkAction = (over: Partial<OntologyAction>): OntologyAction => ({
  id: "",
  name: "",
  actor: [],
  trigger: [],
  triggered_event: [],
  target_objects: [],
  tool_use: [],
  system_prompt: "",
  user_prompt: "",
  ...over,
});

describe("dedupeActionsByName — action name is the ontology primary key", () => {
  it("collapses two same-named actions to one (招聘-v1 ships two matchResume nodes)", () => {
    // The live 招聘-v1 export carries id:10 (older schema, actor-less after
    // normalization) and id:10-2 (patched, actor:["Agent"]), both named
    // "matchResume" — which gave the generator two identical React keys and crashed.
    const actions = [
      mkAction({ id: "10", name: "matchResume", actor: [] }),
      mkAction({ id: "10-2", name: "matchResume", actor: ["Agent"] }),
    ];
    const deduped = dedupeActionsByName(actions);
    expect(deduped.length).toBe(1);
    // keeps the more complete record (the one that declares an actor)
    expect(deduped[0].id).toBe("10-2");
    expect(deduped[0].actor).toEqual(["Agent"]);
  });

  it("yields a unique key per action name", () => {
    const deduped = dedupeActionsByName([
      mkAction({ name: "a", actor: ["Agent"] }),
      mkAction({ name: "b", actor: ["Agent"] }),
      mkAction({ name: "a", actor: ["Agent"] }),
    ]);
    expect(new Set(deduped.map((a) => a.name)).size).toBe(deduped.length);
  });

  it("preserves first-seen order and keeps the first record when neither declares an actor", () => {
    const deduped = dedupeActionsByName([
      mkAction({ id: "x1", name: "x", actor: [] }),
      mkAction({ id: "y1", name: "y", actor: [] }),
      mkAction({ id: "x2", name: "x", actor: [] }),
    ]);
    expect(deduped.map((a) => a.name)).toEqual(["x", "y"]);
    expect(deduped[0].id).toBe("x1"); // tie-break: first seen wins
  });
});

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

  it("unwraps the {metadata, workflows[]} envelope into 28 workflow definitions", () => {
    // Bug: the loader stored the whole envelope object into `workflow`, so the
    // count saw a single truthy object (1) instead of the 28 workflows inside.
    const o = loadSnapshotOntology("能源调度-v1");
    expect(Array.isArray(o.workflow)).toBe(true);
    expect(o.workflow.length).toBe(28);
  });

  it("fetchDomainOntology falls back to snapshot when live is empty", async () => {
    // Live Allmeta returns empty items for the new domain → snapshot wins.
    const o = await fetchDomainOntology("能源调度-v1");
    expect(o.actions.length).toBe(28);
    expect(o.workflow.length).toBe(28);
    expect(o.source).toBe("snapshot");
  });

  it("unknown domain with no snapshot yields an empty shell (workflow is [] not null)", async () => {
    const o = await fetchDomainOntology("does-not-exist-v9");
    expect(o.actions).toEqual([]);
    expect(o.events).toEqual([]);
    expect(o.workflow).toEqual([]);
  });
});

describe("ontology-source — 费控-v1 workflow snapshot", () => {
  it("loadSnapshotWorkflow returns the 14 费控 workflow definitions", () => {
    expect(loadSnapshotWorkflow("费控-v1").length).toBe(14);
  });
});
