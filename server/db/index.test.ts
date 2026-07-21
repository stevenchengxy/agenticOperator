import { describe, it, expect } from "vitest";
import { prisma, isDbUnreachableMessage, isDbUnreachableError } from "./index";

// Smoke test: Prisma client instantiates against the SQLite file.
// Verifies all 21 P3 chunk-1 models are reachable through the client.
// Read-only — never writes; CRUD-level tests should live next to service modules.
describe("prisma client", () => {
  it("exposes all 21 chunk-1 models", () => {
    expect(prisma).toBeDefined();

    // WS workflow runtime (5)
    expect(typeof prisma.workflowRun.findMany).toBe("function");
    expect(typeof prisma.workflowStep.findMany).toBe("function");
    expect(typeof prisma.agentActivity.findMany).toBe("function");
    expect(typeof prisma.humanTask.findMany).toBe("function");
    expect(typeof prisma.chatbotSession.findMany).toBe("function");

    // WS Living KB (3)
    expect(typeof prisma.candidateLock.findMany).toBe("function");
    expect(typeof prisma.blacklist.findMany).toBe("function");
    expect(typeof prisma.agentEpisode.findMany).toBe("function");

    // WS AgentConfig (2)
    expect(typeof prisma.agentConfig.findMany).toBe("function");
    expect(typeof prisma.agentConfigHistory.findMany).toBe("function");

    // EM runtime / audit (3)
    expect(typeof prisma.auditLog.findMany).toBe("function");
    expect(typeof prisma.dLQEntry.findMany).toBe("function");
    expect(typeof prisma.dedupCache.findMany).toBe("function");

    // EM events / gateway (2)
    expect(typeof prisma.eventDefinition.findMany).toBe("function");
    expect(typeof prisma.gatewayFilterRule.findMany).toBe("function");

    // EM outbound + ingest (5)
    expect(typeof prisma.outboundEvent.findMany).toBe("function");
    expect(typeof prisma.raasMessage.findMany).toBe("function");
    expect(typeof prisma.rejectedMessage.findMany).toBe("function");
    expect(typeof prisma.ingestionConfig.findMany).toBe("function");
    expect(typeof prisma.executionTrace.findMany).toBe("function");

    // EM monitoring (1)
    expect(typeof prisma.healthIncident.findMany).toBe("function");
  });

  it("can read empty tables (CRUD smoke)", async () => {
    const runs = await prisma.workflowRun.findMany({ take: 1 });
    expect(Array.isArray(runs)).toBe(true);
    const eps = await prisma.agentEpisode.findMany({ take: 1 });
    expect(Array.isArray(eps)).toBe(true);
    const evs = await prisma.eventDefinition.findMany({ take: 1 });
    expect(Array.isArray(evs)).toBe(true);
  });
});

// The error-logging gate: only "can't reach the DB" connection failures are
// throttled into a single notice; real query bugs must still print so they
// stay debuggable.
describe("isDbUnreachableMessage", () => {
  it("matches node/pg connection-failure codes", () => {
    for (const code of [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "ECONNRESET",
      "EHOSTDOWN",
      "ENETUNREACH",
      "ENETDOWN",
      "EPIPE",
      "EAI_AGAIN",
    ]) {
      expect(isDbUnreachableMessage(`connect ${code} 127.0.0.1:5433`)).toBe(true);
    }
  });

  it("matches Prisma's own unreachable text (P1001 / P1002)", () => {
    expect(
      isDbUnreachableMessage("Can't reach database server at `localhost`:`5433`"),
    ).toBe(true);
    expect(isDbUnreachableMessage("Error code P1001: ...")).toBe(true);
    expect(isDbUnreachableMessage("Error code P1002: ...")).toBe(true);
  });

  it("matches pg-pool connection timeout phrasing", () => {
    expect(isDbUnreachableMessage("Connection terminated unexpectedly")).toBe(true);
    expect(isDbUnreachableMessage("connection timeout expired")).toBe(true);
  });

  it("does NOT match real query/business errors (they must stay visible)", () => {
    expect(
      isDbUnreachableMessage(
        "Unique constraint failed on the fields: (`email`)",
      ),
    ).toBe(false);
    expect(
      isDbUnreachableMessage("Null constraint violation on the fields: (`id`)"),
    ).toBe(false);
    expect(isDbUnreachableMessage("Invalid `prisma.user.findUnique()`")).toBe(false);
  });
});

// The reliable, format-independent detector used in `catch` blocks: a thrown
// connection error carries a code (Prisma P1001/P1002 or a node/pg conn code)
// even when the message has no reason text (Next dev's 'pretty' format).
describe("isDbUnreachableError", () => {
  it("detects by Prisma connection code (P1001 / P1002)", () => {
    expect(isDbUnreachableError({ code: "P1001" })).toBe(true);
    expect(isDbUnreachableError({ code: "P1002" })).toBe(true);
    // ...even when the message itself has no reason text (Next-dev shape).
    expect(
      isDbUnreachableError({
        code: "P1001",
        message: "Invalid `x` invocation in chunk.js:1:2",
      }),
    ).toBe(true);
  });

  it("detects by node/pg connection code", () => {
    expect(isDbUnreachableError({ code: "ECONNREFUSED" })).toBe(true);
    expect(
      isDbUnreachableError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })),
    ).toBe(true);
  });

  it("falls back to message text when there's no code", () => {
    expect(
      isDbUnreachableError(
        new Error("Can't reach database server at localhost:5433"),
      ),
    ).toBe(true);
  });

  it("rejects real query errors (e.g. P2002 unique-constraint)", () => {
    expect(
      isDbUnreachableError({
        code: "P2002",
        message: "Unique constraint failed on the fields: (`email`)",
      }),
    ).toBe(false);
  });

  it("handles null / undefined / non-error input", () => {
    expect(isDbUnreachableError(null)).toBe(false);
    expect(isDbUnreachableError(undefined)).toBe(false);
    expect(isDbUnreachableError("nope")).toBe(false);
  });
});
