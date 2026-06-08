import { describe, it, expect } from "vitest";
import {
  buildOverviewAgentCards,
  agentStatus,
  statusOrder,
} from "./overview-agent-cards";
import {
  RECRUITMENT_DOMAIN_ID,
  ENERGY_DOMAIN_ID,
  COST_CONTROL_DOMAIN_ID,
} from "./domain-ids";
import type { AgentRow } from "./api/types";
import type { AgentHealth } from "@/app/api/agents/health/route";

function mkRow(p: Partial<AgentRow>): AgentRow {
  return {
    short: "X",
    wsId: "x",
    domain: RECRUITMENT_DOMAIN_ID,
    displayName: "X",
    inngestName: "X",
    stage: "system",
    kind: "auto",
    ownerTeam: "—",
    version: "—",
    status: null,
    p50Ms: null,
    runs24h: 0,
    successRate: null,
    costYuan: 0,
    lastActivityAt: null,
    spark: [],
    realness: "shell",
    slug: null,
    paused: false,
    ...p,
  };
}

function mkHealth(short: string, started: number): AgentHealth {
  return {
    short,
    status: "healthy",
    lastActivityAt: null,
    windowMs: 300_000,
    counts: { started, completed: 0, failed: 0, error: 0, anomaly: 0, tool: 0, decision: 0 },
    errorRate: 0,
    hasRunningStep: false,
  };
}

const noHealth = new Map<string, AgentHealth>();
// resolver knows only the recruitment roster; echoes the short for everything else.
const resolve = (s: string) => (s === "ResumeParser" ? "简历解析" : s);

describe("buildOverviewAgentCards", () => {
  it("surfaces energy (能源调度-v1) agents when the domain is energy — regression for the empty grid", () => {
    const rows = [
      mkRow({ short: "ResumeParser", domain: RECRUITMENT_DOMAIN_ID, realness: "real" }),
      mkRow({ short: "ForecastOutputAgent", domain: ENERGY_DOMAIN_ID, displayName: "主链路第②段·出力预测", slug: "energy-forecast-output" }),
      mkRow({ short: "InterpretDataAgent", domain: ENERGY_DOMAIN_ID, displayName: "主链路第①段·数据解释", slug: "energy-interpret-data" }),
    ];
    const cards = buildOverviewAgentCards(rows, ENERGY_DOMAIN_ID, noHealth, resolve);
    expect(cards.map((c) => c.short).sort()).toEqual(["ForecastOutputAgent", "InterpretDataAgent"]);
  });

  it("surfaces cost-control (费控-v1) agents when the domain is feikong", () => {
    const rows = [
      mkRow({ short: "RunInvoiceOCRAgent", domain: COST_CONTROL_DOMAIN_ID, displayName: "发票 OCR" }),
      mkRow({ short: "ForecastOutputAgent", domain: ENERGY_DOMAIN_ID }),
    ];
    const cards = buildOverviewAgentCards(rows, COST_CONTROL_DOMAIN_ID, noHealth, resolve);
    expect(cards.map((c) => c.short)).toEqual(["RunInvoiceOCRAgent"]);
  });

  it("keeps recruitment scoping intact and uses the localized resolver name", () => {
    const rows = [
      mkRow({ short: "ResumeParser", domain: RECRUITMENT_DOMAIN_ID, realness: "real" }),
      mkRow({ short: "ForecastOutputAgent", domain: ENERGY_DOMAIN_ID }),
    ];
    const cards = buildOverviewAgentCards(rows, RECRUITMENT_DOMAIN_ID, noHealth, resolve);
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe("简历解析");
  });

  it("falls back to the row's displayName for ontology agents the resolver doesn't know", () => {
    const rows = [
      mkRow({ short: "ForecastOutputAgent", domain: ENERGY_DOMAIN_ID, displayName: "主链路第②段·出力预测" }),
    ];
    const cards = buildOverviewAgentCards(rows, ENERGY_DOMAIN_ID, noHealth, resolve);
    expect(cards[0].name).toBe("主链路第②段·出力预测");
  });

  it("excludes the Chatbot UI assistant", () => {
    const rows = [
      mkRow({ short: "Chatbot", domain: RECRUITMENT_DOMAIN_ID }),
      mkRow({ short: "ResumeParser", domain: RECRUITMENT_DOMAIN_ID }),
    ];
    const cards = buildOverviewAgentCards(rows, RECRUITMENT_DOMAIN_ID, noHealth, resolve);
    expect(cards.map((c) => c.short)).toEqual(["ResumeParser"]);
  });

  it("carries realness + paused from the row through to status", () => {
    const rows = [
      mkRow({ short: "A", domain: ENERGY_DOMAIN_ID, realness: "shell", paused: false }),
      mkRow({ short: "B", domain: ENERGY_DOMAIN_ID, realness: "shell", paused: true }),
      mkRow({ short: "C", domain: ENERGY_DOMAIN_ID, realness: "unbuilt", paused: false }),
    ];
    const cards = buildOverviewAgentCards(rows, ENERGY_DOMAIN_ID, noHealth, resolve);
    const byShort = Object.fromEntries(cards.map((c) => [c.short, agentStatus(c)]));
    expect(byShort).toEqual({ A: "online", B: "paused", C: "offline" });
  });

  it("sorts online → paused → offline, then by recent activity within a band", () => {
    const rows = [
      mkRow({ short: "Off", domain: ENERGY_DOMAIN_ID, realness: "unbuilt" }),
      mkRow({ short: "Paused", domain: ENERGY_DOMAIN_ID, realness: "shell", paused: true }),
      mkRow({ short: "Busy", domain: ENERGY_DOMAIN_ID, realness: "shell" }),
      mkRow({ short: "Quiet", domain: ENERGY_DOMAIN_ID, realness: "shell" }),
    ];
    const health = new Map<string, AgentHealth>([
      ["Busy", mkHealth("Busy", 9)],
      ["Quiet", mkHealth("Quiet", 1)],
    ]);
    const cards = buildOverviewAgentCards(rows, ENERGY_DOMAIN_ID, health, resolve);
    expect(cards.map((c) => c.short)).toEqual(["Busy", "Quiet", "Paused", "Off"]);
  });

  it("statusOrder ranks online before paused before unbuilt", () => {
    expect(statusOrder({ kind: "shell", paused: false })).toBeLessThan(
      statusOrder({ kind: "shell", paused: true }),
    );
    expect(statusOrder({ kind: "shell", paused: true })).toBeLessThan(
      statusOrder({ kind: "unbuilt", paused: false }),
    );
  });
});
