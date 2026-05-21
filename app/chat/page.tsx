"use client";
import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { GlobalChatFullContent } from "@/components/chat/GlobalChatFullContent";
import { useApp } from "@/lib/i18n";

export default function ChatPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_operate"), t("nav_trace_chat")]} directionTag={t("chat_direction_tag")}>
      <Suspense fallback={null}>
        <GlobalChatFullContent />
      </Suspense>
    </Shell>
  );
}
