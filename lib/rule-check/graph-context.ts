// Pre-fetch bundle + in-memory cache + tool dispatcher.
//
// Called once at the start of runRuleCheck() to populate a "graph context"
// that the LLM can reference inline (candidate.name etc.). The same cache
// also backs the tool-use loop: when the LLM calls get_instance / list_instances
// / list_links, the dispatcher checks the cache first and only hits the API
// for a miss.

import { getInstance, listInstances, listLinks } from './instance-client';

export interface GraphContext {
  candidate: Record<string, unknown> | null;
  job_requisition: Record<string, unknown> | null;
  applications: Array<Record<string, unknown>>;
  blacklist_hits: Array<Record<string, unknown>>;
  employment_links: Array<Record<string, unknown>>;
  fetch_count: number;
  /** Internal cache; do not depend on its shape. */
  _cache: Map<string, unknown>;
}

export type ToolDispatcher = (name: string, args: unknown) => Promise<unknown>;

function instKey(label: string, value: string): string {
  return `inst:${label}:${value}`;
}

function listInstKey(label: string, filters: Record<string, string>): string {
  const sorted = Object.keys(filters).sort().map((k) => `${k}=${filters[k]}`).join('&');
  return `list-inst:${label}:${sorted}`;
}

function listLinksKey(filters: { from?: string; to?: string; type?: string }): string {
  return `list-links:from=${filters.from ?? ''}|to=${filters.to ?? ''}|type=${filters.type ?? ''}`;
}

export async function buildGraphContext(args: {
  candidate_id: string;
  job_requisition_id: string;
}): Promise<GraphContext> {
  const cache = new Map<string, unknown>();
  const counters = { n: 0 };

  const tryGet = async (label: string, value: string) => {
    counters.n += 1;
    const v = await getInstance(label, value);
    if (v) cache.set(instKey(label, value), v);
    return v;
  };
  const tryList = async (label: string, filters: Record<string, string>) => {
    counters.n += 1;
    const v = await listInstances(label, filters);
    cache.set(listInstKey(label, filters), v);
    return v;
  };
  const tryLinks = async (filters: { from?: string; to?: string; type?: string }) => {
    counters.n += 1;
    const v = await listLinks(filters);
    cache.set(listLinksKey(filters), v);
    return v;
  };

  const [candidate, job_requisition, applications, blacklist_hits, employment_links] =
    await Promise.all([
      tryGet('Candidate', args.candidate_id),
      tryGet('Job_Requisition', args.job_requisition_id),
      tryList('Application', { candidate_id: args.candidate_id }),
      tryList('Blacklist', { candidate_id: args.candidate_id }),
      tryLinks({ from: args.candidate_id, type: 'EMPLOYED_BY' }),
    ]);

  return {
    candidate,
    job_requisition,
    applications,
    blacklist_hits,
    employment_links,
    fetch_count: counters.n,
    _cache: cache,
  };
}

export function createDispatcher(ctx: GraphContext): ToolDispatcher {
  return async (name: string, args: unknown): Promise<unknown> => {
    try {
      if (name === 'get_instance') {
        const { label, value } = args as { label: string; value: string };
        const key = instKey(label, value);
        if (ctx._cache.has(key)) return ctx._cache.get(key);
        const v = await getInstance(label, value);
        if (v) ctx._cache.set(key, v);
        ctx.fetch_count += 1;
        return v;
      }
      if (name === 'list_instances') {
        const { label, filters = {} } = args as {
          label: string;
          filters?: Record<string, string>;
        };
        const key = listInstKey(label, filters);
        if (ctx._cache.has(key)) return ctx._cache.get(key);
        const v = await listInstances(label, filters);
        ctx._cache.set(key, v);
        ctx.fetch_count += 1;
        return v;
      }
      if (name === 'list_links') {
        const filters = args as { from?: string; to?: string; type?: string };
        const key = listLinksKey(filters);
        if (ctx._cache.has(key)) return ctx._cache.get(key);
        const v = await listLinks(filters);
        ctx._cache.set(key, v);
        ctx.fetch_count += 1;
        return v;
      }
      throw new Error(`unknown tool: ${name}`);
    } catch (err) {
      // Re-throw "unknown tool" so the loop can fail loudly; for HTTP errors
      // return an `{ error }` envelope so the LLM can record insufficient_info.
      if ((err as Error).message?.startsWith('unknown tool')) throw err;
      return { error: (err as Error).message };
    }
  };
}
