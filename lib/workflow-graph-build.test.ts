import { describe, it, expect } from "vitest";
import {
  buildWorkflowGraph,
  deriveZhLabel,
  humanizeName,
} from "./workflow-graph-build";
import { ENERGY_DOMAIN_ID } from "./domain-ids";
import type {
  DomainOntology,
  OntologyAction,
} from "./ontology-generator/ontology-source";
import { Ic } from "@/components/shared/Ic";

function action(partial: Partial<OntologyAction> & { id: string }): OntologyAction {
  return {
    name: partial.id,
    description: "",
    actor: ["Agent"],
    trigger: [],
    triggered_event: [],
    target_objects: [],
    tool_use: [],
    system_prompt: "",
    user_prompt: "",
    ...partial,
  };
}

function onto(actions: OntologyAction[]): DomainOntology {
  return {
    domainId: "test-v1",
    objects: [],
    rules: [],
    actions,
    events: [],
    workflow: [],
    source: "snapshot",
  };
}

describe("buildWorkflowGraph", () => {
  it("emits one node per action plus the synthetic trigger", () => {
    const g = buildWorkflowGraph(
      onto([
        action({ id: "a", trigger: ["SEED"], triggered_event: ["E1"] }),
        action({ id: "b", trigger: ["E1"], triggered_event: ["E2"] }),
        action({ id: "c", trigger: ["E2"], triggered_event: [] }),
      ]),
    );
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "trig"]);
    expect(g.nodes.find((n) => n.id === "trig")!.kind).toBe("trigger");
  });

  it("wires an edge A→B when A emits an event B consumes", () => {
    const g = buildWorkflowGraph(
      onto([
        action({ id: "a", trigger: ["SEED"], triggered_event: ["E1"] }),
        action({ id: "b", trigger: ["E1"], triggered_event: [] }),
      ]),
    );
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: "a", to: "b", eventName: "E1" }),
    );
  });

  it("feeds the synthetic trigger into actions whose trigger events have no producer", () => {
    const g = buildWorkflowGraph(
      onto([action({ id: "a", trigger: ["EXTERNAL_SEED"], triggered_event: [] })]),
    );
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: "trig", to: "a", eventName: "EXTERNAL_SEED" }),
    );
  });

  it("lays the graph out left-to-right: every forward edge points rightward", () => {
    const g = buildWorkflowGraph(
      onto([
        action({ id: "a", trigger: ["SEED"], triggered_event: ["E1"] }),
        action({ id: "b", trigger: ["E1"], triggered_event: ["E2"] }),
        action({ id: "c", trigger: ["E2"], triggered_event: [] }),
      ]),
    );
    const x = new Map(g.nodes.map((n) => [n.id, n.x]));
    expect(x.get("a")!).toBeLessThan(x.get("b")!);
    expect(x.get("b")!).toBeLessThan(x.get("c")!);
    expect(x.get("trig")!).toBeLessThan(x.get("a")!);
  });

  it("survives cycles (human re-entry / back-edges) without hanging or dropping nodes", () => {
    const g = buildWorkflowGraph(
      onto([
        action({ id: "a", trigger: ["SEED", "REDO"], triggered_event: ["E1"] }),
        action({ id: "b", trigger: ["E1"], triggered_event: ["REDO"] }), // back to a
      ]),
    );
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "trig"]);
    // the back-edge is still drawn
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: "b", to: "a", eventName: "REDO" }),
    );
  });

  it("maps a Human-only actor to a HITL node with the user icon", () => {
    const g = buildWorkflowGraph(
      onto([
        action({ id: "review", actor: ["Human"], trigger: ["SEED"], triggered_event: [] }),
      ]),
    );
    const n = g.nodes.find((x) => x.id === "review")!;
    expect(n.kind).toBe("hitl");
    expect(n.icon).toBe("user");
    expect(n.deployment).toBe("conceptual");
  });

  it("only ever assigns valid Ic icon keys (an invalid key crashes the renderer)", () => {
    const g = buildWorkflowGraph(
      onto([
        action({ id: "sync", name: "ingestData", trigger: ["SEED"], triggered_event: ["E1"] }),
        action({ id: "check", name: "validateRule", trigger: ["E1"], triggered_event: ["E2"] }),
        action({ id: "notify", name: "sendAlert", trigger: ["E2"], triggered_event: [] }),
      ]),
    );
    for (const n of g.nodes) {
      expect(Ic[n.icon], `icon ${n.icon} on ${n.id}`).toBeDefined();
    }
  });

  it("de-dupes actions repeated by id", () => {
    const g = buildWorkflowGraph(
      onto([
        action({ id: "a", trigger: ["SEED"], triggered_event: [] }),
        action({ id: "a", trigger: ["SEED"], triggered_event: [] }),
      ]),
    );
    expect(g.nodes.filter((n) => n.id === "a")).toHaveLength(1);
  });

  it("carries a canonical payload on generated nodes for the detail panel", () => {
    const g = buildWorkflowGraph(
      onto([
        action({
          id: "a",
          name: "forecastOutput",
          description: "predict power output",
          actor: ["Agent"],
          trigger: ["SEED"],
          triggered_event: ["FORECAST_READY"],
        }),
      ]),
    );
    const n = g.nodes.find((x) => x.id === "a")!;
    expect(n.canonical).toMatchObject({
      id: "a",
      name: "forecastOutput",
      description: "predict power output",
      actor: ["Agent"],
      trigger: ["SEED"],
      triggered_event: ["FORECAST_READY"],
    });
  });

  it("keeps all coordinates positive even when a column has many rows", () => {
    // 6 actions all triggered by the same seed → one fat column centered on the
    // spine, which without normalization would push rows to negative y.
    const fan = Array.from({ length: 6 }, (_, i) =>
      action({ id: `n${i}`, trigger: ["SEED"], triggered_event: [] }),
    );
    const g = buildWorkflowGraph(onto(fan));
    for (const n of g.nodes) {
      expect(n.y, `${n.id} y`).toBeGreaterThanOrEqual(0);
      expect(n.x, `${n.id} x`).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not collide when an action is literally named 'trig'", () => {
    const g = buildWorkflowGraph(
      onto([
        action({ id: "trig", name: "userTrig", trigger: ["SEED"], triggered_event: [] }),
      ]),
    );
    // both the synthetic trigger and the real action survive as distinct nodes
    expect(g.nodes).toHaveLength(2);
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("trig"); // the real action keeps "trig"
    // exactly one trigger-kind node, with a unique position
    const triggers = g.nodes.filter((n) => n.kind === "trigger");
    expect(triggers).toHaveLength(1);
    const positions = g.nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(2);
  });

  it("does not mis-dedupe edges when action ids contain spaces", () => {
    // 'a b'→'c' and 'a'→'b c' would collide under a space-joined key.
    const g = buildWorkflowGraph(
      onto([
        action({ id: "a b", trigger: ["SEED"], triggered_event: ["E1"] }),
        action({ id: "c", trigger: ["E1"], triggered_event: [] }),
        action({ id: "a", trigger: ["SEED"], triggered_event: ["E2"] }),
        action({ id: "b c", trigger: ["E2"], triggered_event: [] }),
      ]),
    );
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: "a b", to: "c", eventName: "E1" }),
    );
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: "a", to: "b c", eventName: "E2" }),
    );
  });

  it("humanizes English camelCase node names + carries a derived Chinese label", () => {
    const g = buildWorkflowGraph(
      onto([
        action({
          id: "1",
          name: "forecastOutput",
          description: "主链路第②段·出力预测(OP-01)。取设备可用容量为上限…",
          trigger: ["SEED"],
          triggered_event: [],
        }),
      ]),
    );
    const n = g.nodes.find((x) => x.id === "1")!;
    expect(n.title).toBe("Forecast Output"); // humanized English
    expect(n.titleZh).toBe("出力预测"); // derived Chinese label
  });

  describe("humanizeName", () => {
    it("splits camelCase into Title Case", () => {
      expect(humanizeName("forecastOutput")).toBe("Forecast Output");
      expect(humanizeName("ingestAndOpenCase")).toBe("Ingest And Open Case");
      expect(humanizeName("submitExpenseClaim")).toBe("Submit Expense Claim");
    });
    it("leaves CJK and already-spaced names untouched", () => {
      expect(humanizeName("出力预测")).toBe("出力预测");
      expect(humanizeName("Already Spaced")).toBe("Already Spaced");
    });
  });

  describe("deriveZhLabel", () => {
    it("extracts the label after a · marker in the first sentence", () => {
      expect(deriveZhLabel("主链路第②段·出力预测(OP-01)。其余…")).toBe("出力预测");
      expect(deriveZhLabel("主链路第①段·数据解释。对气象批次…")).toBe("数据解释");
      expect(deriveZhLabel("第二道防线·人工确认。当…")).toBe("人工确认");
    });
    it("returns undefined for sentence descriptions without a · label marker", () => {
      expect(deriveZhLabel("员工在启费通发起报销提报，系统生成单据…")).toBeUndefined();
      expect(deriveZhLabel("票夹云OCR引擎对提交报销单关联的每张票据识别…")).toBeUndefined();
      expect(deriveZhLabel(undefined)).toBeUndefined();
      expect(deriveZhLabel("")).toBeUndefined();
    });
    it("rejects over-long or non-CJK fragments", () => {
      expect(deriveZhLabel("x·ThisIsAVeryLongEnglishLabelThatShouldNotQualify。")).toBeUndefined();
    });
  });

  it("prefers the curated per-domain Chinese label over description parsing", () => {
    // ingestAndOpenCase has no "·" marker (deriveZhLabel → undefined), so this
    // only passes if the curated map for the energy domain is consulted.
    const g = buildWorkflowGraph({
      domainId: ENERGY_DOMAIN_ID,
      objects: [],
      rules: [],
      events: [],
      workflow: [],
      source: "snapshot",
      actions: [
        action({
          id: "1",
          name: "ingestAndOpenCase",
          description: "调度辅助决策主链路起点。慧采作为唯一入口…",
          trigger: ["SEED"],
          triggered_event: [],
        }),
      ],
    });
    const n = g.nodes.find((x) => x.id === "1")!;
    expect(n.title).toBe("Ingest And Open Case");
    expect(n.titleZh).toBe("数据接入开案");
  });

  it("returns an empty-but-valid graph (just the trigger) for an actionless ontology", () => {
    const g = buildWorkflowGraph(onto([]));
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]!.id).toBe("trig");
    expect(g.edges).toHaveLength(0);
  });
});
