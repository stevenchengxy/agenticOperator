// HTTP client for the Ontology API's instance + link CRUD endpoints.
// Used by lib/rule-check/graph-context.ts (pre-fetch bundle + tool dispatcher).
//
// Env-driven config:
//   ALLMETA_BASE_URL — e.g. "http://localhost:3500"
//   ALLMETA_API_KEY  — bearer
//   ALLMETA_DOMAIN   — ontology domain (default "RAAS-v1"); must match the
//                       value lib/allmeta-client.ts uses, otherwise rule-check
//                       reads from a different ontology than agents write to.

import { getInstanceFallback, hasInstanceFallback } from './pg-fallback';

const DOMAIN = process.env.ALLMETA_DOMAIN ?? 'RAAS-v1';

function getConfig(): { base: string; token: string } {
  const base = process.env.ALLMETA_BASE_URL;
  if (!base) {
    throw new Error('ALLMETA_BASE_URL is not configured');
  }
  const token = process.env.ALLMETA_API_KEY;
  if (!token) {
    throw new Error('ALLMETA_API_KEY is not configured');
  }
  return { base: base.replace(/\/+$/, ''), token };
}

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function encodeFilters(filters: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(filters)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

/**
 * Fetch a single ontology instance by label + primary key.
 * Returns null on 404. Throws on 401 / 5xx / network errors.
 */
export async function getInstance(
  label: string,
  value: string,
): Promise<Record<string, unknown> | null> {
  const { base, token } = getConfig();
  const url = `${base}/api/v1/ontology/instances/${encodeURIComponent(
    label,
  )}/${encodeURIComponent(value)}?domain=${DOMAIN}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return instanceFallback(label, value);
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(
      `Ontology API getInstance(${label}, ${value}) -> ${res.status}. Body: ${body}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown> | null;
  // Neo4j returned 200 but an empty/null body → still a miss, try pg.
  if (!json || (typeof json === 'object' && Object.keys(json).length === 0)) {
    return instanceFallback(label, value);
  }
  return json;
}

/** Neo4j miss → partner-pg fallback (only for registered, field-compatible
 *  entities). Logs every hit/miss so silent store divergence is visible. */
async function instanceFallback(
  label: string,
  value: string,
): Promise<Record<string, unknown> | null> {
  if (!hasInstanceFallback(label)) return null;
  const row = await getInstanceFallback(label, value);
  // eslint-disable-next-line no-console
  console.warn(
    `[instance-client] Neo4j miss ${label}/${value} → partner-pg fallback ${row ? 'HIT' : 'MISS'}`,
  );
  return row;
}

/**
 * List ontology instances of a label, filtered by property equality.
 * Returns [] on 404. Throws on 401 / 5xx / network errors.
 */
export async function listInstances(
  label: string,
  filters: Record<string, string> = {},
): Promise<Array<Record<string, unknown>>> {
  const { base, token } = getConfig();
  const qs = encodeFilters(filters);
  const url =
    `${base}/api/v1/ontology/instances/${encodeURIComponent(label)}` +
    `?domain=${DOMAIN}${qs ? `&${qs}` : ''}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return [];
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(
      `Ontology API listInstances(${label}) -> ${res.status}. Body: ${body}`,
    );
  }
  const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return Array.isArray(json.items) ? json.items : [];
}

/**
 * List ontology links. Filters are passed as query params (from / to / type).
 * Returns [] on 404.
 */
export async function listLinks(
  filters: { from?: string; to?: string; type?: string } = {},
): Promise<Array<Record<string, unknown>>> {
  const { base, token } = getConfig();
  const out: Record<string, string> = {};
  if (filters.from) out.from = filters.from;
  if (filters.to) out.to = filters.to;
  if (filters.type) out.type = filters.type;
  const qs = encodeFilters(out);
  const url =
    `${base}/api/v1/ontology/links` +
    `?domain=${DOMAIN}${qs ? `&${qs}` : ''}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return [];
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(
      `Ontology API listLinks(${JSON.stringify(filters)}) -> ${res.status}. Body: ${body}`,
    );
  }
  const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return Array.isArray(json.items) ? json.items : [];
}
