// HTTP client for the Ontology API's instance + link CRUD endpoints.
// Used by lib/rule-check/graph-context.ts (pre-fetch bundle + tool dispatcher).
//
// Env-driven config:
//   ONTOLOGY_API_BASE — e.g. "http://localhost:3500"
//   ONTOLOGY_API_TOKEN — bearer
//
// All endpoints scope to the RAAS-v1 domain (matches what fetchAction uses).

const DOMAIN = 'RAAS-v1';

function getConfig(): { base: string; token: string } {
  const base = process.env.ONTOLOGY_API_BASE;
  if (!base) {
    throw new Error('ONTOLOGY_API_BASE is not configured');
  }
  const token = process.env.ONTOLOGY_API_TOKEN;
  if (!token) {
    throw new Error('ONTOLOGY_API_TOKEN is not configured');
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
  if (res.status === 404) return null;
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
  return (await res.json()) as Record<string, unknown>;
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
