import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: { funnelJobAnalysis: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/funnel/job-analysis", () => ({
  runJobAnalysis: vi.fn(),
  jobRowToAnalysis: vi.fn(),
}));

import { GET, POST } from "./route";
import { prisma } from "@/server/db";
import { runJobAnalysis, jobRowToAnalysis } from "@/lib/funnel/job-analysis";

const A = { diagnosis: "d", failureClusters: [{ reason: "竞业", count: 3 }], highlights: "h", recommendations: ["r"] };

describe("job-analysis route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET cached:false when none", async () => {
    (prisma.funnelJobAnalysis.findUnique as any).mockResolvedValue(null);
    expect(await (await GET(new Request("http://x?job=j1"))).json()).toMatchObject({ ok: true, cached: false, analysis: null });
  });

  it("GET returns cached", async () => {
    (prisma.funnelJobAnalysis.findUnique as any).mockResolvedValue({ model: "m", candidateCount: 11, createdAt: new Date("2026-06-05") });
    (jobRowToAnalysis as any).mockReturnValue(A);
    const j = await (await GET(new Request("http://x?job=j1"))).json();
    expect(j.cached).toBe(true);
    expect(j.analysis).toMatchObject(A);
  });

  it("POST returns generated analysis", async () => {
    (runJobAnalysis as any).mockResolvedValue({ status: "ok", cached: false, analysis: A, model: "kimi" });
    const j = await (await POST(new Request("http://x?job=j1", { method: "POST" }))).json();
    expect(j).toMatchObject({ ok: true, analysis: A, model: "kimi" });
  });

  it("POST degrades on gateway_unavailable (200, ok:false)", async () => {
    (runJobAnalysis as any).mockResolvedValue({ status: "gateway_unavailable" });
    const res = await POST(new Request("http://x?job=j1", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: "gateway_unavailable" });
  });
});
