"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { useGlobalChat } from "@/lib/chat/use-global-chat";
import type { GlobalChatController } from "@/lib/chat/use-global-chat";
import { Ic } from "@/components/shared/Ic";

export function HistoryList({ chat: chatProp }: { chat?: GlobalChatController }) {
  const { t } = useApp();
  const internalChat = useGlobalChat();
  const chat = chatProp ?? internalChat;

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center justify-between border-b border-line"
        style={{ padding: "14px 14px" }}
      >
        <span className="text-[12.5px] font-semibold text-ink-1">{t("chat_history_title")}</span>
        <button
          type="button"
          onClick={chat.newSession}
          className="flex items-center gap-1 rounded-md cursor-pointer transition-colors"
          style={{
            padding: "5px 9px",
            background: "var(--c-accent)",
            color: "white",
            border: "none",
            fontSize: 11,
          }}
          title={t("chat_new_session")}
        >
          <Ic.plus />
          <span>{t("chat_new_session_short")}</span>
        </button>
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "8px 8px" }}>
        {chat.sessions.length === 0 && (
          <div className="flex flex-col items-center text-center" style={{ padding: "32px 16px" }}>
            <div
              className="rounded-full grid place-items-center"
              style={{
                width: 38,
                height: 38,
                background: "var(--c-accent-bg)",
                color: "var(--c-accent)",
                marginBottom: 10,
              }}
            >
              <Ic.chat />
            </div>
            <div className="text-[11.5px] text-ink-3" style={{ lineHeight: 1.5 }}>
              {t("chat_history_empty")}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1">
          {chat.sessions.map((s) => {
            const active = chat.currentSession.id === s.id;
            return (
              <div
                key={s.id}
                className="group rounded-lg transition-colors cursor-pointer"
                style={{
                  background: active ? "var(--c-accent-bg)" : "transparent",
                  borderLeft: active ? "2.5px solid var(--c-accent)" : "2.5px solid transparent",
                }}
                onClick={() => chat.switchSession(s.id)}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--c-panel)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <div className="flex items-start gap-2" style={{ padding: "9px 10px 9px 8px" }}>
                  <div className="flex-1 min-w-0">
                    <div
                      className={`truncate text-[12.5px] ${active ? "font-semibold text-ink-1" : "text-ink-2"}`}
                    >
                      {s.title}
                    </div>
                    <div className="text-[10.5px] text-ink-4 mono" style={{ marginTop: 1 }}>
                      {formatRelative(s.updatedAt, t)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(t("chat_history_delete_confirm"))) chat.deleteSession(s.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-ink-4 hover:text-err bg-transparent border-0 rounded p-1 flex-shrink-0"
                    title={t("chat_history_delete")}
                    aria-label={t("chat_history_delete")}
                  >
                    <Ic.trash />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatRelative(iso: string, t: (k: string) => string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMin = Math.floor((now - then) / 60_000);
  if (diffMin < 1) return t("chat_time_just_now");
  if (diffMin < 60) return t("chat_time_min_ago").replace("{n}", String(diffMin));
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return t("chat_time_hour_ago").replace("{n}", String(diffH));
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return t("chat_time_day_ago").replace("{n}", String(diffD));
  return new Date(iso).toLocaleDateString();
}
