"use client";

// Domain container — top-level scope for AO. Inspired by AllmetaOntology's
// "domain" concept: switching domains rescopes Fleet, Codegen (Phase 1+),
// and per-domain tool/event registries.
//
// All 22 current agents belong to 'raas'. 'r7' is provisioned for future
// onboarding — see docs/superpowers/specs/2026-05-25-ao-domain-codegen-compiler-design.md.

import React from "react";

export type DomainId = "raas" | "r7";

export type Domain = {
  id: DomainId;
  /** Short label per locale; AppBar switcher renders these. */
  label: { zh: string; en: string };
  /** Accent color (OKLCH) used by the switcher pill. */
  color: string;
};

export const DOMAINS: ReadonlyArray<Domain> = [
  {
    id: "raas",
    label: { zh: "RAAS · 招聘中台", en: "RAAS · Recruitment" },
    color: "oklch(0.65 0.18 250)",
  },
  {
    id: "r7",
    label: { zh: "R7 · ATS", en: "R7 · ATS" },
    color: "oklch(0.65 0.18 145)",
  },
];

export const DEFAULT_DOMAIN: DomainId = "raas";

const STORAGE_KEY = "ao:domain";

export function isDomainId(value: unknown): value is DomainId {
  return typeof value === "string" && DOMAINS.some((d) => d.id === value);
}

export function getDomain(id: DomainId): Domain {
  // DOMAINS is the source of truth; id is type-narrowed by isDomainId on the
  // way in. Falling back to DEFAULT_DOMAIN keeps this total even if a DomainId
  // is widened later without a matching DOMAINS entry.
  return DOMAINS.find((d) => d.id === id) ?? DOMAINS.find((d) => d.id === DEFAULT_DOMAIN)!;
}

type Ctx = {
  domain: DomainId;
  setDomain: (d: DomainId) => void;
  all: ReadonlyArray<Domain>;
};

const DomainContext = React.createContext<Ctx>({
  domain: DEFAULT_DOMAIN,
  setDomain: () => {},
  all: DOMAINS,
});

export function DomainProvider({ children }: { children: React.ReactNode }) {
  const [domain, setDomainState] = React.useState<DomainId>(DEFAULT_DOMAIN);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isDomainId(stored)) setDomainState(stored);
  }, []);

  React.useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, domain);
  }, [domain]);

  const setDomain = React.useCallback((d: DomainId) => setDomainState(d), []);

  const value = React.useMemo(() => ({ domain, setDomain, all: DOMAINS }), [domain, setDomain]);

  return <DomainContext.Provider value={value}>{children}</DomainContext.Provider>;
}

export function useDomain(): Ctx {
  return React.useContext(DomainContext);
}
