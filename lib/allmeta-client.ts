// Allmeta Ontology API HTTP client (v0_1_010)
//
// Single entry for AO to write/read instance data through Allmeta studio (:3500).
// Allmeta is the only path to Neo4j instance data (per ADR-0011 + alignment doc §1).

import { currentLogger } from '@/lib/agent-logger';

const DEFAULT_BASE_URL = process.env.ALLMETA_BASE_URL ?? 'http://localhost:3500';
const DEFAULT_DOMAIN = process.env.ALLMETA_DOMAIN ?? 'RAAS-v1';
const API_KEY = process.env.ALLMETA_API_KEY ?? '';

// Label = first 2 URL segments, e.g. "allmeta.POST /api/v1/ontology/instances".
function callLabel(method: string, path: string): string {
  const trimmed = path.split('?')[0];
  const segs = trimmed.split('/').filter(Boolean);
  // /api/v1/ontology/{resource}/{id?} — group by /{resource}, drop {id}
  const groupedPath = segs.slice(0, 4).join('/');
  return `allmeta.${method} /${groupedPath}`;
}

export type AllmetaError = {
  status: number;
  error: string;
  details?: Record<string, unknown>;
  body?: unknown;
};

export class AllmetaApiError extends Error {
  status: number;
  details?: Record<string, unknown>;
  body?: unknown;

  constructor(payload: AllmetaError) {
    super(`Allmeta ${payload.status} ${payload.error}`);
    this.name = 'AllmetaApiError';
    this.status = payload.status;
    this.details = payload.details;
    this.body = payload.body;
  }
}

type CommonOpts = {
  baseUrl?: string;
  domain?: string;
  timeoutMs?: number;
  validateStrict?: boolean;
};

async function doRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: CommonOpts = {},
): Promise<T> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const logger = currentLogger();
  const label = callLabel(method, path);
  const start = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Network / abort error — nothing to parse, but still emit a log line so
    // the agent file shows "we tried, it never connected".
    logger?.apiCall(label, {
      url,
      method,
      request: body,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text();
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = rawText;
  }

  logger?.apiCall(label, {
    url,
    method,
    request: body,
    status: res.status,
    durationMs: Date.now() - start,
    response: parsed,
    ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
  });

  if (!res.ok) {
    const errObj = (parsed as Record<string, unknown>) ?? {};
    throw new AllmetaApiError({
      status: res.status,
      error: typeof errObj.error === 'string' ? (errObj.error as string) : res.statusText,
      details: errObj.details as Record<string, unknown> | undefined,
      body: parsed,
    });
  }

  return parsed as T;
}

// ──────────────────────────────────────────────────────────────
//  Instance CRUD
// ──────────────────────────────────────────────────────────────

export type WriteInstanceResponse = {
  upserted?: string[];
  count?: number;
  [k: string]: unknown;
};

/**
 * POST /api/v1/ontology/instances/{label}?domain=RAAS-v1
 *
 * `payload` must already match the DataObject's `properties[]` exactly — extra
 * fields trigger 400 validation-failed (this is what alignment doc §1.2 is about).
 */
export async function writeInstance(
  label: string,
  payload: Record<string, unknown>,
  opts: CommonOpts = {},
): Promise<WriteInstanceResponse> {
  const domain = opts.domain ?? DEFAULT_DOMAIN;
  const strict = opts.validateStrict ? '&validate=strict' : '';
  const path = `/api/v1/ontology/instances/${encodeURIComponent(label)}?domain=${encodeURIComponent(domain)}${strict}`;
  return doRequest<WriteInstanceResponse>(
    'POST',
    path,
    { ...payload, domainId: domain },
    opts,
  );
}

export async function getInstance<T = Record<string, unknown>>(
  label: string,
  pk: string,
  opts: CommonOpts = {},
): Promise<T | null> {
  const domain = opts.domain ?? DEFAULT_DOMAIN;
  const path = `/api/v1/ontology/instances/${encodeURIComponent(label)}/${encodeURIComponent(pk)}?domain=${encodeURIComponent(domain)}`;
  try {
    return await doRequest<T>('GET', path, undefined, opts);
  } catch (err) {
    if (err instanceof AllmetaApiError && err.status === 404) return null;
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────
//  Link (relationship) CRUD
// ──────────────────────────────────────────────────────────────

export type WriteLinkInput = {
  source_label: string;
  source_id: string;
  target_label: string;
  target_id: string;
  relationship: string; // e.g. "HAS_RESUME" / "EVALUATED_FOR"
};

export async function writeLink(
  link: WriteLinkInput,
  opts: CommonOpts = {},
): Promise<{ created?: boolean; [k: string]: unknown }> {
  const domain = opts.domain ?? DEFAULT_DOMAIN;
  return doRequest('POST', `/api/v1/ontology/links?domain=${encodeURIComponent(domain)}`, {
    domainId: domain,
    ...link,
  }, opts);
}

// ──────────────────────────────────────────────────────────────
//  DataObject schema introspection (sanity check)
// ──────────────────────────────────────────────────────────────

export async function getDataObjectSchema(
  label: string,
  opts: CommonOpts = {},
): Promise<{ properties?: Array<{ name: string; type: string }>; [k: string]: unknown }> {
  const path = `/api/v1/ontology/dataobjects/${encodeURIComponent(label)}`;
  return doRequest('GET', path, undefined, opts);
}

// ──────────────────────────────────────────────────────────────
//  Health
// ──────────────────────────────────────────────────────────────

export async function ping(opts: CommonOpts = {}): Promise<{ ok: boolean }> {
  try {
    await doRequest('GET', '/health', undefined, opts);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
