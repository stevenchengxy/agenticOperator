import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: { funnelEventAnalysis: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/funnel/event-analysis", () => ({
  runEventAnalysis: vi.fn(),
  rowToAnalysis: vi.fn(),
}));

import { GET, POST } from "./route";
import { prisma } from "@/server/db";
import { runEventAnalysis, rowToAnalysis } from "@/lib/funnel/event-analysis";

const ANALYSIS = { summary: "s", chainRole: "c", reasoning: "r", risks: ["x"], nextStep: "n" };

describe("event-analysis route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET returns cached:false when nothing cached", async () => {
    (prisma.funnelEventAnalysis.findUnique as any).mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/funnel/event-analysis?event=e1"));
    expect(await res.json()).toMatchObject({ ok: true, cached: false, analysis: null });
  });

  it("GET returns cached analysis", async () => {
    (prisma.funnelEventAnalysis.findUnique as any).mockResolvedValue({ model: "m", durationMs: 10, promptTokens: 1, completionTokens: 2, createdAt: new Date("2026-06-05") });
    (rowToAnalysis as any).mockReturnValue(ANALYSIS);
    const res = await GET(new Request("http://x/api/funnel/event-analysis?event=e1"));
    const j = await res.json();
    expect(j.cached).toBe(true);
    expect(j.analysis).toMatchObject(ANALYSIS);
  });

  it("POST maps gateway_unavailable honestly (200, ok:false)", async () => {
    (runEventAnalysis as any).mockResolvedValue({ status: "gateway_unavailable" });
    const res = await POST(new Request("http://x/api/funnel/event-analysis?event=e1", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: "gateway_unavailable" });
  });

  it("POST maps error to 500", async () => {
    (runEventAnalysis as any).mockResolvedValue({ status: "error", error: "boom" });
    const res = await POST(new Request("http://x/api/funnel/event-analysis?event=e1", { method: "POST" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, reason: "error", error: "boom" });
  });

  it("POST returns generated analysis", async () => {
    (runEventAnalysis as any).mockResolvedValue({ status: "ok", cached: false, analysis: ANALYSIS, model: "kimi", durationMs: 42 });
    const res = await POST(new Request("http://x/api/funnel/event-analysis?event=e1", { method: "POST" }));
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, cached: false, analysis: ANALYSIS, model: "kimi" });
  });

  it("POST passes force flag through", async () => {
    (runEventAnalysis as any).mockResolvedValue({ status: "ok", cached: false, analysis: ANALYSIS, model: "m" });
    await POST(new Request("http://x/api/funnel/event-analysis?event=e1&force=1", { method: "POST" }));
    expect(runEventAnalysis).toHaveBeenCalledWith("e1", { force: true });
  });
});
