import { describe, it, expect } from "vitest";
import { ENERGY_BEHAVIORS, type ComputeCtx } from "./behaviors";
import { buildScenarioData, type Scenario, type ScenarioData } from "./sim-data";

function ctx(scenario: Scenario, upstream: Record<string, unknown> = {}): ComputeCtx<ScenarioData> {
  return {
    caseId: "case-x",
    dsNo: "DS2026053000123",
    scenario,
    dataset: buildScenarioData(scenario),
    upstream,
    logger: { event: () => {} },
    step: { run: async (_id, fn) => fn() },
  };
}

describe("manualConfirm behavior (人工确认闸口①)", () => {
  const b = ENERGY_BEHAVIORS.manualConfirm;

  it("route=auto → auto-adopt, no gate", async () => {
    const r = await b.compute(ctx("happy", { route: "auto" }));
    expect(r.gate).toBeUndefined();
    expect(r.payloadByEvent?.MANUAL_REVIEW_DECIDED?.decision).toBe("adopt");
  });

  it("route=risk-first → skip", async () => {
    const r = await b.compute(ctx("risk-redline", { route: "risk-first" }));
    expect(r.skip).toBe(true);
  });

  it("route=manual → gate; 采纳→adopt, 退回→regenerate with reset claims", async () => {
    const r = await b.compute(ctx("manual-review", { route: "manual", failedConditions: ["置信度≥0.9(置信度0.86)"] }));
    expect(r.gate?.gateKey).toBe("manualConfirm");
    const adopt = r.gate!.route({ decision: "采纳", operator: "老张" });
    expect(adopt.emitEvents).toEqual(["MANUAL_REVIEW_DECIDED"]);
    expect(adopt.payload.decision).toBe("adopt");
    const back = r.gate!.route({ decision: "退回", reason: "午后偏差待核" });
    expect(back.emitEvents).toEqual(["FORECAST_COMPLETED"]);
    expect(back.payload.revised).toBe(true);
    expect(back.resetClaims).toContain("generateSuggestion");
  });
});

describe("raiseRiskEvent + handleFloodControl (风险处置闸口②)", () => {
  it("raiseRiskEvent: redline violation → RISK_EVENT_RAISED with riskType", async () => {
    const r = await ENERGY_BEHAVIORS.raiseRiskEvent.compute(
      ctx("risk-redline", { redlineFlag: true, violations: [{ code: "CR-HYD-05", riskType: "T3", riskLevel: "L3", before: "1613.2m", after: "≤1612m" }] }),
    );
    expect(r.payloadByEvent?.RISK_EVENT_RAISED?.riskType).toBe("T3");
    expect(String(r.payloadByEvent?.RISK_EVENT_RAISED?.rkNo)).toMatch(/^RK/);
  });

  it("raiseRiskEvent: no redline → skip", async () => {
    const r = await ENERGY_BEHAVIORS.raiseRiskEvent.compute(ctx("happy", { redlineFlag: false }));
    expect(r.skip).toBe(true);
  });

  it("handleFloodControl: T3 → gate; 放行→FLOOD_CONTROL_HANDLED", async () => {
    const r = await ENERGY_BEHAVIORS.handleFloodControl.compute(ctx("risk-redline", { riskType: "T3", riskLevel: "L3", rkNo: "RK2026053000001", hitRule: "CR-HYD-05" }));
    expect(r.gate?.gateKey).toBe("handleFloodControl");
    const pass = r.gate!.route({ decision: "放行", operator: "王海涛" });
    expect(pass.emitEvents).toEqual(["FLOOD_CONTROL_HANDLED"]);
    const hold = r.gate!.route({ decision: "暂缓" });
    expect(hold.emitEvents).toEqual([]);
  });

  it("handleGridSecurity: not T2 → skip on a T3 case", async () => {
    const r = await ENERGY_BEHAVIORS.handleGridSecurity.compute(ctx("risk-redline", { riskType: "T3" }));
    expect(r.skip).toBe(true);
  });
});

describe("finalizePlan behavior (定版封口闸口③)", () => {
  const b = ENERGY_BEHAVIORS.finalizePlan;

  it("happy: no version mismatch → auto-lock DP", async () => {
    const r = await b.compute(ctx("happy", { decision: "adopt" }));
    expect(r.gate).toBeUndefined();
    expect(r.payloadByEvent?.PLAN_FINALIZED?.locked).toBe(true);
  });

  it("revise/reject decision → skip (don't finalize)", async () => {
    const r = await b.compute(ctx("happy", { decision: "revise" }));
    expect(r.skip).toBe(true);
  });

  it("finalize-confirm: version mismatch → gate; 确认封口→PLAN_FINALIZED", async () => {
    const r = await b.compute(ctx("finalize-confirm", { decision: "adopt" }));
    expect(r.gate?.gateKey).toBe("finalizePlan");
    const seal = r.gate!.route({ decision: "确认封口", operator: "老张" });
    expect(seal.emitEvents).toEqual(["PLAN_FINALIZED"]);
    expect(seal.payload.versionConfirmed).toBe(true);
  });

  it("overrides triggers to drop ROUTING_DECIDED", () => {
    expect(b.triggerOverride).toEqual(["MANUAL_REVIEW_DECIDED", "RISK_DISPOSED"]);
  });
});
