import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/server/llm/gateway");
import * as gateway from "@/server/llm/gateway";
import { recordLlmCall } from "./ledger";
import type { BuilderCtx, BuildEvent } from "./types";

function makeCtx(over: Partial<BuilderCtx> = {}): { ctx: BuilderCtx; events: BuildEvent[]; persisted: unknown[] } {
  const events: BuildEvent[] = [];
  const persisted: unknown[] = [];
  const ctx = {
    runId: "r1", domain: "d", ontology: {} as never,
    emit: (e: BuildEvent) => events.push(e),
    budget: { maxTokens: 10000, maxLlmCalls: 5 },
    spent: { tokens: 0, calls: 0 },
    ...over,
  } as BuilderCtx;
  return { ctx, events, persisted };
}

describe("recordLlmCall", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("calls the gateway, records full I/O, emits an llm event, charges budget", async () => {
    // The manual mock (__mocks__/gateway.ts) returns deterministic builder text for
    // facet-analyst; usage is prompt_tokens 10 + completion_tokens 20 = 30.
    const { ctx, events } = makeCtx();
    const persist = vi.fn().mockResolvedValue(undefined);
    const r = await recordLlmCall(ctx, { builder: "facet-analyst", target: "actions", purpose: "analyze", system: "S", user: "U", persist });
    // Real mock text — the `degraded` field is GONE from the return shape.
    expect(r.text.length).toBeGreaterThan(0);
    expect((r as { degraded?: unknown }).degraded).toBeUndefined();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1", builder: "facet-analyst", systemPrompt: "S", userPrompt: "U", responseText: r.text, degraded: false }));
    expect(events.find((e) => e.t === "llm")).toBeTruthy();
    expect(ctx.spent.calls).toBe(1);
    expect(ctx.spent.tokens).toBe(30);
  });

  it("THROWS when the gateway is unconfigured (no fallback by design)", async () => {
    const cfgSpy = vi.spyOn(gateway, "isGatewayConfigured").mockReturnValueOnce(false);
    const chatSpy = vi.spyOn(gateway, "chatComplete");
    const { ctx } = makeCtx();
    const persist = vi.fn().mockResolvedValue(undefined);
    await expect(
      recordLlmCall(ctx, { builder: "x", target: null, purpose: "p", system: "S", user: "U", persist }),
    ).rejects.toThrow();
    expect(cfgSpy).toHaveBeenCalled();
    expect(chatSpy).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("THROWS instead of calling when over the call budget", async () => {
    const chatSpy = vi.spyOn(gateway, "chatComplete");
    const { ctx } = makeCtx({ budget: { maxTokens: 10000, maxLlmCalls: 1 }, spent: { tokens: 0, calls: 1 } });
    const persist = vi.fn().mockResolvedValue(undefined);
    await expect(
      recordLlmCall(ctx, { builder: "x", target: null, purpose: "p", system: "S", user: "U", persist }),
    ).rejects.toThrow();
    expect(chatSpy).not.toHaveBeenCalled();
  });
});
