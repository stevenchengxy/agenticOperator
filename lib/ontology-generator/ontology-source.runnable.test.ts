import { describe, it, expect } from "vitest";
import {
  fetchRunnableOntology,
  loadSnapshotOntology,
  hasSnapshot,
} from "./ontology-source";
import { COST_CONTROL_DOMAIN_ID, ENERGY_DOMAIN_ID } from "../domain-ids";

// A snapshot-shipping domain is a RUNNABLE PACK: its in-repo snapshot is what
// the registered Inngest functions, the curated zh workflow labels, and the
// rule-check executor are built from. fetchRunnableOntology must therefore read
// that snapshot — NOT the richer-but-non-runnable live Allmeta draft — so the
// Workflow canvas + Ontology Generator stay consistent with what actually runs.
describe("fetchRunnableOntology", () => {
  it("reads the in-repo snapshot for 费控 (registered runnable pack)", async () => {
    expect(hasSnapshot(COST_CONTROL_DOMAIN_ID)).toBe(true);
    const onto = await fetchRunnableOntology(COST_CONTROL_DOMAIN_ID);
    const snap = loadSnapshotOntology(COST_CONTROL_DOMAIN_ID);
    expect(onto.source).toBe("snapshot");
    expect(onto.actions.length).toBeGreaterThan(0);
    // Identical action set to the snapshot → the generate step (which derives
    // from the same snapshot) gets matching keys, and the canvas's curated zh
    // labels (keyed by these names) resolve.
    expect(onto.actions.map((a) => a.name).sort()).toEqual(
      snap.actions.map((a) => a.name).sort(),
    );
  });

  it("reads the in-repo snapshot for energy too", async () => {
    const onto = await fetchRunnableOntology(ENERGY_DOMAIN_ID);
    expect(onto.source).toBe("snapshot");
    expect(onto.actions.length).toBeGreaterThan(0);
  });
});
