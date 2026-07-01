import { describe, it, expect, beforeEach, vi } from "vitest";

// An Inngest app must serve ≥1 function or the dev server flags it red
// ("No functions registered within your app"). The lifecycle rule: a GENERATED
// per-domain app carries a keep-alive sentinel so it's never empty — it stays
// registered as a stable slot (real agents attach/detach alongside it). SANDBOX
// apps get no sentinel, so an empty one is DELETED rather than left erroring.

vi.mock("@/server/db", () => ({
  prisma: {
    domainInngestApp: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    agentVersion: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/server/db";
import { registerDomainApp, offlineDomainApp, resyncDomainApp, ensureDomainAppRegistered, getDomainApp } from "./domain-app";

const db = prisma as unknown as {
  domainInngestApp: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  agentVersion: { findMany: ReturnType<typeof vi.fn> };
};

type Captured = { deleteApp: number; register: number };

/** Stub fetch and classify outgoing calls. `apps` is what the Inngest probe
 *  (GraphQL `{ apps { … } }`) returns, so getDomainApp tests can assert counts. */
function installFetch(apps: Array<{ name: string; functionCount: number; error?: string | null; connected?: boolean; url?: string }> = []): Captured {
  const cap: Captured = { deleteApp: 0, register: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const body = init?.body ?? null;
      if (init?.method === "POST" && url.includes("/v0/gql") && typeof body === "string" && body.includes("deleteAppByName")) {
        cap.deleteApp++;
        return { ok: true, json: async () => ({ data: { deleteAppByName: "uuid" } }) } as unknown as Response;
      }
      if (init?.method === "POST" && url.includes("/v0/gql")) {
        // probe / resolveCallbackOrigin apps query
        return { ok: true, json: async () => ({ data: { apps } }) } as unknown as Response;
      }
      if (init?.method === "PUT") {
        cap.register++;
        return { ok: true, text: async () => "" } as unknown as Response;
      }
      return { ok: true, json: async () => ({ data: { apps } }), text: async () => "" } as unknown as Response;
    }),
  );
  return cap;
}

/** A deployed (active) generated agent shell row → one real Inngest function. */
function activeShell() {
  return {
    short: "tester",
    slug: "og-tester",
    configJson: JSON.stringify({ triggerEvent: "FOO_HAPPENED", emitEvent: "BAR_DONE", nameZh: "测试", agentId: "tester" }),
    specJson: JSON.stringify({ trigger: ["FOO_HAPPENED"], emit: ["BAR_DONE"], actionName: "tester", systemPrompt: "", userPrompt: "", tools: [] }),
  };
}

const GEN = "widget-domain"; // a generated per-domain app → carries the sentinel
const SANDBOX = "sandbox-widget-domain"; // ephemeral → no sentinel, delete-on-empty

describe("per-domain Inngest app lifecycle — keep-alive sentinel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INNGEST_SERVE_ORIGIN = "http://localhost:3002";
    db.domainInngestApp.upsert.mockResolvedValue({});
    db.domainInngestApp.update.mockResolvedValue({});
  });

  it("registers an empty generated domain via the sentinel (never empty, never deleted)", async () => {
    db.agentVersion.findMany.mockResolvedValue([]); // all drafts / none deployed
    const cap = installFetch();

    const r = await registerDomainApp(GEN);

    expect(r.ok).toBe(true); // the sentinel makes it a valid ≥1-function app
    expect(cap.register).toBe(1);
    expect(cap.deleteApp).toBe(0);
    expect(db.domainInngestApp.upsert.mock.calls[0][0].update.status).toBe("online");
  });

  it("registers a populated generated domain (sentinel + real agents)", async () => {
    db.agentVersion.findMany.mockResolvedValue([activeShell()]);
    const cap = installFetch();

    const r = await registerDomainApp(GEN);

    expect(r.ok).toBe(true);
    expect(cap.register).toBe(1);
    expect(cap.deleteApp).toBe(0);
  });

  it("does NOT sentinel a SANDBOX app — an empty one is deleted, not registered", async () => {
    db.agentVersion.findMany.mockResolvedValue([]); // sandbox torn down
    const cap = installFetch();

    const r = await registerDomainApp(SANDBOX);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no active functions/i);
    expect(cap.register).toBe(0);
    expect(cap.deleteApp).toBe(1);
    expect(db.domainInngestApp.upsert.mock.calls[0][0].update.status).toBe("offline");
  });

  it("offlineDomainApp deletes the app from Inngest", async () => {
    db.domainInngestApp.findUnique.mockResolvedValue({ domain: GEN, callbackUrl: "http://localhost:3002/api/inngest/widget-domain", status: "online" });
    const cap = installFetch();

    const r = await offlineDomainApp(GEN);

    expect(r.ok).toBe(true);
    expect(cap.deleteApp).toBe(1);
    expect(cap.register).toBe(0);
  });

  it("resyncDomainApp keeps an empty generated domain alive (re-registers via sentinel)", async () => {
    db.domainInngestApp.findUnique.mockResolvedValue({ domain: GEN, callbackUrl: "http://localhost:3002/api/inngest/widget-domain", status: "online" });
    db.agentVersion.findMany.mockResolvedValue([]); // agents reverted to draft
    const cap = installFetch();

    await resyncDomainApp(GEN);

    expect(cap.register).toBe(1); // sentinel → stays registered
    expect(cap.deleteApp).toBe(0);
  });

  it("resyncDomainApp deletes an empty SANDBOX app (no sentinel to keep it alive)", async () => {
    db.domainInngestApp.findUnique.mockResolvedValue({ domain: SANDBOX, callbackUrl: "http://localhost:3002/api/inngest/sandbox-widget-domain", status: "online" });
    db.agentVersion.findMany.mockResolvedValue([]); // sandbox torn down
    const cap = installFetch();

    await resyncDomainApp(SANDBOX);

    expect(cap.deleteApp).toBe(1);
    expect(cap.register).toBe(0);
  });

  it("ensureDomainAppRegistered registers a generated domain slot, no-ops for sandbox", async () => {
    db.agentVersion.findMany.mockResolvedValue([]);
    const capGen = installFetch();
    await ensureDomainAppRegistered(GEN);
    expect(capGen.register).toBe(1); // slot created at generation time

    vi.clearAllMocks();
    db.agentVersion.findMany.mockResolvedValue([]);
    const capSb = installFetch();
    await ensureDomainAppRegistered(SANDBOX);
    expect(capSb.register).toBe(0); // sandbox is excluded
    expect(capSb.deleteApp).toBe(0);
  });

  it("getDomainApp reports the REAL function count (subtracts the sentinel)", async () => {
    db.domainInngestApp.findUnique.mockResolvedValue({ domain: GEN, appId: "agentic-operator-widget-domain", callbackUrl: "x", status: "online", registeredAt: new Date() });
    installFetch([{ name: "agentic-operator-widget-domain", functionCount: 3, error: null, connected: true, url: "http://localhost:3002/api/inngest/widget-domain" }]);

    const state = await getDomainApp(GEN);

    expect(state.sync?.functionCount).toBe(2); // 3 reported by Inngest − 1 sentinel
  });
});
