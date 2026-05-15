// lib/em-bridge.ts
//
// Thin HTTP client that forwards events through AO-main's EM (port 3002).
// This makes RPA emissions auditable in AO-main's EventInstance table.
// When RPA eventually merges into AO-main, this can be replaced with a
// direct em.publish import.
//
// Bridge is enabled by default (RPA_EM_BRIDGE !== '0').
// If AO-main is unreachable the call fails silently — RPA execution never
// blocks on the bridge (5 s timeout, defensive catch).

const AO_MAIN_URL = process.env.AO_MAIN_URL ?? 'http://localhost:3002';
const EM_BRIDGE_ENABLED = process.env.RPA_EM_BRIDGE !== '0'; // default ON

type PublishOpts = {
  source: string;
  externalEventId?: string;
  causedBy?: { eventId: string; name: string };
  traceId?: string;
};

type BridgeResult = {
  accepted: boolean;
  eventId?: string;
  reason?: string;
};

export async function emPublish(
  name: string,
  data: unknown,
  opts: PublishOpts,
): Promise<BridgeResult> {
  if (!EM_BRIDGE_ENABLED) {
    return { accepted: false, reason: 'bridge_disabled' };
  }
  try {
    const res = await fetch(`${AO_MAIN_URL}/api/em/publish-bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, data, ...opts }),
      // Keep timeout short so a stuck AO-main doesn't block RPA forever.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { accepted: false, reason: `bridge_http_${res.status}` };
    return (await res.json()) as BridgeResult;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[em-bridge] publish failed: ${(e as Error).message}`);
    return { accepted: false, reason: 'bridge_error' };
  }
}
