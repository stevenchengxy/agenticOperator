import {
  COST_CONTROL_DOMAIN_ID,
  COST_CONTROL_EVENT_NS,
  ENERGY_DOMAIN_ID,
  ENERGY_EVENT_NS,
  RECRUITMENT_DOMAIN_ID,
  isRecruitmentDomain,
} from "../domain-ids";

export type EventDomainLike = {
  name?: string | null;
  data?: unknown;
  domain?: string | null;
  domainId?: string | null;
  domain_id?: string | null;
  sourceApp?: string | null;
  source_app?: string | null;
  appID?: string | null;
  app_id?: string | null;
};

const DOMAIN_KEYS = [
  "domain",
  "domainId",
  "domain_id",
  "allmetaDomain",
  "allmeta_domain",
  "businessDomain",
  "business_domain",
] as const;

const NESTED_KEYS = ["data", "payload", "raw_input_data", "input", "trace"] as const;
const AO_APP_PREFIX = "agentic-operator-";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function normalizeDomain(id: string | null | undefined): string | null {
  if (!id) return null;
  return isRecruitmentDomain(id) ? RECRUITMENT_DOMAIN_ID : id;
}

export function eventDomainFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  if (name.startsWith(`${ENERGY_EVENT_NS}/`)) return ENERGY_DOMAIN_ID;
  if (name.startsWith(`${COST_CONTROL_EVENT_NS}/`)) return COST_CONTROL_DOMAIN_ID;
  return null;
}

export function eventLeafName(name: string | null | undefined): string {
  if (!name) return "";
  const idx = name.lastIndexOf("/");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

export function eventSourceApp(event: EventDomainLike | unknown): string | null {
  const r = asRecord(event);
  if (!r) return null;
  return (
    nonEmptyString(r.sourceApp) ??
    nonEmptyString(r.source_app) ??
    nonEmptyString(r.appID) ??
    nonEmptyString(r.app_id)
  );
}

export function domainFromSourceApp(sourceApp: string | null | undefined): string | null {
  if (!sourceApp?.startsWith(AO_APP_PREFIX)) return null;
  const suffix = sourceApp.slice(AO_APP_PREFIX.length);
  if (!suffix || suffix === "main") return RECRUITMENT_DOMAIN_ID;
  try {
    return decodeURIComponent(suffix);
  } catch {
    return suffix;
  }
}

/**
 * Durable run attribution. New archive rows carry the owning Inngest app id,
 * which is authoritative (`agentic-operator-main` or
 * `agentic-operator-<business-domain>`). The event namespace is the fallback
 * for older rows created before app_id/domain were persisted.
 */
export function inferRunDomain(input: {
  appId?: string | null;
  functionSlug?: string | null;
  eventName?: string | null;
  domainApps?: Array<{ appId: string; domain: string }>;
}): string {
  const fromApp = domainFromSourceApp(input.appId);
  if (fromApp) return fromApp;

  const slug = input.functionSlug ?? "";
  const mappings = [...(input.domainApps ?? [])].sort((a, b) => b.appId.length - a.appId.length);
  for (const row of mappings) {
    if (slug === row.appId || slug.startsWith(`${row.appId}-`)) return normalizeDomain(row.domain) ?? row.domain;
  }
  if (slug.startsWith(`${AO_APP_PREFIX}main-`)) return RECRUITMENT_DOMAIN_ID;

  return eventDomainFromName(input.eventName) ?? RECRUITMENT_DOMAIN_ID;
}

function domainFromPayload(v: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  const r = asRecord(v);
  if (!r) return null;

  for (const key of DOMAIN_KEYS) {
    const found = normalizeDomain(nonEmptyString(r[key]));
    if (found) return found;
  }
  for (const key of NESTED_KEYS) {
    const found = domainFromPayload(r[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function inferEventDomain(event: EventDomainLike): string {
  return (
    domainFromPayload(event) ??
    domainFromPayload(event.data) ??
    eventDomainFromName(event.name) ??
    domainFromSourceApp(eventSourceApp(event)) ??
    RECRUITMENT_DOMAIN_ID
  );
}

export function eventMatchesDomain(event: EventDomainLike, domain: string | null | undefined): boolean {
  const target = normalizeDomain(domain) ?? RECRUITMENT_DOMAIN_ID;
  const actual = normalizeDomain(inferEventDomain(event)) ?? RECRUITMENT_DOMAIN_ID;
  return actual === target;
}
