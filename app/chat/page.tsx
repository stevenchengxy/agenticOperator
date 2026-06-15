"use client";
import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { GlobalChatFullContent } from "@/components/chat/GlobalChatFullContent";
import { useApp } from "@/lib/i18n";

export default function ChatPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_observe"), t("nav_trace_chat")]} directionTag={t("chat_direction_tag")}>
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={null}>
          <GlobalChatFullContent />
        </Suspense>
      </div>
    </Shell>
  );
}
