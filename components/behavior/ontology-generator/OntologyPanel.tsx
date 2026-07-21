"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { useApp } from "@/lib/i18n";
import { totalElements, type OntologyCounts } from "@/lib/ontology-generator/types";

// Left rail: the domain's ontology by category. Bilingual category labels are
// fixed (the design shows "规则 Rules" verbatim), counts come from the profile.
const ROWS: {
  key: keyof OntologyCounts;
  label: string;
  Icon: (typeof Ic)[keyof typeof Ic];
  color: string;
}[] = [
  { key: "rules", label: "规则 Rules", Icon: Ic.check, color: "oklch(0.7 0.13 75)" },
  { key: "dataObjects", label: "数据对象 Data Objects", Icon: Ic.db, color: "oklch(0.62 0.15 250)" },
  { key: "actions", label: "动作 Actions", Icon: Ic.bolt, color: "oklch(0.62 0.17 285)" },
  { key: "events", label: "事件 Events", Icon: Ic.spark, color: "oklch(0.64 0.15 155)" },
  { key: "workflow", label: "工作流 Workflow", Icon: Ic.branch, color: "oklch(0.6 0.16 285)" },
];

export function OntologyPanel({ counts }: { counts: OntologyCounts }) {
  const { t } = useApp();
  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden h-fit">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <span className="text-[13px] font-semibold text-ink-1">Ontology · 本体</span>
        <span className="text-[10.5px] mono text-ink-3 px-2 py-0.5 rounded border border-line">
          {t("og_elements").replace("{n}", String(totalElements(counts)))}
        </span>
      </div>
      <div className="px-2 py-1.5">
        {ROWS.map(({ key, label, Icon, color }) => (
          <div
            key={key}
            className="flex items-center gap-3 px-2.5 py-3 border-b border-line/60 last:border-b-0"
          >
            <span
              className="flex-none w-8 h-8 rounded-lg grid place-items-center"
              style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}
            >
              <Icon />
            </span>
            <span className="flex-1 text-[13px] text-ink-1">{label}</span>
            <span className="mono text-[16px] font-semibold text-ink-1 tabular-nums">{counts[key]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
