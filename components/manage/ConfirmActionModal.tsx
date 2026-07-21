"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { ClaudeButton } from "@/components/monitor/atoms";

export type ConfirmActionProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
  /** e.g. "cancel" / "pause" / "replay" — required to be typed before submit enables */
  actionKey: string;
  /** Human-readable title shown at top */
  title: string;
  /** Description / impact paragraph */
  description: string;
  /** Tone of the confirm button — affects color */
  tone?: "danger" | "warn" | "neutral";
  /** Whether to require a reason text (default false) */
  requireReason?: boolean;
};

export function ConfirmActionModal({
  open,
  onClose,
  onConfirm,
  actionKey,
  title,
  description,
  tone = "neutral",
  requireReason = false,
}: ConfirmActionProps) {
  const { t } = useApp();
  const [typed, setTyped] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setTyped("");
      setReason("");
      setBusy(false);
      setErr(null);
    }
  }, [open]);

  if (!open) return null;

  const canConfirm =
    typed.trim().toLowerCase() === actionKey.toLowerCase() &&
    (!requireReason || reason.trim().length > 0) &&
    !busy;

  const accentColor =
    tone === "danger"
      ? "var(--c-err)"
      : tone === "warn"
      ? "var(--c-warn)"
      : "var(--c-accent)";

  const handleConfirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(reason);
      onClose();
    } catch (e) {
      setErr((e as Error).message ?? t("manage_confirm_fail"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        background: "color-mix(in oklab, var(--c-bg) 60%, transparent)",
        zIndex: 70,
      }}
      onClick={onClose}
    >
      <div
        className="bg-claude-surface rounded-xl border border-claude-line shadow-2xl"
        style={{ width: 460, maxWidth: "90vw", padding: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 mb-3">
          <div
            className="rounded-full grid place-items-center flex-shrink-0"
            style={{
              width: 36,
              height: 36,
              background: `color-mix(in oklab, ${accentColor} 15%, transparent)`,
              color: accentColor,
            }}
          >
            {/* Warning triangle icon */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold text-claude-ink-1">{title}</div>
            <div className="text-[12.5px] text-claude-ink-2 mt-1.5 leading-relaxed">
              {description}
            </div>
          </div>
        </div>

        {/* Reason field (when required) */}
        {requireReason && (
          <div className="mt-3">
            <label
              className="text-[11px] text-claude-ink-3 uppercase"
              style={{ letterSpacing: "0.05em" }}
            >
              {t("manage_confirm_reason_label")}
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("manage_confirm_reason_placeholder")}
              className="w-full mt-1.5 bg-claude-panel border border-claude-line rounded text-[12.5px] text-claude-ink-1 outline-none focus:border-claude-accent"
              style={{ padding: "6px 10px" }}
              autoFocus
            />
          </div>
        )}

        {/* Type-to-confirm field */}
        <div className="mt-3">
          <label
            className="text-[11px] text-claude-ink-3 uppercase"
            style={{ letterSpacing: "0.05em" }}
          >
            {t("manage_confirm_type_label").replace("{action}", actionKey)}
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={actionKey}
            className="w-full mt-1.5 bg-claude-panel border border-claude-line rounded text-[12.5px] text-claude-ink-1 outline-none focus:border-claude-accent font-mono"
            style={{ padding: "6px 10px" }}
            autoFocus={!requireReason}
          />
        </div>

        {/* Error banner */}
        {err && (
          <div
            className="mt-3 rounded text-[11.5px]"
            style={{
              padding: "6px 10px",
              background: "color-mix(in oklab, var(--c-err) 10%, transparent)",
              border: "1px solid color-mix(in oklab, var(--c-err) 30%, transparent)",
              color: "var(--c-err)",
            }}
          >
            {err}
          </div>
        )}

        {/* Action row */}
        <div className="flex justify-end gap-2 mt-5">
          <ClaudeButton variant="ghost" onClick={onClose} disabled={busy}>
            {t("manage_cancel_btn")}
          </ClaudeButton>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="rounded cursor-pointer disabled:cursor-not-allowed transition-colors"
            style={{
              padding: "6px 14px",
              fontSize: 12.5,
              fontWeight: 500,
              color: "white",
              background: canConfirm ? accentColor : "var(--c-line)",
              border: "none",
            }}
          >
            {busy ? t("manage_confirm_running") : t("manage_confirm_btn")}
          </button>
        </div>
      </div>
    </div>
  );
}
