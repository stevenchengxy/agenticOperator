"use client";
import React from "react";
import clsx from "clsx";

// Atoms scoped to [data-style="claude"] subtree.
//
// They look at the currently inherited Claude tokens via CSS vars, so
// they automatically follow dark mode via the [data-theme="dark"] block
// in globals.css. No theme-aware JS needed.

export function ClaudeCard({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        "rounded-[12px] border border-claude-line bg-claude-surface p-6",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function ClaudeMetric({
  label,
  value,
  hint,
  onClick,
  emphasis = "normal",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  onClick?: () => void;
  emphasis?: "normal" | "ok" | "warn" | "err";
}) {
  const tone =
    emphasis === "ok" ? "text-claude-ok"
    : emphasis === "warn" ? "text-claude-warn"
    : emphasis === "err" ? "text-claude-err"
    : "text-claude-ink-1";
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "text-left rounded-[10px] px-5 py-4 transition-colors",
        onClick ? "cursor-pointer hover:bg-claude-panel" : "cursor-default",
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 mb-1">{label}</div>
      <div className={clsx("text-[24px] font-medium tabular-nums leading-tight", tone)}>
        {value}
      </div>
      {hint != null && <div className="text-[12px] text-claude-ink-3 mt-1">{hint}</div>}
    </button>
  );
}

export function ClaudeBadge({
  children,
  tone = "neutral",
  size = "sm",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ok" | "warn" | "err" | "accent";
  size?: "xs" | "sm";
}) {
  const toneCls =
    tone === "ok"     ? "bg-claude-ok/15 text-claude-ok"
    : tone === "warn" ? "bg-claude-warn/15 text-claude-warn"
    : tone === "err"  ? "bg-claude-err/15 text-claude-err"
    : tone === "accent" ? "bg-claude-accent-bg text-claude-accent"
    : "bg-claude-panel text-claude-ink-2";
  const sizeCls = size === "xs"
    ? "text-[10px] px-1.5 py-0.5"
    : "text-[11px] px-2 py-0.5";
  return (
    <span className={clsx("inline-flex items-center rounded-full font-medium tabular-nums", toneCls, sizeCls)}>
      {children}
    </span>
  );
}

export function ClaudeChip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition-colors",
        active
          ? "bg-claude-accent-bg text-claude-accent border-claude-accent/30"
          : "border-claude-line text-claude-ink-2 hover:bg-claude-panel",
      )}
    >
      {children}
    </button>
  );
}

export function ClaudeButton({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  const v =
    variant === "primary"
      ? "bg-claude-accent text-white hover:opacity-90"
      : variant === "ghost"
      ? "text-claude-ink-2 hover:bg-claude-panel"
      : "border border-claude-line bg-claude-surface text-claude-ink-1 hover:bg-claude-panel";
  const s = size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[12.5px]";
  return (
    <button
      {...rest}
      className={clsx("rounded-[8px] inline-flex items-center gap-1.5 transition-colors", v, s, className)}
    />
  );
}

export function ClaudeSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[14px] font-medium text-claude-ink-2 mb-3 mt-0">
      {children}
    </h2>
  );
}
