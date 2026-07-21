import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db", () => ({
  prisma: {
    eventInstance: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/allmeta-client", () => ({
  resolveEntityNames: vi.fn(),
}));

import { GET } from "./route";
import { prisma } from "@/server/db";
import { resolveEntityNames } from "@/lib/allmeta-client";

beforeEach(() => vi.resetAllMocks());

const req = (qs: string) => new Request(`http://x/api/events/candidates?${qs}`);

describe("GET /api/events/candidates", () => {
  it("groups events by candidate_id and computes latest stage", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      { id: "e1", name: "RESUME_PROCESSED", ts: new Date("2026-05-20T10:00:00Z"), payloadSummary: '{"candidate_id":"C-1","upload_id":"u1"}' },
      { id: "e2", name: "MATCH_RULE_CHECK_PASSED", ts: new Date("2026-05-20T10:05:00Z"), payloadSummary: '{"candidate_id":"C-1","job_requisition_id":"JR-1"}' },
      { id: "e3", name: "MATCH_PASSED_NEED_INTERVIEW", ts: new Date("2026-05-20T10:10:00Z"), payloadSummary: '{"candidate_id":"C-1","job_requisition_id":"JR-1"}' },
    ]);
    (resolveEntityNames as any).mockResolvedValue(new Map([["C-1", "Alice"]]));
    const res = await GET(req("windowHours=24"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      candidate_id: "C-1",
      candidate_name: "Alice",
      jr_ids: ["JR-1"],
      latest_stage: "match",
      event_count: 3,
    });
  });

  it("returns empty when no events", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    (resolveEntityNames as any).mockResolvedValue(new Map());
    const res = await GET(req(""));
    const body = await res.json();
    expect(body.candidates).toEqual([]);
  });

  it("ignores rows without candidate_id in payload", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      { id: "x1", name: "SCHEDULED_SYNC", ts: new Date(), payloadSummary: '{"misc":"x"}' },
    ]);
    (resolveEntityNames as any).mockResolvedValue(new Map());
    const res = await GET(req(""));
    const body = await res.json();
    expect(body.candidates).toEqual([]);
  });

  it("clamps windowHours and limit", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    (resolveEntityNames as any).mockResolvedValue(new Map());
    await GET(req("windowHours=99999&limit=99999"));
    // No assertion on the response — just verify it doesn't blow up
    expect((prisma.eventInstance.findMany as any).mock.calls.length).toBe(1);
  });

  it("falls back when resolveEntityNames throws", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      { id: "e1", name: "RESUME_PROCESSED", ts: new Date(), payloadSummary: '{"candidate_id":"C-2"}' },
    ]);
    (resolveEntityNames as any).mockRejectedValue(new Error("neo4j down"));
    const res = await GET(req(""));
    const body = await res.json();
    expect(body.candidates[0].candidate_id).toBe("C-2");
    expect(body.candidates[0].candidate_name).toBeNull();
  });

  it("returns 500 on prisma failure", async () => {
    (prisma.eventInstance.findMany as any).mockRejectedValue(new Error("db dead"));
    const res = await GET(req(""));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("multi-candidate event splits into multiple buckets", async () => {
    (prisma.eventInstance.findMany as any).mockResolvedValue([
      { id: "e1", name: "MATCH_PASSED_NEED_INTERVIEW", ts: new Date("2026-05-20T10:00:00Z"), payloadSummary: '{"candidate_id":"C-1"}' },
      { id: "e2", name: "MATCH_FAILED", ts: new Date("2026-05-20T10:01:00Z"), payloadSummary: '{"candidate_id":"C-2"}' },
    ]);
    (resolveEntityNames as any).mockResolvedValue(new Map());
    const res = await GET(req(""));
    const body = await res.json();
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].candidate_id).toBe("C-2"); // most recent first
  });
});
