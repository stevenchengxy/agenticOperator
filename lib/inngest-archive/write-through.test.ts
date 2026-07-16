import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../server/db", () => ({
  prisma: {
    inngestRunArchive: { upsert: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("./writer", () => ({ archiveEvents: vi.fn(), archiveRunTrace: vi.fn() }));
vi.mock("../inngest-admin-client", () => ({ getRunHistory: vi.fn() }));

import { prisma } from "../../server/db";
import { archiveEvents, archiveRunTrace } from "./writer";
import { getRunHistory } from "../inngest-admin-client";
import {
  recordSentEvents,
  recordRunStart,
  recordRunFinish,
  captureRunTrace,
} from "./write-through";

beforeEach(() => vi.clearAllMocks());

describe("recordSentEvents", () => {
  it("zips payloads with returned ids and forwards to archiveEvents", async () => {
    await recordSentEvents([{ name: "A", data: { x: 1 } }, { name: "B" }], ["id1", "id2"]);
    expect(archiveEvents).toHaveBeenCalledWith([
      expect.objectContaining({ id: "id1", name: "A", data: { x: 1 } }),
      expect.objectContaining({ id: "id2", name: "B" }),
    ]);
  });

  it("drops payloads with no matching id", async () => {
    await recordSentEvents([{ name: "A" }, { name: "B" }], ["id1"]);
    const arg = (archiveEvents as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toHaveLength(1);
    expect(arg[0].id).toBe("id1");
  });

  it("does not call archiveEvents when nothing has an id", async () => {
    await recordSentEvents([{ name: "A" }], []);
    expect(archiveEvents).not.toHaveBeenCalled();
  });
});

describe("recordRunStart", () => {
  it("upserts a Running row; update path never changes status", async () => {
    await recordRunStart({
      runId: "r1",
      functionSlug: "app-fn",
      functionName: "Fn",
      startedAtIso: "2026-06-11T00:00:00.000Z",
      eventName: "evt",
      eventId: "e1",
    });
    const call = (prisma.inngestRunArchive.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where).toEqual({ runId: "r1" });
    expect(call.create).toMatchObject({
      runId: "r1",
      functionSlug: "app-fn",
      status: "Running",
      eventName: "evt",
      triggerEventIds: JSON.stringify(["e1"]),
    });
    expect(call.update).not.toHaveProperty("status"); // start must not downgrade a finished run
  });

  it("idempotently archives an externally-triggered event and its run payload", async () => {
    await recordRunStart({
      runId: "r-external",
      functionSlug: "agentic-operator-main-resume-parser-agent",
      functionName: "Resume Parser",
      appId: "agentic-operator-main",
      startedAtIso: "2026-06-11T00:00:00.000Z",
      event: {
        id: "evt-external",
        name: "RESUME_DOWNLOADED",
        data: { upload_id: "u1" },
        ts: 1781136000000,
        sourceApp: "raas-backend",
      },
    });

    expect(archiveEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "evt-external",
        name: "RESUME_DOWNLOADED",
        data: { upload_id: "u1" },
        sourceApp: "raas-backend",
      }),
    ]);
    const call = (prisma.inngestRunArchive.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.create).toMatchObject({
      appId: "agentic-operator-main",
      eventPayload: JSON.stringify({ upload_id: "u1" }),
      triggerEventIds: JSON.stringify(["evt-external"]),
    });
  });
});

describe("recordRunFinish", () => {
  it("writes terminal status + output + duration from stored startedAt", async () => {
    (prisma.inngestRunArchive.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      startedAt: new Date("2026-06-11T00:00:00.000Z"),
    });
    await recordRunFinish({
      runId: "r1",
      functionSlug: "app-fn",
      functionName: "Fn",
      status: "Completed",
      finishedAtIso: "2026-06-11T00:00:02.000Z",
      output: { ok: true },
      eventName: "evt",
      eventId: "e1",
    });
    const call = (prisma.inngestRunArchive.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.update).toMatchObject({
      status: "Completed",
      durationMs: 2000,
      output: JSON.stringify({ ok: true }),
    });
  });

  it("tolerates a missing startedAt (duration null)", async () => {
    (prisma.inngestRunArchive.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await recordRunFinish({
      runId: "r1",
      functionSlug: "app-fn",
      functionName: "Fn",
      status: "Failed",
      finishedAtIso: "2026-06-11T00:00:02.000Z",
      output: null,
    });
    const call = (prisma.inngestRunArchive.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.update.durationMs).toBeNull();
    expect(call.update.status).toBe("Failed");
  });
});

describe("captureRunTrace", () => {
  it("overrides live status/output with known-terminal values before archiving", async () => {
    (getRunHistory as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "r1",
      status: "Running",
      output: null,
      function: { name: "Fn", slug: "app-fn" },
      startedAt: "2026-06-11T00:00:00.000Z",
      steps: [],
      event: undefined,
    });
    await captureRunTrace({
      runId: "r1",
      status: "Completed",
      output: { ok: true },
      finishedAtIso: "2026-06-11T00:00:02.000Z",
    });
    expect(archiveRunTrace).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({
        status: "Completed",
        output: { ok: true },
        finishedAt: "2026-06-11T00:00:02.000Z",
      }),
    );
  });

  it("no-ops when the run is not in live history", async () => {
    (getRunHistory as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(
      await captureRunTrace({
        runId: "x",
        status: "Completed",
        output: null,
        finishedAtIso: "2026-06-11T00:00:00.000Z",
      }),
    ).toBe(0);
    expect(archiveRunTrace).not.toHaveBeenCalled();
  });
});
