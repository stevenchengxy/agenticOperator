"use client";

import React from "react";
import clsx from "clsx";

export function HelpTip({
  tip,
  className,
  placement = "bottom",
}: {
  tip: React.ReactNode;
  className?: string;
  placement?: "top" | "bottom";
}) {
  if (!tip) return null;
  return (
    <span className={clsx("relative inline-flex group", className)}>
      <span
        aria-label="Help"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-[11px] font-semibold text-ink-3 group-hover:text-ink-1 group-hover:bg-panel"
      >
        ?
      </span>
      <span
        role="tooltip"
        className={clsx(
          "pointer-events-none absolute left-1/2 z-40 hidden w-[min(280px,70vw)] -translate-x-1/2 rounded-md border border-line bg-surface px-3 py-2 text-left text-[11.5px] leading-relaxed text-ink-2 shadow-sh-2 group-hover:block group-focus-within:block",
          placement === "top" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
        )}
      >
        {tip}
      </span>
    </span>
  );
}
