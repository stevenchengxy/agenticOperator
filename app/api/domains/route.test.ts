import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/server/db", () => ({
  prisma: {
    domain: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    agentVersion: {
      findMany: vi.fn(),
    },
  },
}));

// Stable AGENT_MAP for the countAgentsInDomain helper. Two raas, zero r7 — the
// archive-block test uses these.
vi.mock("@/lib/agent-mapping", () => ({
  AGENT_MAP: [
    { short: "Alpha", wsId: "1", domain: "raas" },
    { short: "Beta", wsId: "2", domain: "raas" },
  ],
}));

import { GET, POST, slugifyDomainName, countAgentsInDomain } from "./route";
import { prisma } from "@/server/db";

const m = prisma.domain as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};
const av = prisma.agentVersion as unknown as { findMany: ReturnType<typeof vi.fn> };

const fixedDate = new Date("2026-06-01T10:00:00Z");

function rowForId(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id === "raas" ? "RAAS · 招聘中台" : id === "r7" ? "R7 · ATS" : id,
    color: "oklch(0.65 0.18 250)",
    is_system: id === "raas" || id === "r7",
    created_at: fixedDate,
    archived_at: null,
    ...overrides,
  };
}

describe("slugifyDomainName", () => {
  it("lowercases and replaces non-ASCII with hyphens", () => {
    expect(slugifyDomainName("Procurement")).toBe("procurement");
    expect(slugifyDomainName("Talent & Hiring")).toBe("talent-hiring");
    expect(slugifyDomainName("  spaced out  ")).toBe("spaced-out");
  });

  it("transliterates CJK names to a pinyin slug", () => {
    expect(slugifyDomainName("采购报销")).toBe("cai-gou-bao-xiao");
    expect(slugifyDomainName("能源调度")).toBe("neng-yuan-diao-du");
    expect(slugifyDomainName("能源调度 v2")).toBe("neng-yuan-diao-du-v2");
  });

  it("returns empty string when nothing slug-able remains", () => {
    expect(slugifyDomainName("")).toBe("");
    expect(slugifyDomainName("   ")).toBe("");
    expect(slugifyDomainName("！？。")).toBe("");
  });
});

describe("countAgentsInDomain", () => {
  it("counts AGENT_MAP entries with matching domain", () => {
    expect(countAgentsInDomain("raas")).toBe(2);
    expect(countAgentsInDomain("r7")).toBe(0);
    expect(countAgentsInDomain("procurement")).toBe(0);
  });
});

describe("GET /api/domains", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force the Allmeta fetch to fail → deterministic seed list (招聘-v1, 能源调度-v1),
    // independent of whether the Studio dev server is running.
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no studio"));
    av.findMany.mockResolvedValue([]); // no agent-bearing domains by default
    m.findMany.mockResolvedValue([]); // no overrides by default
  });

  it("lists the union of Allmeta + agent-bearing + shipped packs (no DB writes)", async () => {
    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    const ids = j.domains.map((d: { id: string }) => d.id);
    expect(ids).toContain("招聘-v1");
    expect(ids).toContain("能源调度-v1");
    expect(j.domains[0].id).toBe("招聘-v1"); // recruitment ordered first
    // Never auto-writes / deletes the Domain table from GET (data isolation).
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("retains a domain that has agent data even if Allmeta dropped it (data isolation)", async () => {
    // Allmeta no longer lists 'orphan-v1', but agents still reference it.
    av.findMany.mockResolvedValue([{ domain: "orphan-v1" }]);
    const res = await GET();
    const j = await res.json();
    const ids = j.domains.map((d: { id: string }) => d.id);
    expect(ids).toContain("orphan-v1"); // never auto-removed → no orphaned agents
  });

  it("flags the runnable domain (能源调度-v1 ships an agent pack)", async () => {
    const res = await GET();
    const j = await res.json();
    const energy = j.domains.find((d: { id: string }) => d.id === "能源调度-v1");
    expect(energy?.runnable).toBe(true);
  });
});

describe("POST /api/domains", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.upsert.mockResolvedValue(rowForId("raas"));
    m.count.mockResolvedValue(0);
  });

  it("creates a domain when name resolves to a fresh slug", async () => {
    m.findUnique.mockResolvedValue(null);
    m.create.mockResolvedValue(rowForId("procurement", { is_system: false }));
    const req = new Request("http://x/api/domains", {
      method: "POST",
      body: JSON.stringify({ name: "Procurement" }),
    });
    const res = await POST(req);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.id).toBe("procurement");
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: "procurement",
          name: "Procurement",
          is_system: false,
        }),
      }),
    );
  });

  it("returns slug_collision when slug already exists", async () => {
    m.findUnique.mockResolvedValue(rowForId("raas"));
    const req = new Request("http://x/api/domains", {
      method: "POST",
      body: JSON.stringify({ name: "raas" }),
    });
    const res = await POST(req);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toBe("slug_collision");
    expect(j.existing_id).toBe("raas");
    expect(j.existing_name).toBe("RAAS · 招聘中台");
    expect(m.create).not.toHaveBeenCalled();
  });

  it("returns invalid_name when name is empty or produces no slug", async () => {
    const cases = ["", "   ", "！？。"];
    for (const name of cases) {
      const req = new Request("http://x/api/domains", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      const res = await POST(req);
      const j = await res.json();
      expect(j.ok).toBe(false);
      expect(j.reason).toBe("invalid_name");
    }
    expect(m.create).not.toHaveBeenCalled();
  });

  it("uses caller-supplied color when provided, otherwise picks from palette", async () => {
    m.findUnique.mockResolvedValue(null);
    m.create.mockImplementation(async (args: { data: { color: string; id: string } }) => ({
      ...rowForId(args.data.id, { is_system: false }),
      color: args.data.color,
    }));
    const req = new Request("http://x/api/domains", {
      method: "POST",
      body: JSON.stringify({ name: "Procurement", color: "oklch(0.5 0.1 200)" }),
    });
    const res = await POST(req);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.color).toBe("oklch(0.5 0.1 200)");
  });
});
