"use client";

// Domain container — top-level scope for AO. Inspired by AllmetaOntology's
// "domain" concept: switching domains rescopes Fleet (already), Overview
// (added in Phase 0), Codegen (Phase 1+), and per-domain tool/event
// registries (Phase 1 chore).
//
// Phase 0 (2026-06-01) — see docs/superpowers/specs/2026-06-01-domain-foundation-design.md:
//   - Domains become data-driven (GET /api/domains, lazily seeded with raas + r7).
//   - `DomainId` widens from "raas" | "r7" literal union to plain `string`.
//   - Provider fetches the active list on mount; falls back to the two seeded
//     system rows during the brief pre-fetch window so child components don't
//     flash an empty list.
//   - useDomainMutations() wraps POST/PATCH/DELETE; success → context reload.

import React from "react";
import { fetchJson } from "@/lib/api/client";
import type {
  DomainCreateResponse,
  DomainListResponse,
  DomainRow,
} from "@/app/api/domains/route";
import type {
  DomainDeleteResponse,
  DomainPatchResponse,
} from "@/app/api/domains/[id]/route";

/** Slug type — opaque string identifier matching `Domain.id`. */
export type DomainId = string;

export type Domain = {
  id: DomainId;
  /** Display name (single string; user-created domains don't carry zh/en split). */
  name: string;
  /** Accent color (OKLCH literal) used by the AppBar switcher + Fleet badges. */
  color: string;
  is_system: boolean;
  created_at: string;
  archived_at: string | null;
};

export const DEFAULT_DOMAIN: DomainId = "raas";

/** Pre-fetch fallback. Mirrors the API's SEED_DOMAINS so the chrome renders
 *  sensibly while `GET /api/domains` is in flight, and so SSR / tests that
 *  don't hit the network still see the two system domains. */
export const SYSTEM_FALLBACK_DOMAINS: ReadonlyArray<Domain> = [
  {
    id: "raas",
    name: "RAAS · 招聘中台",
    color: "oklch(0.65 0.18 250)",
    is_system: true,
    created_at: new Date(0).toISOString(),
    archived_at: null,
  },
  {
    id: "r7",
    name: "R7 · ATS",
    color: "oklch(0.65 0.18 145)",
    is_system: true,
    created_at: new Date(0).toISOString(),
    archived_at: null,
  },
];

const STORAGE_KEY = "ao:domain";

/** Now just "is a non-empty string" — runtime list of valid ids is dynamic and
 *  lives in the provider. Callers needing strict membership should consult
 *  `useDomain().all`. Kept for backwards-compat with the static call sites. */
export function isDomainId(value: unknown): value is DomainId {
  return typeof value === "string" && value.length > 0;
}

/** Legacy synchronous lookup against the static fallback. Returns the matching
 *  fallback row, or the raas fallback row. For accurate runtime lookups inside
 *  React trees, prefer `useDomain().getById(id)` / `useDomain().current`. */
export function getDomain(id: DomainId): Domain {
  return (
    SYSTEM_FALLBACK_DOMAINS.find((d) => d.id === id) ??
    SYSTEM_FALLBACK_DOMAINS.find((d) => d.id === DEFAULT_DOMAIN)!
  );
}

type Ctx = {
  /** Active domain id. */
  domain: DomainId;
  /** Switch the active domain. Silent no-op if `id` isn't in `all`. */
  setDomain: (id: DomainId) => void;
  /** Active (non-archived) domains, fetched from `/api/domains`. Falls back to
   *  `SYSTEM_FALLBACK_DOMAINS` during pre-fetch / when the API is down. */
  all: ReadonlyArray<Domain>;
  /** Full meta for the active id. Always defined (falls back to first system). */
  current: Domain;
  /** Lookup by id from `all`. Undefined if not found / archived. */
  getById: (id: DomainId) => Domain | undefined;
  /** Re-fetch the list. Called by mutations on success. */
  reload: () => Promise<void>;
  /** True while the initial fetch is in flight. */
  loading: boolean;
};

const DomainContext = React.createContext<Ctx>({
  domain: DEFAULT_DOMAIN,
  setDomain: () => {},
  all: SYSTEM_FALLBACK_DOMAINS,
  current: SYSTEM_FALLBACK_DOMAINS[0]!,
  getById: () => undefined,
  reload: async () => {},
  loading: true,
});

export function DomainProvider({ children }: { children: React.ReactNode }) {
  const [domain, setDomainState] = React.useState<DomainId>(DEFAULT_DOMAIN);
  const [all, setAll] = React.useState<ReadonlyArray<Domain>>(
    SYSTEM_FALLBACK_DOMAINS,
  );
  const [loading, setLoading] = React.useState(true);

  const reload = React.useCallback(async () => {
    try {
      const res = await fetchJson<DomainListResponse>("/api/domains");
      if (res.ok) {
        setAll(res.domains);
      }
      // On error keep the existing list — never blank out the chrome.
    } finally {
      setLoading(false);
    }
  }, []);

  // Hydrate stored domain id from localStorage and kick off the first fetch.
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isDomainId(stored)) setDomainState(stored);
    }
    void reload();
  }, [reload]);

  // After `all` updates, validate the active domain id. If the stored slug
  // isn't in the active list anymore (archived from another tab, deleted
  // since last visit), silently fall back to the first system domain — no
  // toast, no warning. Keeps the chrome calm.
  React.useEffect(() => {
    if (loading) return;
    if (!all.find((d) => d.id === domain)) {
      const fallback =
        all.find((d) => d.is_system) ?? all[0] ?? SYSTEM_FALLBACK_DOMAINS[0]!;
      setDomainState(fallback.id);
    }
  }, [all, domain, loading]);

  React.useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, domain);
  }, [domain]);

  const setDomain = React.useCallback(
    (id: DomainId) => {
      // Validate against the current list — typo-protect against stale call sites.
      if (all.find((d) => d.id === id)) {
        setDomainState(id);
      }
    },
    [all],
  );

  const getById = React.useCallback(
    (id: DomainId) => all.find((d) => d.id === id),
    [all],
  );

  const current = React.useMemo(
    () =>
      all.find((d) => d.id === domain) ??
      all.find((d) => d.is_system) ??
      SYSTEM_FALLBACK_DOMAINS[0]!,
    [all, domain],
  );

  const value = React.useMemo<Ctx>(
    () => ({ domain, setDomain, all, current, getById, reload, loading }),
    [domain, setDomain, all, current, getById, reload, loading],
  );

  return <DomainContext.Provider value={value}>{children}</DomainContext.Provider>;
}

export function useDomain(): Ctx {
  return React.useContext(DomainContext);
}

// ───────────────────────────────────────────────────────────────────────────
// Mutations — POST / PATCH / DELETE wrappers. On success reload() the context.
// ───────────────────────────────────────────────────────────────────────────

export type CreateResult =
  | { ok: true; domain: Domain }
  | { ok: false; reason: "slug_collision"; existing_id: string; existing_name: string }
  | { ok: false; reason: "invalid_name"; error: string }
  | { ok: false; reason: "error"; error: string };

export type RenameResult =
  | { ok: true; domain: Domain }
  | { ok: false; reason: "not_found" | "invalid_body" | "error"; error?: string };

export type ArchiveResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "is_system" | "error"; error?: string }
  | { ok: false; reason: "has_agents"; count: number };

/** Hook returning mutation callbacks. Each callback hits the API and, on
 *  success, triggers a reload of the provider's list. */
export function useDomainMutations() {
  const { reload, setDomain } = useDomain();

  const create = React.useCallback(
    async (input: { name: string; color?: string }): Promise<CreateResult> => {
      try {
        const res = await fetchJson<DomainCreateResponse>("/api/domains", {
          method: "POST",
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          if (res.reason === "slug_collision") {
            return {
              ok: false,
              reason: "slug_collision",
              existing_id: res.existing_id,
              existing_name: res.existing_name,
            };
          }
          if (res.reason === "invalid_name") {
            return { ok: false, reason: "invalid_name", error: res.error };
          }
          return { ok: false, reason: "error", error: res.error ?? "unknown error" };
        }
        await reload();
        // Auto-switch to the freshly-created domain — per spec §6, the user's
        // intent on "新建领域" is to start working in it.
        setDomain(res.domain.id);
        return { ok: true, domain: res.domain as Domain };
      } catch (e) {
        return { ok: false, reason: "error", error: (e as Error).message };
      }
    },
    [reload, setDomain],
  );

  const rename = React.useCallback(
    async (id: DomainId, name: string): Promise<RenameResult> => {
      try {
        const res = await fetchJson<DomainPatchResponse>(
          `/api/domains/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ name }),
            headers: { "Content-Type": "application/json" },
          },
        );
        if (!res.ok) {
          return {
            ok: false,
            reason: res.reason,
            error: res.reason === "invalid_body" ? res.error : undefined,
          };
        }
        await reload();
        return { ok: true, domain: res.domain as Domain };
      } catch (e) {
        return { ok: false, reason: "error", error: (e as Error).message };
      }
    },
    [reload],
  );

  const recolor = React.useCallback(
    async (id: DomainId, color: string): Promise<RenameResult> => {
      try {
        const res = await fetchJson<DomainPatchResponse>(
          `/api/domains/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ color }),
            headers: { "Content-Type": "application/json" },
          },
        );
        if (!res.ok) {
          return {
            ok: false,
            reason: res.reason,
            error: res.reason === "invalid_body" ? res.error : undefined,
          };
        }
        await reload();
        return { ok: true, domain: res.domain as Domain };
      } catch (e) {
        return { ok: false, reason: "error", error: (e as Error).message };
      }
    },
    [reload],
  );

  const archive = React.useCallback(
    async (id: DomainId): Promise<ArchiveResult> => {
      try {
        const res = await fetchJson<DomainDeleteResponse>(
          `/api/domains/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          if (res.reason === "has_agents") {
            return { ok: false, reason: "has_agents", count: res.count };
          }
          return {
            ok: false,
            reason: res.reason,
            error: (res as { error?: string }).error,
          };
        }
        await reload();
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "error", error: (e as Error).message };
      }
    },
    [reload],
  );

  return { create, rename, recolor, archive };
}

// Re-export for backwards-compat with code that imported `DOMAINS` as the
// static list. Treat this as "the seeded baseline" — runtime should use
// useDomain().all instead.
export const DOMAINS = SYSTEM_FALLBACK_DOMAINS;
