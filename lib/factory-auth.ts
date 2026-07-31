// Shared guard for /api/factory/* — the agent-factory routes (generate, stream,
// deploy, rename, domains, agent-code) ship ZERO auth otherwise, so anyone who
// can reach the app can deploy/trigger agents.
//
// Design (mirrors server/agent-execution/auth.ts's constant-time compare):
//   FACTORY_ADMIN_TOKEN set         → require x-factory-token header (or
//                                     `authorization: Bearer <t>`, or — for the
//                                     SSE stream only — a ?token= query param,
//                                     since EventSource can't set headers).
//   set but whitespace-only         → MISCONFIG → fail closed (500), never open.
//   unset, NON-production            → dev no-op (allow), warn once.
//   unset, production (or
//     FACTORY_AUTH_REQUIRED=1)       → fail closed (401) — a control plane must
//                                     not silently ship open if the token was
//                                     forgotten in the deployed env.
//
// This is a shared-secret "is this our admin UI" gate (NEXT_PUBLIC_FACTORY_TOKEN
// ships the token to the browser), NOT per-user RBAC. It blocks anonymous
// callers; move to session auth if stronger guarantees are ever needed.

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { isFactoryEnabled } from "@/lib/factory-flag";

let warned = false;

/** 404 when this instance doesn't serve the factory at all (production default).
 *  404 rather than 403: a disabled factory should be indistinguishable from a
 *  build that never had one. */
export function factoryDisabledResponse(): Response | null {
  if (isFactoryEnabled()) return null;
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "agent factory is not enabled on this instance" } }, { status: 404 });
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false; // length isn't secret; avoids a throw
  return timingSafeEqual(ab, bb);
}

function presentedToken(req: Request, allowQuery?: boolean): string | null {
  const x = req.headers.get("x-factory-token");
  if (x && x.trim()) return x.trim();
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  if (allowQuery) {
    const q = new URL(req.url).searchParams.get("token");
    if (q && q.trim()) return q.trim();
  }
  return null;
}

/** Returns a Response (401/500) when the request is unauthorized/misconfigured,
 *  or null to allow. Dev no-op only when the token is genuinely unset AND we're
 *  not in production. */
export function requireFactoryAuth(req: Request, opts: { allowQueryToken?: boolean } = {}): Response | null {
  // Kill switch first: a disabled factory answers 404 before any auth logic.
  const disabled = factoryDisabledResponse();
  if (disabled) return disabled;

  const raw = process.env.FACTORY_ADMIN_TOKEN;
  const configured = raw?.trim();
  if (raw && !configured) {
    // set but whitespace-only = misconfiguration → fail CLOSED, never silently open
    return NextResponse.json({ error: { code: "MISCONFIGURED", message: "FACTORY_ADMIN_TOKEN is empty/whitespace" } }, { status: 500 });
  }
  if (!configured) {
    const mustAuth = process.env.NODE_ENV === "production" || process.env.FACTORY_AUTH_REQUIRED === "1";
    if (mustAuth) {
      return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "FACTORY_ADMIN_TOKEN required (production)" } }, { status: 401 });
    }
    if (!warned) {
      warned = true;
      console.warn(
        "[factory-auth] FACTORY_ADMIN_TOKEN unset — /api/factory/* is UNAUTHENTICATED (dev no-op). Set FACTORY_ADMIN_TOKEN to require a token.",
      );
    }
    return null;
  }
  const tok = presentedToken(req, opts.allowQueryToken);
  if (!tok || !constantTimeEquals(tok, configured)) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid factory token" } }, { status: 401 });
  }
  return null;
}
