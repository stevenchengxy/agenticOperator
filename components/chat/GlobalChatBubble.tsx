"use client";
import React from "react";
import { usePathname } from "next/navigation";
import { GlobalChatPanel } from "./GlobalChatPanel";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";

/**
 * Floating chat bubble mounted by Shell on every page EXCEPT /chat
 * (the full-screen page has its own panel — no need for a redundant bubble).
 */
export function GlobalChatBubble() {
  const { t } = useApp();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // Hide on /chat — that route already shows the panel full-screen.
  if (pathname?.startsWith("/chat")) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed cursor-pointer rounded-full shadow-md transition-transform hover:scale-105"
        style={{
          right: 24,
          bottom: 24,
          width: 52,
          height: 52,
          background: "var(--c-accent)",
          color: "var(--c-bg)",
          border: "none",
          // z-60: above modal drawers (z-50) so the chat is reachable while
          // inspecting a run / audit / etc.
          zIndex: 60,
          display: "grid",
          placeItems: "center",
        }}
        title={open ? t("chat_close") : t("chat_open")}
        aria-label={open ? t("chat_close") : t("chat_open")}
      >
        <Ic.chat />
      </button>
      {open && (
        <div
          className="fixed border border-line rounded-md shadow-lg overflow-hidden"
          style={{
            right: 24,
            bottom: 92,
            width: 480,
            height: 620,
            // z-60: above modal drawers (z-50) so the chat is reachable while
            // inspecting a run / audit / etc.
            zIndex: 60,
            background: "var(--c-surface)",
          }}
        >
          <GlobalChatPanel scope="bubble" />
        </div>
      )}
    </>
  );
}
