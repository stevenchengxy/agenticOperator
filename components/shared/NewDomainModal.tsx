"use client";

import React from "react";
import clsx from "clsx";
import { useApp } from "@/lib/i18n";
import { useDomainMutations } from "@/lib/domains";

const COLOR_PALETTE = [
  "oklch(0.65 0.18 30)",   // amber
  "oklch(0.65 0.18 320)",  // magenta
  "oklch(0.65 0.18 195)",  // teal
  "oklch(0.55 0.16 285)",  // violet
  "oklch(0.65 0.18 250)",  // blue
  "oklch(0.65 0.18 145)",  // green
];

export function NewDomainModal({ onClose }: { onClose: () => void }) {
  const { t } = useApp();
  const { create } = useDomainMutations();
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("domain_new_err_empty"));
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await create({
      name: trimmed,
      color: color ?? undefined,
    });
    setSubmitting(false);
    if (res.ok) {
      onClose();
      return;
    }
    if (res.reason === "slug_collision") {
      setError(
        t("domain_new_err_collision").replace("{name}", res.existing_name || res.existing_id),
      );
    } else if (res.reason === "invalid_name") {
      setError(t("domain_new_err_invalid"));
    } else {
      setError(t("domain_new_err_generic").replace("{error}", res.error ?? ""));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "color-mix(in oklab, var(--c-bg) 60%, transparent)" }}
      onClick={onClose}
    >
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-line rounded-md shadow-sh-3 flex flex-col"
        style={{ width: "min(420px, 92vw)", padding: "18px 20px", gap: 14 }}
      >
        <div className="text-[14px] font-semibold text-ink-1">
          {t("domain_new_title")}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="hint">{t("domain_new_name_label")}</span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            placeholder={t("domain_new_name_placeholder")}
            disabled={submitting}
            className="border border-line rounded-sm bg-bg text-ink-1 text-[13px]"
            style={{ padding: "8px 10px" }}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="hint">{t("domain_new_color_label")}</span>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setColor(null)}
              className={clsx(
                "border rounded-sm text-[11px] cursor-pointer",
                color === null
                  ? "border-[color:var(--c-accent)] bg-accent-bg text-[color:var(--c-accent)]"
                  : "border-line bg-panel text-ink-2",
              )}
              style={{ padding: "4px 10px" }}
            >
              {t("domain_new_color_auto")}
            </button>
            {COLOR_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                title={c}
                className={clsx(
                  "rounded-full cursor-pointer border-2",
                  color === c ? "border-ink-1" : "border-transparent",
                )}
                style={{
                  width: 20,
                  height: 20,
                  background: c,
                }}
                aria-label={c}
              />
            ))}
          </div>
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

        <div className="flex items-center justify-end gap-2 mt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-[12px] border border-line rounded-sm bg-panel text-ink-2 cursor-pointer hover:border-line-strong"
            style={{ padding: "6px 14px" }}
          >
            {t("domain_new_cancel")}
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="text-[12px] rounded-sm cursor-pointer"
            style={{
              padding: "6px 16px",
              background: "var(--c-accent)",
              color: "var(--c-bg)",
              border: "1px solid var(--c-accent)",
              opacity: submitting || !name.trim() ? 0.5 : 1,
            }}
          >
            {submitting ? "…" : t("domain_new_submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
