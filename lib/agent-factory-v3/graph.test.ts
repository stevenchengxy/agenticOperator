import { describe, it, expect } from "vitest";
import { loadSnapshotOntology } from "@/lib/ontology-generator/ontology-source";
import type { OntologyAction } from "@/lib/ontology-generator/ontology-source";
import { compileGraph, verifyGraph } from "./graph";

const ont = loadSnapshotOntology("recruit-gen-v1");

describe("compileGraph (recruit-gen-v1, real ontology)", () => {
  const g = compileGraph(ont.actions, { domainId: "recruit-gen-v1" });

  it("makes one node per action", () => {
    expect(g.nodes).toHaveLength(6);
    expect(g.nodes.map((n) => n.action).sort()).toEqual(
      ["candidateIdentity", "createJd", "inviteInterview", "matchResume", "parseResume", "ruleCheck"].sort(),
    );
  });

  it("derives edges from triggered_event → trigger (the real chain)", () => {
    const edge = (from: string, to: string) => g.edges.some((e) => e.from === from && e.to === to);
    // parseResume --RESUME_PROCESSED--> ruleCheck --MATCH_RULE_CHECK_PASSED--> matchResume
    expect(edge("parseResume", "ruleCheck")).toBe(true);
    expect(edge("ruleCheck", "matchResume")).toBe(true);
    expect(g.edges.find((e) => e.from === "parseResume" && e.to === "ruleCheck")?.event).toBe("RESUME_PROCESSED");
  });

  it("marks conditional emitters as branch actions (emit > 1)", () => {
    expect(g.branchActions).toContain("parseResume"); // RESUME_PROCESSED | RESUME_LOCKED_CONFLICT
    expect(g.branchActions).toContain("ruleCheck");
    expect(g.branchActions).toContain("matchResume");
    expect(g.branchActions).not.toContain("createJd"); // single emit
  });

  it("identifies entry events (consumed, never emitted) and terminals (emitted, never consumed)", () => {
    expect(g.entryEvents).toContain("RESUME_DOWNLOADED");
    expect(g.entryEvents).toContain("INTERVIEW_INVITATION_REQUESTED");
    expect(g.terminalEvents).toContain("RESUME_LOCKED_CONFLICT");
    expect(g.terminalEvents).toContain("JD_GENERATED");
    // RESUME_PROCESSED is consumed downstream → NOT terminal
    expect(g.terminalEvents).not.toContain("RESUME_PROCESSED");
  });

  it("recruitment has no HITL (all actors are Agent — verified ground truth)", () => {
    expect(g.hitlActions).toEqual([]);
  });
});

describe("verifyGraph", () => {
  const full = compileGraph(ont.actions, { domainId: "recruit-gen-v1" });

  it("ground-truth ontology closes (ok, no issues)", () => {
    const r = verifyGraph(full);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("catches the v2 dangling-emit bug: a generated graph missing a producer", () => {
    // authoritative entry/terminal sets from the full ontology
    const known = { knownEntries: full.entryEvents, knownTerminals: full.terminalEvents };
    // a BAD generated plan that dropped `ruleCheck` (the real Planner 4-vs-6 failure)
    const bad = compileGraph(
      ont.actions.filter((a) => a.name !== "ruleCheck"),
      { domainId: "recruit-gen-v1" },
    );
    const r = verifyGraph(bad, known);
    expect(r.ok).toBe(false);
    // matchResume now consumes MATCH_RULE_CHECK_PASSED that nobody emits (and it's not an entry)
    expect(r.issues).toContainEqual({
      kind: "missing_producer",
      action: "matchResume",
      event: "MATCH_RULE_CHECK_PASSED",
    });
    // parseResume's RESUME_PROCESSED is now consumed by nobody and is not an authoritative terminal
    expect(r.issues).toContainEqual({
      kind: "orphan_emit",
      action: "parseResume",
      event: "RESUME_PROCESSED",
    });
  });

  it("detects an invented event the generator hallucinated", () => {
    const known = { knownEntries: full.entryEvents, knownTerminals: full.terminalEvents };
    const hallucinated: OntologyAction[] = [
      ...ont.actions,
      {
        id: "RG-X",
        name: "phantomDedup",
        actor: ["Agent"],
        trigger: ["RESUME_PROCESSED"],
        triggered_event: ["CANDIDATE_DEDUP_PASSED"], // invented, nobody consumes, not a real terminal
        target_objects: [],
        tool_use: [],
        system_prompt: "",
        user_prompt: "",
      },
    ];
    const g = compileGraph(hallucinated, { domainId: "recruit-gen-v1" });
    const r = verifyGraph(g, known);
    expect(r.ok).toBe(false);
    expect(r.issues).toContainEqual({
      kind: "orphan_emit",
      action: "phantomDedup",
      event: "CANDIDATE_DEDUP_PASSED",
    });
  });
});

describe("HITL detection (synthetic)", () => {
  it("flags Human actors and gate side-effects", () => {
    const acts: OntologyAction[] = [
      {
        id: "E-1", name: "dispatchOrder", actor: ["Agent"],
        trigger: ["ORDER_REQUESTED"], triggered_event: ["ORDER_GATE_PENDING"],
        target_objects: [], tool_use: [], system_prompt: "", user_prompt: "",
      },
      {
        id: "E-2", name: "humanApprove", actor: ["Human"],
        trigger: ["ORDER_GATE_PENDING"], triggered_event: ["ORDER_APPROVED"],
        target_objects: [], tool_use: [], system_prompt: "", user_prompt: "",
        side_effects: { gate: "waitForEvent HUMAN_DECISION" },
      },
    ];
    const g = compileGraph(acts, { domainId: "energy-synthetic" });
    expect(g.hitlActions).toContain("humanApprove");
  });
});
