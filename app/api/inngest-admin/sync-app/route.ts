// POST /api/inngest-admin/sync-app
//
// Re-syncs the RAAS-v1 main Inngest app by PUTting the AO SDK serve endpoint.
// Current Inngest dev servers reject the old `/fn/register { url }` flow with
// "App ID required"; the SDK endpoint already knows its app id and function
// manifest, so PUT /api/inngest is the stable registration primitive.
//
// Body: { url: string } — the Inngest serve endpoint
//   typical values:
//     - http://localhost:3002/api/inngest               (this AO instance)
//     - http://host.docker.internal:3002/api/inngest    (from Docker)
//     - http://<lan-ip>:<port>/api/inngest              (partner sibling)
//
// Scope guard: this route only accepts the main `/api/inngest` path. Per-domain
// apps (`/api/inngest/<domain>`) must be managed through /api/domains/[id]/inngest-app.

import { NextResponse } from 'next/server';
import { getInngestUrl } from '@/lib/inngest-url';
import {
  RAAS_V1_APP_ID,
  RAAS_V1_EXPECTED_FUNCTION_COUNT,
} from '@/lib/raas-v1-inngest';

export const dynamic = 'force-dynamic';

export type SyncAppResponse =
  | {
      ok: true;
      inngestUrl: string;
      appUrl: string;
      functionsRegistered: number | null;
      expectedFunctions: number;
      raw: unknown;
    }
  | {
      ok: false;
      inngestUrl: string;
      appUrl: string;
      status?: number;
      error: string;
    };

export async function POST(req: Request): Promise<Response> {
  const inngestUrl = getInngestUrl();

  let body: { url?: unknown };
  try {
    body = (await req.json()) as { url?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, inngestUrl, appUrl: '', error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  if (typeof body.url !== 'string' || body.url.trim().length === 0) {
    return NextResponse.json(
      { ok: false, inngestUrl, appUrl: '', error: 'field `url` (string) required' },
      { status: 400 },
    );
  }
  const appUrl = body.url.trim();

  // Basic URL sanity — Inngest will give a clearer error if it can't reach
  // the URL, but catching obvious typos here avoids a confusing 5xx.
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
    if (parsed.pathname.replace(/\/+$/, '') !== '/api/inngest') {
      return NextResponse.json(
        {
          ok: false,
          inngestUrl,
          appUrl,
          error: 'Only the RAAS-v1 main endpoint /api/inngest can be synced here. Use domain app controls for /api/inngest/<domain>.',
        },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { ok: false, inngestUrl, appUrl, error: `Invalid URL: ${appUrl}` },
      { status: 400 },
    );
  }

  if (!isAllowedServeEndpoint(parsed, req)) {
    return NextResponse.json(
      {
        ok: false,
        inngestUrl,
        appUrl,
        error:
          'appUrl host is not allowed in production. Set INNGEST_SERVE_ORIGIN to the AO origin Inngest should call, or use the current deployment origin.',
      },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(appUrl, { method: 'PUT' });
  } catch (e) {
    return NextResponse.json(
      { ok: false, inngestUrl, appUrl, error: `Cannot PUT ${appUrl}: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const rawText = await upstream.text().catch(() => '');
  let raw: unknown = rawText || null;
  if (rawText) {
    try {
      raw = JSON.parse(rawText);
    } catch {
      raw = rawText;
    }
  }

  if (!upstream.ok) {
    const msg =
      raw && typeof raw === 'object' && 'error' in raw
        ? String((raw as { error: unknown }).error)
        : typeof raw === 'string'
          ? raw
          : `HTTP ${upstream.status}`;
    return NextResponse.json(
      { ok: false, inngestUrl, appUrl, status: upstream.status, error: msg },
      { status: 502 },
    );
  }

  const functionsRegistered = await probeMainFunctionCount(inngestUrl);

  return NextResponse.json({
    ok: true,
    inngestUrl,
    appUrl,
    functionsRegistered,
    expectedFunctions: RAAS_V1_EXPECTED_FUNCTION_COUNT,
    raw,
  });
}

function endpointKey(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function allowedEndpointKeys(req: Request): Set<string> {
  const origins = [
    process.env.INNGEST_SERVE_ORIGIN,
    process.env.INNGEST_SERVE_HOST,
    new URL(req.url).origin,
  ];
  const allowed = new Set<string>();
  for (const origin of origins) {
    if (!origin) continue;
    try {
      const url = new URL('/api/inngest', new URL(origin).origin);
      allowed.add(endpointKey(url));
    } catch {
      // Invalid env values are handled by env-check; ignore here so the route
      // can still report a clear allowlist error instead of throwing.
    }
  }
  return allowed;
}

function isAllowedServeEndpoint(appUrl: URL, req: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return allowedEndpointKeys(req).has(endpointKey(appUrl));
}

async function probeMainFunctionCount(inngestUrl: string): Promise<number | null> {
  try {
    const res = await fetch(`${inngestUrl.replace(/\/+$/, '')}/v0/gql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ apps { name functionCount } }' }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { apps?: Array<{ name: string; functionCount: number }> };
    };
    const app = body.data?.apps?.find((a) => a.name === RAAS_V1_APP_ID);
    return typeof app?.functionCount === 'number' ? app.functionCount : null;
  } catch {
    return null;
  }
}
