import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock prisma so we drive what the archive table returns. listEvents reads
// inngest_event_archive and reshapes rows into the live client's InngestEvent.
const mockFindMany = vi.fn();
vi.mock("../../server/db", () => ({
  prisma: {
    inngestEventArchive: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));
// reader.ts imports the live client for re-exported helpers/types — stub it.
vi.mock("../inngest-admin-client", () => ({
  deriveFlowId: vi.fn(),
  flowLabel: vi.fn(),
}));

import { listEvents } from "./reader";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    internalId: "01J_INTERNAL",
    name: "RESUME_PROCESSED",
    data: JSON.stringify({ candidateId: "c1" }),
    ts: new Date("2026-06-15T08:00:00Z"),
    receivedAt: new Date("2026-06-15T08:00:01Z"),
    sourceApp: "agentic-operator-main",
    archivedAt: new Date("2026-06-15T08:00:02Z"),
    ...over,
  };
}

beforeEach(() => {
  mockFindMany.mockReset();
});

describe("archive reader listEvents", () => {
  it("maps an archived row to the live InngestEvent wire shape", async () => {
    mockFindMany.mockResolvedValue([row()]);
    const events = await listEvents(50);
    expect(events).toEqual([
      {
        id: "evt_1",
        internal_id: "01J_INTERNAL",
        name: "RESUME_PROCESSED",
        data: { candidateId: "c1" },
        ts: new Date("2026-06-15T08:00:00Z").getTime(),
        received_at: "2026-06-15T08:00:01.000Z",
      },
    ]);
  });

  it("tolerates null internalId / ts / receivedAt without crashing", async () => {
    mockFindMany.mockResolvedValue([
      row({ internalId: null, ts: null, receivedAt: null }),
    ]);
    const [e] = await listEvents(50);
    expect(e.internal_id).toBeUndefined();
    expect(e.ts).toBeUndefined();
    expect(e.received_at).toBeUndefined();
    expect(e.id).toBe("evt_1");
  });

  it("returns the raw string when data is not valid JSON", async () => {
    mockFindMany.mockResolvedValue([row({ data: "not json" })]);
    const [e] = await listEvents(50);
    expect(e.data).toBe("not json");
  });

  it("orders newest-first and applies the take limit", async () => {
    mockFindMany.mockResolvedValue([]);
    await listEvents(25);
    const arg = mockFindMany.mock.calls[0][0];
    expect(arg.take).toBe(25);
    expect(arg.orderBy).toEqual({ archivedAt: "desc" });
    expect(arg.where).toEqual({});
  });

  it("filters by event name when a name is given", async () => {
    mockFindMany.mockResolvedValue([]);
    await listEvents(25, "MATCH_FAILED");
    const arg = mockFindMany.mock.calls[0][0];
    expect(arg.where).toEqual({ name: "MATCH_FAILED" });
  });
});
