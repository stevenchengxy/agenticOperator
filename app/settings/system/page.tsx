"use client";

import React from "react";
import { Shell } from "@/components/shared/Shell";
import { EnvironmentConfigContent } from "@/components/settings/EnvironmentConfigContent";
import { useApp } from "@/lib/i18n";

export default function SystemSettingsPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_settings"), t("settings_env_title")]}>
      <EnvironmentConfigContent />
    </Shell>
  );
}
