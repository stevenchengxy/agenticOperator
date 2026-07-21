import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handlePrismaError,
  markDbUnreachable,
  __resetFloodStateForTest,
} from "./index";

// The exact shape Next.js dev's 'pretty' errorFormat produces for a failed
// query: invocation + a code frame, but NO reason text ("Can't reach database
// server" is absent). This is precisely what defeated the message-only fix —
// so the breaker must carry the load here.
const NEXT_DEV_MSG =
  "\nInvalid `prisma.serviceHeartbeat.update()` invocation in\n" +
  "/app/.next/dev/server/chunks/[root-of-the-server]__x._.js:1599:164\n\n" +
  "  1598 heartbeatTimer = setInterval(()=>{\n" +
  "→ 1599   void prisma.serviceHeartbeat.update(\n";

function counts(
  err: { mock: { calls: unknown[][] } },
  warn: { mock: { calls: unknown[][] } },
) {
  return {
    prismaErr: err.mock.calls.filter((c) =>
      String(c[0]).startsWith("prisma:error"),
    ).length,
    notices: warn.mock.calls.filter((c) =>
      String(c[0]).includes("Postgres unreachable"),
    ).length,
  };
}

describe("handlePrismaError flood control", () => {
  beforeEach(() => __resetFloodStateForTest());

  it("breaker primed → Next-dev errors (no reason) collapse to ONE throttled notice, no flood", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    markDbUnreachable(); // a caught P1001 primed it (format-independent)
    for (let i = 0; i < 20; i++) handlePrismaError(NEXT_DEV_MSG, "localhost:5433/ao");

    const c = counts(err, warn);
    err.mockRestore();
    warn.mockRestore();
    expect(c.prismaErr).toBe(0); // no per-query flood
    expect(c.notices).toBe(1); // single throttled friendly notice
  });

  it("breaker NOT primed → unclassifiable error prints once, repeats are throttled (bounded, never floods)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 20; i++) handlePrismaError(NEXT_DEV_MSG, "db");

    const c = counts(err, warn);
    err.mockRestore();
    warn.mockRestore();
    expect(c.prismaErr).toBe(1); // bounded even without the breaker
  });

  it("classifiable unreachable message needs no breaker — collapses immediately", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    handlePrismaError(
      "\nInvalid `x` invocation:\n\nCan't reach database server at 127.0.0.1:5433",
      "db",
    );

    const c = counts(err, warn);
    err.mockRestore();
    warn.mockRestore();
    expect(c.prismaErr).toBe(0);
    expect(c.notices).toBe(1);
  });

  it("a genuine query bug (not unreachable) still prints", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    handlePrismaError(
      "\nInvalid `x` invocation:\n\nUnique constraint failed on the fields: (`email`)",
      "db",
    );

    const c = counts(err, warn);
    err.mockRestore();
    warn.mockRestore();
    expect(c.prismaErr).toBe(1); // real bugs stay visible
    expect(c.notices).toBe(0);
  });
});
