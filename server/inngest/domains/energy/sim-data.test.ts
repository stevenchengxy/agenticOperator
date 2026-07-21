import { describe, it, expect } from "vitest";
import { buildScenarioData, SCENARIOS, N_POINTS, LIMITS, STATIONS } from "./sim-data";

describe("energy sim-data", () => {
  it("builds all 4 scenarios with 96-point curves within capacity", () => {
    for (const s of SCENARIOS) {
      const d = buildScenarioData(s);
      const { gzl, gateExport, hydro, wind, solar } = d.curve;
      for (const c of [gzl, gateExport, hydro, wind, solar]) expect(c).toHaveLength(N_POINTS);
      expect(Math.max(...wind)).toBeLessThanOrEqual(200);
      expect(Math.max(...solar)).toBeLessThanOrEqual(150);
      expect(Math.max(...hydro)).toBeLessThanOrEqual(600 + 450 + 400 + 240);
      // solar dark at midnight, lit at noon
      expect(solar[0]).toBe(0);
      expect(solar[48]).toBeGreaterThan(80);
    }
  });

  it("is deterministic (same scenario → identical data)", () => {
    expect(buildScenarioData("happy")).toEqual(buildScenarioData("happy"));
  });

  it("happy: high confidence, low deviation, water below flood limit, auto", () => {
    const d = buildScenarioData("happy");
    expect(d.forecastConfidence).toBe(0.93);
    expect(d.gzlDeviationPct).toBeLessThanOrEqual(LIMITS.gzlTolerancePct);
    expect(d.waterLevelM).toBeLessThan(LIMITS.floodLimitM);
    expect(d.expect.redline).toBe(false);
    expect(d.expect.routeToManual).toBe(false);
    expect(d.expect.gate).toBeNull();
  });

  it("manual-review: low confidence routes to manual (no redline)", () => {
    const d = buildScenarioData("manual-review");
    expect(d.forecastConfidence).toBeLessThan(LIMITS.confidenceFloor);
    expect(d.expect.redline).toBe(false);
    expect(d.expect.routeToManual).toBe(true);
    expect(d.expect.gate).toBe("manualConfirm");
  });

  it("risk-redline: water level exceeds flood limit → redline", () => {
    const d = buildScenarioData("risk-redline");
    expect(d.waterLevelM).toBeGreaterThan(LIMITS.floodLimitM);
    expect(d.expect.redline).toBe(true);
    expect(d.expect.gate).toBe("handleFloodControl");
  });

  it("finalize-confirm: version mismatch triggers the 封口 gate", () => {
    const d = buildScenarioData("finalize-confirm");
    expect(d.versionMismatch).toBe(true);
    expect(d.expect.redline).toBe(false);
    expect(d.expect.gate).toBe("finalizePlan");
  });

  it("gate-export stays at/under GZL for non-redline scenarios (CR-GRID-03 不超关口)", () => {
    for (const s of SCENARIOS) {
      const d = buildScenarioData(s);
      const over = d.curve.gateExport.filter((g, i) => g > d.curve.gzl[i] + 0.01);
      expect(over).toHaveLength(0);
    }
  });

  it("station baseline matches the use-case (6 stations, ST0101 龙盘一级 600MW)", () => {
    expect(STATIONS).toHaveLength(6);
    const st0101 = STATIONS.find((s) => s.id === "ST0101")!;
    expect(st0101.capacityMW).toBe(600);
    expect(st0101.type).toBe("hydro");
  });
});
