"use client";
import React from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";
import type {
  InferredAgentCandidate,
  InferResult,
  GeneratedDraft,
  GenerateResult,
  OntologyCounts,
} from "@/lib/ontology-generator/types";
import { StepRail } from "./StepRail";
import { OntologyPanel } from "./OntologyPanel";
import { InferIntro } from "./InferIntro";
import { RunningStage } from "./RunningStage";
import { InferredAgentCard } from "./InferredAgentCard";
import { DeployResult } from "./DeployResult";
import { DomainChip } from "./DomainChip";

type Phase = "idle" | "inferring" | "inferred" | "generating" | "deployed";

const INFER_MIN_MS = 2000;
const GENERATE_MIN_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

// Allmeta domain (from GET /api/ontology-generator/domains). The generator's
// domain selector follows the real Allmeta domain ids — we never invent domains.
type GeneratorDomain = {
  id: string;
  name?: string;
  version?: string;
  runnable: boolean;
};

const EMPTY_COUNTS: OntologyCounts = { rules: 0, dataObjects: 0, actions: 0, events: 0, workflow: 0 };

export function OntologyGeneratorContent() {
  const { t } = useApp();
  const router = useRouter();

  // The generator's domain follows the real Allmeta domain ids (GET
  // /api/ontology-generator/domains), independent of the app-wide switcher — we
  // never invent domains. The app domain is kept only as the initial fallback.
  const { current } = useDomain();

  const [genDomains, setGenDomains] = React.useState<GeneratorDomain[]>([]);
  const [genDomainId, setGenDomainId] = React.useState<string>("");

  const genDomain = genDomains.find((d) => d.id === genDomainId);
  const domainName = genDomain?.name ?? genDomainId ?? current.name;
  const runnable = genDomain?.runnable ?? false;

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [counts, setCounts] = React.useState<OntologyCounts>(EMPTY_COUNTS);
  const [candidates, setCandidates] = React.useState<InferredAgentCandidate[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [drafts, setDrafts] = React.useState<GeneratedDraft[]>([]);

  const currentStep: 0 | 1 | 2 = phase === "generating" ? 1 : phase === "deployed" ? 2 : 0;

  // Load the Allmeta domain list once; default to the first runnable domain
  // (the one AO ships agents for), else the first domain.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/ontology-generator/domains");
        const body = (await r.json()) as { domains?: GeneratorDomain[] };
        const list = body.domains ?? [];
        if (!alive) return;
        setGenDomains(list);
        const def = list.find((d) => d.runnable) ?? list[0];
        if (def) setGenDomainId(def.id);
      } catch {
        // leave empty — selector will be hidden
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Switching the selected domain resets the wizard and reseeds the ontology
  // counts (a quiet infer call so the idle panel shows the real element counts).
  React.useEffect(() => {
    if (!genDomainId) return;
    setPhase("idle");
    setCounts(EMPTY_COUNTS);
    setCandidates([]);
    setSelected(new Set());
    setDrafts([]);
    let alive = true;
    (async () => {
      try {
        const res = await postJson<InferResult>("/api/ontology-generator/infer", {
          domainId: genDomainId,
          domainName,
        });
        if (alive) setCounts(res.counts);
      } catch {
        /* keep zeros */
      }
    })();
    return () => {
      alive = false;
    };
    // domainName is derived from genDomainId + the loaded list; re-run on id only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genDomainId]);

  async function runInfer() {
    setPhase("inferring");
    const [res] = await Promise.all([
      postJson<InferResult>("/api/ontology-generator/infer", { domainId: genDomainId, domainName }),
      sleep(INFER_MIN_MS),
    ]);
    setCounts(res.counts);
    setCandidates(res.candidates);
    setSelected(new Set(res.candidates.map((c) => c.key)));
    setPhase("inferred");
  }

  async function runGenerate() {
    setPhase("generating");
    const keys = [...selected];
    const [res] = await Promise.all([
      postJson<GenerateResult>("/api/ontology-generator/generate", { domainId: genDomainId, domainName, selectedKeys: keys }),
      sleep(GENERATE_MIN_MS),
    ]);
    setDrafts(res.drafts);
    setPhase("deployed");
  }

  async function runChainOnce() {
    return postJson<{ ok: boolean; caseId?: string; error?: string }>(
      "/api/ontology-generator/run",
      { domainId: genDomainId },
    );
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function buildAnother() {
    setPhase("idle");
    setCandidates([]);
    setSelected(new Set());
    setDrafts([]);
  }

  const selectedCount = selected.size;

  return (
    <div className="px-6 lg:px-8 py-6 max-w-[1280px] w-full mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[11px] tracking-[0.18em] uppercase text-ink-4 font-semibold">
            Ontology Generator
          </div>
          <h1 className="mt-1.5 text-[30px] font-bold text-ink-1 leading-tight">{t("og_title")}</h1>
          <p className="mt-2 text-[13px] text-ink-3 leading-relaxed max-w-[640px]">
            {t("og_subtitle").replace("{domain}", domainName)}
          </p>
        </div>
        <div className="flex-none pt-1 flex flex-col items-end gap-2">
          <DomainChip />
          {genDomains.length > 0 && (
            <label className="flex items-center gap-2 text-[12px] text-ink-3">
              <span className="text-ink-4">本体域</span>
              <select
                value={genDomainId}
                onChange={(e) => setGenDomainId(e.target.value)}
                className="h-8 rounded-md border border-line bg-surface px-2 text-[12.5px] text-ink-1"
              >
                {genDomains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {(d.name ? `${d.name} · ` : "") + d.id}
                    {d.runnable ? " ●" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {/* Stepper */}
      <StepRail current={currentStep} />

      {/* Body by phase */}
      {phase === "idle" && (
        <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(320px, 360px) 1fr" }}>
          <OntologyPanel counts={counts} />
          <InferIntro onInfer={runInfer} />
        </div>
      )}

      {phase === "inferring" && (
        <RunningStage
          title={t("og_inferring_title")}
          subtitle={t("og_inferring_sub")
            .replace("{domain}", domainName)
            .replace("{n}", String(counts.rules + counts.dataObjects + counts.actions + counts.events + counts.workflow))}
          ticker={t("og_inferring_ticker")}
        />
      )}

      {phase === "inferred" && (
        <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(320px, 360px) 1fr" }}>
          <OntologyPanel counts={counts} />
          <div className="rounded-2xl border border-line bg-bg/40 p-5">
            {/* Results header */}
            <div className="flex items-center gap-3">
              <span className="text-[color:var(--c-accent)]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
                  <circle cx="12" cy="12" r="3.2" />
                </svg>
              </span>
              <h2 className="text-[15px] font-semibold text-ink-1">
                {t("og_inferred_count").replace("{n}", String(candidates.length))}
              </h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ background: "var(--c-accent-bg)", color: "var(--c-accent)" }}>
                {t("og_selected").replace("{n}", String(selectedCount))}
              </span>
              <button
                type="button"
                onClick={runInfer}
                className="ml-auto inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] bg-surface border border-line text-ink-2 hover:bg-panel transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
                {t("og_reinfer")}
              </button>
            </div>

            {/* Candidate cards */}
            <div className="mt-4 flex flex-col gap-3.5">
              {candidates.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line text-center text-[12.5px] text-ink-4 px-4 py-10">
                  {t("og_inferred_empty").replace("{domain}", domainName)}
                </div>
              ) : (
                candidates.map((c, i) => (
                  <InferredAgentCard
                    key={c.key}
                    candidate={c}
                    index={i}
                    selected={selected.has(c.key)}
                    onToggle={() => toggle(c.key)}
                  />
                ))
              )}
            </div>

            {/* Footer */}
            <div className="mt-5 pt-4 border-t border-line flex items-center justify-between gap-4">
              <p className="text-[12px] text-ink-4">{t("og_generate_hint")}</p>
              <button
                type="button"
                onClick={runGenerate}
                disabled={selectedCount === 0}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-lg text-[13px] font-semibold text-white transition-opacity disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
                style={{ background: "var(--c-accent)", boxShadow: "0 6px 22px color-mix(in oklab, var(--c-accent) 35%, transparent)" }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
                </svg>
                {t("og_generate_cta").replace("{n}", String(selectedCount))}
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === "generating" && (
        <RunningStage
          title={t("og_generating_title").replace("{n}", String(selectedCount))}
          subtitle={t("og_generating_sub")}
          ticker={t("og_generating_ticker")}
        />
      )}

      {phase === "deployed" && (
        <DeployResult
          drafts={drafts}
          domainName={domainName}
          onAgain={buildAnother}
          onToFleet={() => router.push("/fleet?drafts=open")}
          runnable={runnable}
          onRun={runnable ? runChainOnce : undefined}
        />
      )}
    </div>
  );
}
