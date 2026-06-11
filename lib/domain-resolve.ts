// Rename-tolerant recruitment domain id resolution.
//
// The recruitment Allmeta domain id is otherwise a hardcoded constant
// (RECRUITMENT_DOMAIN_ID = "招聘-v1"). When it is renamed in Allmeta Studio, the
// ontology-read path 404s and silently falls back to lib/rules.json — with no
// visible signal. This module resolves the *live* recruitment id from the live
// Allmeta domain list using an alias set, so a known rename keeps reading live
// rules, and surfaces a 'missing' status so the rename can be made visible
// (see app/api/domains/route.ts — drift LogEvent + recruitmentAnchor field).
//
// Scope: recruitment only. Energy/cost-control ids bind the Inngest app id and
// the snapshot dir name, so they can't be auto-resolved — they keep the constant.

import { RECRUITMENT_DOMAIN_ID } from "./domain-ids";

/** Known recruitment domain ids, in precedence order. The first one present in
 *  the live Allmeta list wins. The canonical id is always tried first (so an
 *  exact match never resolves to a legacy alias). Extra aliases can be appended
 *  via the comma-separated RECRUITMENT_DOMAIN_ALIASES env var — for surviving a
 *  future rename without a code deploy. */
export const RECRUITMENT_ALIASES: readonly string[] = [
  RECRUITMENT_DOMAIN_ID,
  "RAAS-v1",
  "raas",
];

export type RecruitmentDomainStatus = "exact" | "alias" | "missing";

export interface RecruitmentDomainResolution {
  id: string;
  status: RecruitmentDomainStatus;
}

function aliasList(): string[] {
  const extra = (process.env.RECRUITMENT_DOMAIN_ALIASES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // dedupe while preserving precedence (canonical + defaults first, env extras last)
  return [...new Set([...RECRUITMENT_ALIASES, ...extra])];
}

/** Pick the recruitment domain id out of the live Allmeta domain id list.
 *  - exact:   the canonical id is live → use it
 *  - alias:   the canonical id is absent but a known alias is live → use the alias
 *  - missing: no alias is live → fall back to the canonical constant (drift)
 *  Pure: no I/O, env read only. */
export function resolveRecruitmentDomainId(liveIds: string[]): RecruitmentDomainResolution {
  const live = new Set(liveIds);
  for (const candidate of aliasList()) {
    if (live.has(candidate)) {
      return {
        id: candidate,
        status: candidate === RECRUITMENT_DOMAIN_ID ? "exact" : "alias",
      };
    }
  }
  return { id: RECRUITMENT_DOMAIN_ID, status: "missing" };
}

// ── Cached resolved id (set from the live /api/domains read) ──────────────────
//
// The ontology-read path can't fetch the live domain list on every call, so the
// /api/domains route (which already fetches + caches it) publishes the resolved
// id here. Defaults to the constant until the first successful resolution.

let cachedId: string | null = null;

/** Publish the resolved recruitment id (call from the /api/domains read path).
 *  Pass null to reset to the constant default. */
export function setResolvedRecruitmentDomainId(id: string | null): void {
  cachedId = id;
}

/** The recruitment domain id to use for ontology reads: the last resolved live
 *  id, or the canonical constant if nothing has been resolved yet. */
export function recruitmentDomainId(): string {
  return cachedId ?? RECRUITMENT_DOMAIN_ID;
}

/** Domain id for the recruitment ontology-read path, with the operator escape
 *  hatch: an explicit ALLMETA_DOMAIN env var always wins (hard override), else
 *  the resolved/cached live id. Call this per-request, not at module load, so a
 *  rename picked up by /api/domains takes effect without a restart. */
export function recruitmentReadDomain(): string {
  const override = process.env.ALLMETA_DOMAIN;
  if (override && override.length > 0) return override;
  return recruitmentDomainId();
}
