import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: {
    domain: {
      findUnique: vi.fn(),
      update: vi.fn(),
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
};

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

  it("renames an existing domain", async () => {
    m.findUnique.mockResolvedValue(rowForId("raas"));
    m.update.mockResolvedValue(rowForId("raas", { name: "RAAS · v2" }));
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
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "raas" }, data: { name: "RAAS · v2" } }),
    );
  });

  it("returns not_found when the domain doesn't exist", async () => {
    m.findUnique.mockResolvedValue(null);
    const res = await PATCH(
      new Request("http://x/api/domains/nope", {
        method: "PATCH",
        body: JSON.stringify({ name: "anything" }),
      }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toBe("not_found");
    expect(m.update).not.toHaveBeenCalled();
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
  beforeEach(() => vi.clearAllMocks());

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
