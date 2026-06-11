import React from "react";
import { AGENT_MAP } from "@/lib/agent-mapping";
import {
  ENERGY_DOMAIN_ID,
  COST_CONTROL_DOMAIN_ID,
  RECRUITMENT_DOMAIN_ID,
} from "@/lib/domain-ids";

// Run → business-domain attribution, shared by /monitor and /overview so both
// scope runs to the active 业务领域 from a single source of truth (extracted
// from MonitorContent 2026-06-08; was duplicated when /overview's 智能体运行
// panel started reading the same /api/inngest-admin/runs feed).
//
// Each runnable pack runs on its OWN Inngest app `agentic-operator-<domainId>`,
// and the function slug is `agentic-operator-<domainId>-<fnId>`. The domainId can
// be CJK (费控-v1 / 能源调度-v1), so the old `^agentic-operator-[a-z0-9-]+?-`
// strip silently failed on it and EVERY domain-app run fell through to the
// recruitment default — i.e. energy/费控 runs showed up under 招聘-v1, not their
// own domain. Match the known domain-app prefixes directly instead.

export const INNGEST_APP_PREFIX = "agentic-operator-main-";
const DOMAIN_APP_IDS = [ENERGY_DOMAIN_ID, COST_CONTROL_DOMAIN_ID];

/** Resolve which business domain a run belongs to, from its Inngest function slug. */
export function runDomainOf(
  run: { function?: { slug?: string } | undefined },
  slugToDomain: Map<string, string>,
): string {
  const slug = run.function?.slug ?? "";
  // 1. Own per-domain app: `agentic-operator-<domainId>-<fnId>` (authoritative
  //    for the hardcoded packs; works regardless of /api/agents availability).
  for (const d of DOMAIN_APP_IDS) {
    if (slug.startsWith(`agentic-operator-${d}-`)) return d;
  }
  // 2. Recruitment main app + the live slug→domain map (deployed shells).
  const fnId = slug.replace(/^agentic-operator-main-/, "");
  const mapped = slugToDomain.get(fnId) ?? slugToDomain.get(slug);
  if (mapped) return mapped;
  // 3. Generic fallback for any other per-domain app: the longest live-map key
  //    the run slug ends with (future packs work without a code change).
  let best = "";
  for (const key of slugToDomain.keys()) {
    if (key && (slug === key || slug.endsWith(`-${key}`)) && key.length > best.length) best = key;
  }
  return best ? (slugToDomain.get(best) ?? RECRUITMENT_DOMAIN_ID) : RECRUITMENT_DOMAIN_ID;
}

/** Fetch /api/agents once → Map<fnId(slug), domain> for run attribution. */
export function useAgentDomainMap(): Map<string, string> {
  const [map, setMap] = React.useState<Map<string, string>>(new Map());
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/agents");
        const body = (await res.json()) as { agents?: Array<{ slug?: string | null; wsId?: string; domain?: string }> };
        if (!alive) return;
        const m = new Map<string, string>();
        for (const a of body.agents ?? []) {
          if (a.domain) {
            if (a.slug) m.set(a.slug, a.domain);
            if (a.wsId) m.set(a.wsId, a.domain);
          }
        }
        setMap(m);
      } catch {
        /* keep prefix-based fallback */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return map;
}

// Match the three fnId conventions kept in sync with lib/inngest-registry.ts:
//   1. explicit `inngestId` on AgentMeta
//   2. stub-factory `agent.<short.toLowerCase()>`
//   3. kebab `<kebab-short>-agent` (real-agent file convention)
function matchesFnId(a: (typeof AGENT_MAP)[number], fnId: string): boolean {
  if (a.inngestId === fnId) return true;
  if (fnId === `agent.${a.short.toLowerCase()}`) return true;
  const kebab = a.short.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
  return fnId === `${kebab}-agent`;
}

export function shortToSlug(short: string): string | null {
  const meta = AGENT_MAP.find((a) => a.short === short);
  if (!meta) return null;
  const fnId = meta.inngestId ?? `agent.${meta.short.toLowerCase()}`;
  return `${INNGEST_APP_PREFIX}${fnId}`;
}

export function slugToShort(slug: string | undefined): string | null {
  if (!slug) return null;
  const fnId = slug.startsWith(INNGEST_APP_PREFIX) ? slug.slice(INNGEST_APP_PREFIX.length) : slug;
  return AGENT_MAP.find((a) => matchesFnId(a, fnId))?.short ?? null;
}
