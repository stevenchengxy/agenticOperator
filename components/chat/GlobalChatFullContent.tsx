"use client";
import React from "react";
import { GlobalChatPanel } from "./GlobalChatPanel";
import { HistoryList } from "./HistoryList";

export function GlobalChatFullContent() {
  return (
    <div className="flex-1 flex min-w-0 overflow-hidden">
      <aside
        className="border-r border-line bg-panel overflow-auto"
        style={{ width: 240, flexShrink: 0 }}
      >
        <HistoryList />
      </aside>
      <div className="flex-1 min-w-0">
        <GlobalChatPanel scope="full" />
      </div>
    </div>
  );
}
