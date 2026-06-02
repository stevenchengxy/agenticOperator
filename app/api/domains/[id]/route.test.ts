import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: {
    domain: {
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    agentVersion: {
      count: vi.fn(),
    },
  },
}));

vi.mock("@/lib/agent-mapping", () => ({
  AGENT_MAP: [
    { short: "Alpha", wsId: "1", domain: "raas" },
    { short: "Beta", wsId: "2", domain: "raas" },
  ],
}));

import { PATCH, DELETE } from "./route";
import { prisma } from "@/server/db";

const m = prisma.domain as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
};
const av = prisma.agentVersion as unknown as { count: ReturnType<typeof vi.fn> };

const fixedDate = new Date("2026-06-01T10:00:00Z");

function rowForId(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id === "raas" ? "RAAS · 招聘中台" : id,
    color: "oklch(0.65 0.18 250)",
    is_system: id === "raas" || id === "r7",
    created_at: fixedDate,
    archived_at: null,
    ...overrides,
  };
}

describe("PATCH /api/domains/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renames an existing domain (upsert update branch)", async () => {
    m.upsert.mockResolvedValue(rowForId("raas", { name: "RAAS · v2" }));
    const res = await PATCH(
      new Request("http://x/api/domains/raas", {
        method: "PATCH",
        body: JSON.stringify({ name: "RAAS · v2" }),
      }),
      { params: Promise.resolve({ id: "raas" }) },
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.name).toBe("RAAS · v2");
    expect(m.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "raas" }, update: { name: "RAAS · v2" } }),
    );
  });

  it("creates an override row when renaming a synced domain with no row", async () => {
    // Allmeta-synced domains have no Domain row → upsert must CREATE it (no
    // longer a not_found error).
    m.upsert.mockResolvedValue(rowForId("费控-v1", { name: "费控X" }));
    const res = await PATCH(
      new Request("http://x/api/domains/费控-v1", {
        method: "PATCH",
        body: JSON.stringify({ name: "费控X" }),
      }),
      { params: Promise.resolve({ id: "费控-v1" }) },
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.domain.name).toBe("费控X");
    expect(m.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "费控-v1" },
        create: expect.objectContaining({ id: "费控-v1", name: "费控X" }),
        update: { name: "费控X" },
      }),
    );
  });

  it("rejects empty body / empty name", async () => {
    const res = await PATCH(
      new Request("http://x/api/domains/raas", {
        method: "PATCH",
        body: JSON.stringify({ name: "  " }),
      }),
      { params: Promise.resolve({ id: "raas" }) },
    );
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toBe("invalid_body");
  });
});

describe("DELETE /api/domains/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    av.count.mockResolvedValue(0); // no ontology shells unless a test sets it
  });

  it("archives an empty non-system domain", async () => {
    m.findUnique.mockResolvedValue(rowForId("procurement", { is_system: false }));
    m.update.mockResolvedValue({ ...rowForId("procurement"), archived_at: fixedDate });
    const res = await DELETE(
      new Request("http://x/api/domains/procurement", { method: "DELETE" }),
      { params: Promise.resolve({ id: "procurement" }) },
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "procurement" },
        data: expect.objectContaining({ archived_at: expect.any(Date) }),
      }),
    );
  });

  it("blocks archive of a system domain", async () => {
    m.findUnique.mockResolvedValue(rowForId("raas"));
    const res = await DELETE(
      new Request("http://x/api/domains/raas", { method: "DELETE" }),
      { params: Promise.resolve({ id: "raas" }) },
    );
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toBe("is_system");
    expect(m.update).not.toHaveBeenCalled();
  });

  it("blocks archive when AGENT_MAP still has agents for the domain", async () => {
    // raas has 2 agents in the mocked AGENT_MAP, but it's also is_system —
    // simulate a hypothetical non-system domain whose agents exist by faking
    // the lookup to return a non-system row with id 'raas' (the AGENT_MAP
    // mock is keyed on the id string).
    m.findUnique.mockResolvedValue(rowForId("raas", { is_system: false }));
    const res = await DELETE(
      new Request("http://x/api/domains/raas", { method: "DELETE" }),
      { params: Promise.resolve({ id: "raas" }) },
    );
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toBe("has_agents");
    expect(j.count).toBe(2);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("blocks archive when ontology shells exist (AgentVersion), even with 0 AGENT_MAP agents", async () => {
    m.findUnique.mockResolvedValue(rowForId("能源调度-v1", { is_system: false }));
    av.count.mockResolvedValue(5); // 5 ontology shells under this domain
    const res = await DELETE(
      new Request("http://x/api/domains/能源调度-v1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "能源调度-v1" }) },
    );
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toBe("has_agents");
    expect(j.count).toBe(5); // 0 AGENT_MAP + 5 shells
    expect(m.update).not.toHaveBeenCalled();
  });

  it("returns not_found for unknown id", async () => {
    m.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      new Request("http://x/api/domains/nope", { method: "DELETE" }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toBe("not_found");
  });
});
