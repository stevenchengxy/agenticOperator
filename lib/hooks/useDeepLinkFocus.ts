"use client";

import React from "react";

// Scroll a deep-linked record into view, draw a temporary ring around it and
// replay the animation whenever the focus key changes. Records opt in with
// `data-focus-key="run:..." | "event:..." | "infra:..."`.
export function useDeepLinkFocus(focusKey: string | null, ready = true): void {
  React.useEffect(() => {
    if (!focusKey || !ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      const nodes = document.querySelectorAll<HTMLElement>("[data-focus-key]");
      const target = [...nodes].find((node) => node.dataset.focusKey === focusKey);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      target.classList.remove("ao-record-focus");
      // Force a style flush so navigating between two notifications pointing at
      // the same row still replays the ring animation.
      void target.offsetWidth;
      target.classList.add("ao-record-focus");
      timer = setTimeout(() => target.classList.remove("ao-record-focus"), 3200);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [focusKey, ready]);
}

