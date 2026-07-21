// Client-side Inngest URL resolver.
//
// Server code reads INNGEST_BASE_URL directly (see lib/inngest-url.ts). Client
// code can't — Next.js only exposes env vars prefixed with NEXT_PUBLIC_* to the
// browser bundle. For "open Inngest dashboard" links and dev-only direct
// fetches from React components, set NEXT_PUBLIC_INNGEST_URL in .env.local
// (typically to the same value as INNGEST_BASE_URL).
//
// If NEXT_PUBLIC_INNGEST_URL is unset, falls back to localhost:8288 — fine for
// solo dev on the same machine, wrong for partner LAN deploys. Setup script
// warns about this mismatch.

const DEFAULT = "http://localhost:8288";

export function getInngestUrlClient(): string {
  return process.env.NEXT_PUBLIC_INNGEST_URL ?? DEFAULT;
}
