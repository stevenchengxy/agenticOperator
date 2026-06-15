import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { isDbUnreachableMessage } from "./index";

// The whole "throttle the unreachable-DB flood" fix rests on ONE assumption:
// that Prisma's PrismaPg driver adapter surfaces a connection failure through
// the `error` LOG EVENT (so server/db's $on("error") handler can collapse it
// to a single notice) rather than auto-printing it some other way. This test
// proves that contract end-to-end against a guaranteed-dead local port — and
// guards against a future Prisma/adapter upgrade silently moving the channel.
describe("Prisma surfaces unreachable-DB errors via the error event", () => {
  it("emits error event(s) whose message classifies as unreachable", async () => {
    // 127.0.0.1:1 — nothing listens, so the connection is refused immediately
    // (deterministic + fast, no external dependency).
    const url = "postgresql://ao:ao_local_pw@127.0.0.1:1/ao";
    const client = new PrismaClient({
      adapter: new PrismaPg(url),
      log: [{ emit: "event", level: "error" }],
    });

    const messages: string[] = [];
    client.$on("error", (e) => messages.push(e.message));

    await client.agentActivity.findMany({ take: 1 }).catch(() => {
      /* expected — DB is unreachable */
    });
    await client.$disconnect().catch(() => {});

    // 1) The error reached the event channel (not stdout/stderr directly).
    expect(messages.length).toBeGreaterThan(0);
    // 2) Our classifier recognizes it as "unreachable" → it gets throttled,
    //    not printed per-query.
    expect(messages.some((m) => isDbUnreachableMessage(m))).toBe(true);
  }, 20_000);
});
