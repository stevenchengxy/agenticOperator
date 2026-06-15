import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma singleton — this route reads AgentActivity to aggregate a
// per-agent health snapshot. When Postgres is unreachable (dev without Docker,
// or an outage) the read must NOT 500 the whole /workflow canvas; it degrades
// to "every known agent idle" instead.
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  return {
    ...actual, // keep the real (pure) isDbUnreachableError / markDbUnreachable
    prisma: { agentActivity: { findMany: vi.fn() } },
  };
});

import { GET } from "./route";
import { prisma } from "@/server/db";

describe("GET /api/agents/health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("degrades to all-idle (200) when the DB is unreachable", async () => {
    (prisma.agentActivity.findMany as any).mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), {
        code: "ECONNREFUSED",
      }),
    );

    const res = await GET(new Request("http://x/api/agents/health"));
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.degraded).toBe(true);
    expect(j.agents.length).toBeGreaterThan(0);
    expect(j.agents.every((a: any) => a.status === "idle")).toBe(true);
  });

  it("computes health normally (no degraded flag) when the DB is reachable", async () => {
    (prisma.agentActivity.findMany as any).mockResolvedValue([]);

    const res = await GET(new Request("http://x/api/agents/health"));
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.degraded).toBeUndefined();
    expect(j.agents.every((a: any) => a.status === "idle")).toBe(true);
  });
});
