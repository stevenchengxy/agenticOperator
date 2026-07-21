"use client";
import React from "react";
import { usePathname } from "next/navigation";
import { GlobalChatPanel } from "./GlobalChatPanel";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";

const BUBBLE_SIZE = 56;
const DRAWER_WIDTH = 420;
const DRAWER_HEIGHT = 640;
const DRAWER_OFFSET_BOTTOM = BUBBLE_SIZE + 24 + 16; // bubble + margin + gap

export function GlobalChatBubble() {
  const { t } = useApp();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  if (pathname?.startsWith("/chat")) return null;

  return (
    <>
      {/* Floating button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed cursor-pointer rounded-full"
        style={{
          right: 24,
          bottom: 24,
          width: BUBBLE_SIZE,
          height: BUBBLE_SIZE,
          background: "linear-gradient(135deg, var(--c-accent) 0%, var(--c-accent-2) 100%)",
          color: "white",
          border: "none",
          zIndex: 60,
          display: "grid",
          placeItems: "center",
          boxShadow:
            "0 2px 4px rgba(0,0,0,0.06), 0 12px 28px color-mix(in oklab, var(--c-accent) 40%, transparent), 0 0 0 1px color-mix(in oklab, var(--c-accent) 30%, transparent)",
          transition: "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 220ms ease-out",
          transform: open ? "scale(0.92)" : "scale(1)",
          position: "fixed",
        }}
        title={open ? t("chat_close") : t("chat_open")}
        aria-label={open ? t("chat_close") : t("chat_open")}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.transform = "scale(1.06)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = open ? "scale(0.92)" : "scale(1)"; }}
      >
        {!open && <span className="chat-halo" aria-hidden="true" />}
        <span
          style={{
            display: "grid",
            placeItems: "center",
            transition: "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          {open ? <Ic.cross /> : <Ic.chat />}
        </span>
      </button>

      {/* Drawer */}
      {open && (
        <div
          className="fixed overflow-hidden chat-bubble-in"
          style={{
            right: 24,
            bottom: DRAWER_OFFSET_BOTTOM,
            width: DRAWER_WIDTH,
            height: DRAWER_HEIGHT,
            zIndex: 60,
            background: "var(--c-surface)",
            borderRadius: 16,
            border: "1px solid var(--c-line)",
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08), 0 24px 64px rgba(0,0,0,0.12)",
          }}
        >
          <GlobalChatPanel scope="bubble" onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
