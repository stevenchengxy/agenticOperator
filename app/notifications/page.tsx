"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { NotificationsContent } from "@/components/notifications/NotificationsContent";
import { useApp } from "@/lib/i18n";

export default function NotificationsPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_operate"), t("ntf_title")]} directionTag={t("ntf_title") + " · Notifications"}>
      <NotificationsContent />
    </Shell>
  );
}
