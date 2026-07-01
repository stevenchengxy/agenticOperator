"use client";

// Tool Library — a standalone, always-available view of the pre-coded tool
// library the Agent Factory composes from. Domain-scoped (uses the AppBar
// switcher); recruitment shows the 18 hand-coded RoboHire/RAAS/MinIO/Allmeta/LLM
// wrappers, other domains show their declared tools. Read-only: this is the
// human-authored I/O layer — agents SELECT from it, they never synthesize it.

import React from "react";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";

type Tool = {
  name: string;
  family: string;
  title: string;
  description: string;
  sideEffect: string;
  signature: string;
  params: string;
  returns: string;
  requiredEnv: string[];
  idempotent: boolean;
};
type Family = { family: string; items: Tool[] };
type Resp = { domain: string; dryRun: boolean; total: number; families: Family[] };

function SideEffectBadge({ se }: { se: string }) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    read: { label: "读", color: "var(--c-ink-2)", bg: "color-mix(in oklch, var(--c-ink-3) 14%, transparent)" },
    write: { label: "写", color: "var(--c-warn)", bg: "color-mix(in oklch, var(--c-warn) 16%, transparent)" },
    "dual-write": { label: "双写", color: "var(--c-accent)", bg: "var(--c-accent-bg)" },
  };
  const s = map[se] ?? map.read;
  return (
    <span className="text-[10px] font-bold rounded px-1.5 py-0.5 leading-none flex-none" style={{ color: s.color, background: s.bg }}>
      {s.label}
    </span>
  );
}

export function ToolsLibraryContent() {
  const { t } = useApp();
  const { domain, current } = useDomain();
  const [data, setData] = React.useState<Resp | null>(null);
  const [err, setErr] = React.useState(false);

  React.useEffect(() => {
    setData(null);
    setErr(false);
    fetch(`/api/tools?domain=${encodeURIComponent(domain)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<Resp>)
      .then(setData)
      .catch(() => setErr(true));
  }, [domain]);

  return (
    <div className="px-7 py-6 max-w-[1100px] mx-auto">
      {/* header */}
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-[22px] font-semibold text-ink-1">{t("tl_title")}</h1>
          <p className="text-[13px] text-ink-3 mt-1 leading-relaxed max-w-[680px]">{t("tl_sub")}</p>
        </div>
        {data && (
          <div className="flex items-center gap-2 flex-none mt-1">
            <span className="text-[12px] text-ink-2 px-2.5 py-1 rounded-lg border border-line bg-surface">
              {t("tl_count").replace("{n}", String(data.total)).replace("{f}", String(data.families.length))}
            </span>
            {data.dryRun && (
              <span className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--c-warn)", background: "color-mix(in oklch, var(--c-warn) 14%, transparent)" }}>
                {t("tl_dryrun")}
              </span>
            )}
          </div>
        )}
      </div>

      {/* trust-boundary note */}
      <div className="mt-4 rounded-xl border border-line bg-panel/50 px-4 py-3 text-[12.5px] text-ink-2 leading-relaxed">
        {t("tl_note")}
      </div>

      {/* body */}
      {err ? (
        <div className="mt-8 text-[13px] text-ink-3">{t("tl_error")}</div>
      ) : !data ? (
        <div className="mt-8 text-[13px] text-ink-4">…</div>
      ) : data.total === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] text-ink-3">
          {t("tl_empty").replace("{domain}", current?.name ?? domain)}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {data.families.map((fam) => (
            <section key={fam.family}>
              <div className="flex items-center gap-2 mb-2.5">
                <span className="mono text-[13px] font-semibold text-ink-1">{fam.family}</span>
                <span className="text-[11px] text-ink-4 px-1.5 rounded border border-line">{fam.items.length}</span>
              </div>
              <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
                {fam.items.map((tool) => (
                  <div key={tool.name} className="rounded-xl border border-line bg-surface p-3.5">
                    <div className="flex items-center gap-2">
                      <SideEffectBadge se={tool.sideEffect} />
                      <span className="text-[13px] font-semibold text-ink-1 truncate">{tool.title}</span>
                    </div>
                    <div className="mono text-[10.5px] text-ink-4 mt-1 truncate">{tool.name}</div>
                    <p className="text-[12px] text-ink-2 mt-2 leading-relaxed line-clamp-3">{tool.description}</p>
                    <div className="mono text-[10.5px] text-ink-3 mt-2.5 rounded-lg bg-panel/60 border border-line px-2.5 py-1.5 overflow-x-auto whitespace-nowrap">
                      {tool.signature}
                    </div>
                    {tool.requiredEnv.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap mt-2">
                        <span className="text-[10px] text-ink-4">{t("tl_env")}</span>
                        {tool.requiredEnv.map((e) => (
                          <span key={e} className="mono text-[9.5px] px-1.5 py-0.5 rounded border border-line text-ink-3">{e}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
