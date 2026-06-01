"use client";

import React from "react";
import { useApp } from "@/lib/i18n";
import { useDomain, useDomainMutations, type Domain } from "@/lib/domains";

export function ManageDomainsModal({ onClose }: { onClose: () => void }) {
  const { t } = useApp();
  const { all } = useDomain();
  const { rename, archive } = useDomainMutations();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function onRename(d: Domain) {
    if (busy) return;
    const trimmed = editName.trim();
    if (!trimmed || trimmed === d.name) {
      setEditing(null);
      return;
    }
    setBusy(d.id);
    setError(null);
    const res = await rename(d.id, trimmed);
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? res.reason);
      return;
    }
    setEditing(null);
  }

  async function onArchive(d: Domain) {
    if (busy || d.is_system) return;
    const ok = window.confirm(
      t("domain_manage_archive_confirm").replace("{name}", d.name),
    );
    if (!ok) return;
    setBusy(d.id);
    setError(null);
    const res = await archive(d.id);
    setBusy(null);
    if (!res.ok) {
      if (res.reason === "has_agents") {
        setError(
          t("domain_manage_archive_has_agents").replace(
            "{count}",
            String(res.count),
          ),
        );
      } else {
        setError(res.error ?? res.reason);
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "color-mix(in oklab, var(--c-bg) 60%, transparent)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-line rounded-md shadow-sh-3 flex flex-col"
        style={{ width: "min(540px, 92vw)", padding: "18px 20px", gap: 14 }}
      >
        <div className="text-[14px] font-semibold text-ink-1">
          {t("domain_manage_title")}
        </div>

        {error && (
          <div
            className="text-[12px] rounded-sm"
            style={{
              padding: "8px 10px",
              background: "var(--c-err-bg)",
              color: "var(--c-err)",
              border: "1px solid color-mix(in oklab, var(--c-err) 35%, var(--c-line))",
            }}
          >
            {error}
          </div>
        )}

        <div className="flex flex-col">
          {all.map((d) => {
            const isEditing = editing === d.id;
            const isBusy = busy === d.id;
            return (
              <div
                key={d.id}
                className="flex items-center gap-3 border-b border-line"
                style={{ padding: "10px 4px" }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: d.color,
                    flex: "none",
                  }}
                />
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onRename(d);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      autoFocus
                      disabled={isBusy}
                      className="w-full border border-line rounded-sm bg-bg text-ink-1 text-[13px]"
                      style={{ padding: "4px 8px" }}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-ink-1 truncate">
                        {d.name}
                      </span>
                      {d.is_system && (
                        <span
                          className="mono text-[10px] rounded-sm"
                          style={{
                            padding: "1px 6px",
                            background: "var(--c-panel)",
                            color: "var(--c-ink-3)",
                            border: "1px solid var(--c-line)",
                          }}
                        >
                          {t("domain_manage_system_badge")}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="mono text-[10.5px] text-ink-3 truncate">
                    {d.id}
                  </div>
                </div>
                {isEditing ? (
                  <>
                    <button
                      onClick={() => onRename(d)}
                      disabled={isBusy}
                      className="text-[11.5px] rounded-sm cursor-pointer"
                      style={{
                        padding: "4px 10px",
                        background: "var(--c-accent)",
                        color: "var(--c-bg)",
                        border: "1px solid var(--c-accent)",
                      }}
                    >
                      {t("domain_manage_save")}
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      disabled={isBusy}
                      className="text-[11.5px] border border-line rounded-sm bg-panel text-ink-2 cursor-pointer"
                      style={{ padding: "4px 10px" }}
                    >
                      {t("domain_new_cancel")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setEditing(d.id);
                        setEditName(d.name);
                        setError(null);
                      }}
                      disabled={isBusy}
                      className="text-[11.5px] border border-line rounded-sm bg-panel text-ink-2 cursor-pointer hover:border-line-strong"
                      style={{ padding: "4px 10px" }}
                    >
                      {t("domain_manage_rename")}
                    </button>
                    <button
                      onClick={() => onArchive(d)}
                      disabled={isBusy || d.is_system}
                      title={
                        d.is_system
                          ? t("domain_manage_archive_system_tip")
                          : undefined
                      }
                      className="text-[11.5px] border rounded-sm cursor-pointer"
                      style={{
                        padding: "4px 10px",
                        background: d.is_system ? "var(--c-panel)" : "var(--c-err-bg)",
                        color: d.is_system ? "var(--c-ink-4)" : "var(--c-err)",
                        borderColor: d.is_system
                          ? "var(--c-line)"
                          : "color-mix(in oklab, var(--c-err) 35%, var(--c-line))",
                        opacity: d.is_system ? 0.6 : 1,
                        cursor: d.is_system ? "not-allowed" : "pointer",
                      }}
                    >
                      {t("domain_manage_archive")}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end mt-1">
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] border border-line rounded-sm bg-panel text-ink-2 cursor-pointer hover:border-line-strong"
            style={{ padding: "6px 14px" }}
          >
            {t("domain_manage_close")}
          </button>
        </div>
      </div>
    </div>
  );
}
