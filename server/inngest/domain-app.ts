// Per-domain Inngest app.
//
// Each business domain can register its own Inngest app (id
// `agentic-operator-<domain>`) served at the dynamic route /api/inngest/<domain>.
// Ontology-generated agents that are DEPLOYED (AgentVersion status='active') in
// that domain become live stub functions on this app — they actually run:
// trigger on the agent's triggerEvent, simulate work, emit the emitEvent.
//
// This is fully separate from the real production app (agentic-operator-main):
// distinct app id, distinct serve route, og- function slugs — so registering or
// offlining a domain app can never affect the real 5 agents.

import { Inngest } from "inngest";
import { serve } from "inngest/next";
import { prisma } from "@/server/db";
import { ensureWorkflowRun, markRunComplete, createAgentLogger } from "@/server/agent-logger";
import { getInngestUrl } from "@/lib/inngest-url";
import { ONTOLOGY_GEN_SOURCE } from "@/lib/ontology-generator/draft-store";
import type { ShellCardData } from "@/lib/ontology-generator/types";

// The `raas` (业务领域) domain is ALREADY served by the main app
// (agentic-operator-main, /api/inngest) which hosts the 5 real production
// agents. It must never get its own per-domain app.
const MAIN_DOMAIN = "RAAS-v1";
const MAIN_APP_ID = "agentic-operator-main";

function domainAppId(domain: string): string {
  return `agentic-operator-${domain}`;
}

function domainServePath(domain: string): string {
  return `/api/inngest/${encodeURIComponent(domain)}`;
}

function parseCard(configJson: string | null): ShellCardData | null {
  if (!configJson) return null;
  try {
    return JSON.parse(configJson) as ShellCardData;
  } catch {
    return null;
  }
}

// ── functions ──────────────────────────────────────────────────────────────

type ShellRow = { short: string; slug: string; configJson: string | null };

function makeShellFunction(client: Inngest, domain: string, shell: ShellRow, card: ShellCardData) {
  return client.createFunction(
    {
      id: shell.slug, // og-… → full slug agentic-operator-<domain>-og-…
      name: card.nameZh || card.agentId || shell.short,
      triggers: [{ event: card.triggerEvent }],
    },
    async ({ event, step }: { event: { id?: string; name: string; data?: unknown }; step: any }) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const runId =
        (typeof data._runId === "string" && data._runId) ||
        (typeof event.id === "string" && event.id) ||
        `${shell.slug}-${event.name}`;

      await step.run("ensure-run", () =>
        ensureWorkflowRun({
          runId,
          triggerEvent: event.name,
          triggerData: { agent: shell.short, domain, event: event.name },
        }),
      );

      const log = createAgentLogger({ agent: shell.short, nodeId: shell.slug, runId });
      await step.run("log-receive", async () => {
        await log.event("event_received", `Received ${event.name}`, { eventId: event.id });
        await log.log("agent_start", `${shell.short} started`, {});
      });

      await step.sleep("work", "600ms");

      if (card.emitEvent && card.emitEvent !== "—") {
        await step.sendEvent("emit", {
          name: card.emitEvent,
          data: { _runId: runId, source: shell.short, _shell: true },
        });
      }

      await step.run("done", async () => {
        await log.done(`${shell.short} done`, { emitted: card.emitEvent });
        await markRunComplete(runId, "completed");
      });
      return { runId, emitted: card.emitEvent };
    },
  );
}

/** Build the live stub functions for a domain from its DEPLOYED shells. */
async function buildDomainFunctions(client: Inngest, domain: string) {
  // raas is served by agentic-operator-main, not a per-domain app.
  if (domain === MAIN_DOMAIN) return [];
  const app = await prisma.domainInngestApp.findUnique({ where: { domain } });
  // Offline (or never registered) → serve zero functions.
  if (!app || app.status !== "online") return [];

  const shells = await prisma.agentVersion.findMany({
    where: { capturedFrom: ONTOLOGY_GEN_SOURCE, domain, status: "active" },
    orderBy: { createdAt: "desc" },
    select: { short: true, slug: true, configJson: true },
  });

  // Dedupe by slug (a domain may have re-deployed the same agent) — keep latest.
  const bySlug = new Map<string, ShellRow>();
  for (const s of shells) if (!bySlug.has(s.slug)) bySlug.set(s.slug, s);

  const fns = [];
  for (const shell of bySlug.values()) {
    const card = parseCard(shell.configJson);
    if (!card?.triggerEvent || card.triggerEvent === "—") continue;
    fns.push(makeShellFunction(client, domain, shell, card));
  }
  return fns;
}

// ── serve handler ────────────────────────────────────────────────────────────

// Cache the Inngest client per domain (stable config); rebuild functions from
// the DB on every request so deploy/offline take effect without a stale cache.
const clientCache = new Map<string, Inngest>();
function getDomainClient(domain: string): Inngest {
  let c = clientCache.get(domain);
  if (!c) {
    c = new Inngest({ id: domainAppId(domain), eventKey: process.env.INNGEST_EVENT_KEY });
    clientCache.set(domain, c);
  }
  return c;
}

export async function getDomainServeHandler(domain: string): Promise<ReturnType<typeof serve>> {
  const client = getDomainClient(domain);
  const functions = await buildDomainFunctions(client, domain);
  // Explicit servePath so Inngest registers this app at /api/inngest/<domain>
  // (not the auto-detected /api/inngest, which would collide with the main app).
  return serve({ client, functions, servePath: domainServePath(domain) });
}

// ── registration ─────────────────────────────────────────────────────────────

/** Origin the Inngest dev server can reach the AO app at. Derived from the
 *  already-working main app registration (host.docker.internal in Docker), so
 *  per-domain apps reuse the exact reachable host. Falls back to env / default. */
async function resolveCallbackOrigin(): Promise<string> {
  try {
    const res = await fetch(`${getInngestUrl()}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ apps { name url } }" }),
    });
    const body = (await res.json()) as { data?: { apps?: Array<{ name: string; url: string }> } };
    const main = body.data?.apps?.find((a) => a.name === "agentic-operator-main");
    if (main?.url) return new URL(main.url).origin;
  } catch {
    /* fall through */
  }
  const host = process.env.AO_LAN_IP ?? "host.docker.internal";
  const port = process.env.AO_PORT ?? "3002";
  return `http://${host}:${port}`;
}

async function callbackUrlFor(domain: string): Promise<string> {
  return `${await resolveCallbackOrigin()}${domainServePath(domain)}`;
}

async function postRegister(callbackUrl: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`${getInngestUrl()}/fn/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: callbackUrl }),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

export type DomainAppState = {
  domain: string;
  appId: string;
  status: "online" | "offline";
  /** true when the domain is served by the main app (raas) — not its own app. */
  boundToMain: boolean;
  callbackUrl: string | null;
  registeredAt: string | null;
};

export async function getDomainApp(domain: string): Promise<DomainAppState> {
  if (domain === MAIN_DOMAIN) {
    // Bound to the existing main app — always online, never a separate app.
    return {
      domain,
      appId: MAIN_APP_ID,
      status: "online",
      boundToMain: true,
      callbackUrl: `${await resolveCallbackOrigin()}/api/inngest`,
      registeredAt: null,
    };
  }
  const row = await prisma.domainInngestApp.findUnique({ where: { domain } });
  return {
    domain,
    appId: domainAppId(domain),
    status: (row?.status as "online" | "offline") ?? "offline",
    boundToMain: false,
    callbackUrl: row?.callbackUrl ?? null,
    registeredAt: row?.registeredAt ? row.registeredAt.toISOString() : null,
  };
}

/** Register (or re-register) the domain's Inngest app. */
export async function registerDomainApp(domain: string): Promise<{ ok: boolean; error?: string; callbackUrl: string }> {
  if (domain === MAIN_DOMAIN) {
    // raas is already the main app — registering a separate one is wrong.
    return { ok: true, callbackUrl: `${await resolveCallbackOrigin()}/api/inngest` };
  }
  const callbackUrl = await callbackUrlFor(domain);
  await prisma.domainInngestApp.upsert({
    where: { domain },
    create: { domain, appId: domainAppId(domain), status: "online", callbackUrl, registeredAt: new Date() },
    update: { status: "online", callbackUrl, registeredAt: new Date() },
  });
  try {
    const r = await postRegister(callbackUrl);
    if (!r.ok) return { ok: false, error: `Inngest /fn/register ${r.status}: ${r.body}`, callbackUrl };
    return { ok: true, callbackUrl };
  } catch (e) {
    return { ok: false, error: (e as Error).message, callbackUrl };
  }
}

/** Take the domain's app offline: serve zero functions + re-sync so Inngest
 *  drops them. The app row stays (status=offline) so it can be re-registered. */
export async function offlineDomainApp(domain: string): Promise<{ ok: boolean; error?: string }> {
  if (domain === MAIN_DOMAIN) {
    return { ok: false, error: "raas is bound to agentic-operator-main and cannot be taken offline" };
  }
  const existing = await prisma.domainInngestApp.findUnique({ where: { domain } });
  const callbackUrl = existing?.callbackUrl ?? (await callbackUrlFor(domain));
  await prisma.domainInngestApp.upsert({
    where: { domain },
    create: { domain, appId: domainAppId(domain), status: "offline", callbackUrl },
    update: { status: "offline" },
  });
  // Re-sync: Inngest re-introspects the callback, which now serves 0 functions.
  try {
    await postRegister(callbackUrl);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Re-sync the domain app after a shell deploy/offline so Inngest picks up the
 *  changed function set. No-op if the domain app isn't registered. */
export async function resyncDomainApp(domain: string): Promise<void> {
  const app = await prisma.domainInngestApp.findUnique({ where: { domain } });
  if (!app || app.status !== "online") return;
  const callbackUrl = app.callbackUrl ?? (await callbackUrlFor(domain));
  try {
    await postRegister(callbackUrl);
  } catch {
    /* best-effort */
  }
}
