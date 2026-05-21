"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { useGlobalChat } from "@/lib/chat/use-global-chat";
import { Btn } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";

export function HistoryList() {
  const { t } = useApp();
  const chat = useGlobalChat();

  return (
    <div className="flex flex-col h-full">
      <div
        className="border-b border-line flex items-center justify-between"
        style={{ padding: "10px 12px" }}
      >
        <span className="text-[12px] font-medium text-ink-1">{t("chat_history_title")}</span>
        <Btn size="sm" onClick={chat.newSession} title={t("chat_new_session")}>+</Btn>
      </div>
      <div className="flex-1 overflow-auto">
        {chat.sessions.length === 0 && (
          <div
            className="text-[11px] text-ink-3 text-center"
            style={{ padding: "16px 12px" }}
          >
            {t("chat_history_empty")}
          </div>
        )}
        {chat.sessions.map((s) => (
          <div
            key={s.id}
            className="border-b border-line group hover:bg-surface transition-colors"
          >
            <button
              type="button"
              onClick={() => chat.switchSession(s.id)}
              className="w-full text-left bg-transparent cursor-pointer flex items-start gap-2"
              style={{ padding: "8px 12px" }}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-ink-1 truncate">{s.title}</div>
                <div className="text-[10.5px] text-ink-3 mono">
                  {new Date(s.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(t("chat_history_delete_confirm"))) chat.deleteSession(s.id);
                }}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-ink-4 hover:text-err cursor-pointer bg-transparent border-0 flex-shrink-0 flex items-center"
                title={t("chat_history_delete")}
              >
                <Ic.cross />
              </button>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
