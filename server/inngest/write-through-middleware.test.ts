import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/inngest-archive/write-through", () => ({
  recordSentEvents: vi.fn(),
  recordRunStart: vi.fn(),
  recordRunFinish: vi.fn().mockResolvedValue(undefined),
  captureRunTrace: vi.fn().mockResolvedValue(0),
}));

import * as wt from "../../lib/inngest-archive/write-through";
import { WriteThroughMiddleware } from "./write-through-middleware";

const fn = { id: () => "resume-parser-agent", name: "Resume Parser" };
const client = { id: "agentic-operator-main" };

// BaseMiddleware's constructor takes { client }; instantiate directly.
function mw(): InstanceType<typeof WriteThroughMiddleware> {
  return new (WriteThroughMiddleware as unknown as new (a: { client: unknown }) => InstanceType<
    typeof WriteThroughMiddleware
  >)({ client });
}

beforeEach(() => vi.clearAllMocks());

describe("WriteThroughMiddleware", () => {
  it("onRunStart records a Running row with app-prefixed slug", async () => {
    await mw().onRunStart({ ctx: { runId: "r1", event: { name: "evt", id: "e1" } }, fn } as never);
    expect(wt.recordRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "r1",
        functionSlug: "agentic-operator-main-resume-parser-agent",
        functionName: "Resume Parser",
        eventName: "evt",
        eventId: "e1",
      }),
    );
  });

  it("onRunComplete records terminal + fires trace capture", async () => {
    await mw().onRunComplete({
      ctx: { runId: "r1", event: { name: "evt", id: "e1" } },
      fn,
      output: { ok: true },
    } as never);
    expect(wt.recordRunFinish).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", status: "Completed", output: { ok: true } }),
    );
    expect(wt.captureRunTrace).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", status: "Completed" }),
    );
  });

  it("onRunError ignores non-final attempts", async () => {
    await mw().onRunError({
      ctx: { runId: "r1", event: {} },
      fn,
      error: new Error("x"),
      isFinalAttempt: false,
    } as never);
    expect(wt.recordRunFinish).not.toHaveBeenCalled();
    expect(wt.captureRunTrace).not.toHaveBeenCalled();
  });

  it("onRunError records Failed on the final attempt", async () => {
    await mw().onRunError({
      ctx: { runId: "r1", event: { name: "evt" } },
      fn,
      error: new Error("boom"),
      isFinalAttempt: true,
    } as never);
    expect(wt.recordRunFinish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Failed" }),
    );
  });

  it("wrapSendEvent returns next()'s output and records events with ids", async () => {
    const next = vi.fn().mockResolvedValue({ ids: ["id1"] });
    const out = await mw().wrapSendEvent({ events: [{ name: "A", data: { x: 1 } }], next } as never);
    expect(out).toEqual({ ids: ["id1"] });
    expect(wt.recordSentEvents).toHaveBeenCalledWith(
      [{ name: "A", data: { x: 1 }, ts: undefined }],
      ["id1"],
    );
  });

  it("a failing recorder never breaks the send", async () => {
    (wt.recordSentEvents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const next = vi.fn().mockResolvedValue({ ids: ["id1"] });
    await expect(
      mw().wrapSendEvent({ events: [{ name: "A" }], next } as never),
    ).resolves.toEqual({ ids: ["id1"] });
  });

  it("a failing run recorder never throws into the run", async () => {
    (wt.recordRunFinish as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    await expect(
      mw().onRunComplete({ ctx: { runId: "r1", event: {} }, fn, output: null } as never),
    ).resolves.toBeUndefined();
  });
});
