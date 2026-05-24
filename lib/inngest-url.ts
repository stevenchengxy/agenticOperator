// Single canonical resolver for "where is the Inngest dev / shared server?"
//
// We previously had 4 different env var names for the same thing — partners
// reading the code couldn't tell which to set, and they drifted out of sync:
//   - INNGEST_BASE_URL  ← canonical (matches .env.example)
//   - INNGEST_DEV       ← Inngest SDK auto-discovery alias
//   - INNGEST_LOCAL_URL ← legacy, used by app/api/inngest-events/*
//   - INNGEST_ADMIN_URL ← legacy, used by lib/inngest-admin-client.ts
//
// All callers now go through getInngestUrl() so a single env var (or a
// machine-wide INNGEST_BASE_URL) configures every code path. Legacy names
// still work as fallbacks so existing .env.local files don't break.

const DEFAULT = "http://localhost:8288";

export type InngestUrlSource =
  | 'INNGEST_BASE_URL'
  | 'INNGEST_DEV'
  | 'INNGEST_LOCAL_URL'
  | 'INNGEST_ADMIN_URL'
  | 'default';

/** Returns both the resolved URL and which env var (or "default") supplied it.
 *  Used by /api/system/config + <SystemConfigModal/> so ops can verify env
 *  bindings after deployment changes. */
export function getInngestUrlWithSource(): { url: string; sourceEnv: InngestUrlSource } {
  if (process.env.INNGEST_BASE_URL)  return { url: process.env.INNGEST_BASE_URL,  sourceEnv: 'INNGEST_BASE_URL' };
  if (process.env.INNGEST_DEV)       return { url: process.env.INNGEST_DEV,       sourceEnv: 'INNGEST_DEV' };
  if (process.env.INNGEST_LOCAL_URL) return { url: process.env.INNGEST_LOCAL_URL, sourceEnv: 'INNGEST_LOCAL_URL' };
  if (process.env.INNGEST_ADMIN_URL) return { url: process.env.INNGEST_ADMIN_URL, sourceEnv: 'INNGEST_ADMIN_URL' };
  return { url: DEFAULT, sourceEnv: 'default' };
}

export function getInngestUrl(): string {
  return getInngestUrlWithSource().url;
}

// Cross-system trace lookup (AO's bridge polls the partner's Inngest).
// Falls back to the same URL as the local one for single-shared-Inngest
// deployments where there's no separate "RAAS Inngest" to reach.
export function getRaasInngestUrl(): string {
  return process.env.RAAS_INNGEST_URL ?? getInngestUrl();
}
