// POST /api/inngest-admin/sync-app
//
// Registers an Inngest "app" (any URL that serves the inngest SDK handler)
// with the local/shared Inngest dev server. Mirrors what
// scripts/register-with-inngest.ts does but exposes it through the UI.
//
// Body: { url: string } — the Inngest serve endpoint
//   typical values:
//     - http://localhost:3002/api/inngest               (this AO instance)
//     - http://host.docker.internal:3002/api/inngest    (from Docker)
//     - http://<lan-ip>:<port>/api/inngest              (partner sibling)
//
// Mechanism: POSTs `{ url }` to <getInngestUrl()>/fn/register. Inngest
// then reverse-calls PUT <url> to fetch the function manifest and
// registers all `inngest.createFunction(...)` definitions.

import { NextResponse } from 'next/server';
import { getInngestUrl } from '@/lib/inngest-url';

export const dynamic = 'force-dynamic';

export type SyncAppResponse =
  | {
      ok: true;
      inngestUrl: string;
      appUrl: string;
      functionsRegistered: number | null;
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
  try {
    new URL(appUrl);
  } catch {
    return NextResponse.json(
      { ok: false, inngestUrl, appUrl, error: `Invalid URL: ${appUrl}` },
      { status: 400 },
    );
  }

  const registerUrl = `${inngestUrl.replace(/\/+$/, '')}/fn/register`;
  let upstream: Response;
  try {
    upstream = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: appUrl }),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, inngestUrl, appUrl, error: `Cannot reach Inngest at ${registerUrl}: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  // Parse response — Inngest dev returns { ok, modified } typically.
  let raw: unknown = null;
  try {
    raw = await upstream.json();
  } catch {
    raw = await upstream.text().catch(() => null);
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

  // Try to extract function count from raw. Inngest dev typically returns
  // shape { ok: true, modified: <bool> }. The actual fn count must be read
  // back from listFunctions on the next poll — we set null when unknown.
  const functionsRegistered =
    raw && typeof raw === 'object' && 'functions' in raw && Array.isArray((raw as { functions: unknown }).functions)
      ? ((raw as { functions: unknown[] }).functions.length)
      : null;

  return NextResponse.json({
    ok: true,
    inngestUrl,
    appUrl,
    functionsRegistered,
    raw,
  });
}
