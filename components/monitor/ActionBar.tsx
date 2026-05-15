"use client";
import React from "react";
import { ClaudeButton } from "./atoms";
import { useApp } from "@/lib/i18n";

const TEST_EVENTS = [
  {
    id: "requirement",
    label: "REQUIREMENT_LOGGED",
    endpoint: "/api/test/trigger-requirement",
  },
  {
    id: "resume",
    label: "RESUME_UPLOADED",
    endpoint: "/api/test/trigger-resume-uploaded",
  },
  {
    id: "match",
    label: "MATCH_REQUESTED",
    endpoint: "/api/test/trigger-match-requested",
  },
];

export function ActionBar({
  paused,
  onTogglePause,
}: {
  paused: boolean;
  onTogglePause: () => void;
}) {
  const { t } = useApp();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [sending, setSending] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  // Close menu on outside click
  const menuRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const sendEvent = async (ep: string, label: string) => {
    setSending(label);
    try {
      const r = await fetch(ep, { method: "POST" });
      setToast(
        r.ok
          ? t("monitor_action_toast_sent").replace("{label}", label)
          : t("monitor_action_toast_failed")
              .replace("{label}", label)
              .replace("{status}", String(r.status)),
      );
    } catch (e) {
      setToast(`${t("monitor_send_event_failed").replace("{message}", label)} — ${(e as Error).message}`);
    } finally {
      setSending(null);
      setMenuOpen(false);
      setTimeout(() => setToast(null), 3500);
    }
  };

  return (
    <div className="flex items-center gap-2 mb-3 flex-wrap relative">
      <ClaudeButton onClick={onTogglePause}>
        <span aria-hidden>{paused ? "▷" : "⏸"}</span>
        {paused ? t("monitor_action_play") : t("monitor_action_pause")}
      </ClaudeButton>

      <div className="relative" ref={menuRef}>
        <ClaudeButton onClick={() => setMenuOpen((o) => !o)}>
          <span aria-hidden>+</span>
          {t("monitor_action_send_test")}
        </ClaudeButton>
        {menuOpen && (
          <div className="absolute top-full left-0 mt-1 z-20 min-w-[220px] rounded-[10px] border border-claude-line bg-claude-surface shadow-sm py-1">
            {TEST_EVENTS.map((e) => (
              <button
                key={e.id}
                type="button"
                disabled={sending === e.label}
                onClick={() => sendEvent(e.endpoint, e.label)}
                className="block w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-claude-panel disabled:opacity-50"
              >
                {e.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <a
        href="http://localhost:8288"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-[8px] border border-claude-line bg-claude-surface text-claude-ink-1 hover:bg-claude-panel px-3 py-1.5 text-[12.5px] no-underline"
      >
        <span aria-hidden>↗</span>
        {t("monitor_action_inngest")}
      </a>

      {toast && (
        <span className="text-[11.5px] text-claude-ink-3 ml-2">{toast}</span>
      )}
    </div>
  );
}
