"use client";

import React, { Suspense, use } from "react";
import { useRouter } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { RuleCheckAuditDetailBody } from "@/components/rule-check/RuleCheckAuditDetailDrawer";
import { useApp } from "@/lib/i18n";

// Fullscreen rule-check audit detail.
// Replaces the right-side drawer per user request — opening an audit now
// navigates to a dedicated route (back button / browser history work as
// expected, URL is shareable, audit detail can use full viewport).

function BackBar() {
  const { t } = useApp();
  const router = useRouter();
  return (
    <button
      className="flex items-center gap-1.5 text-ink-3 hover:text-ink-1"
      style={{ padding: "10px 20px 0", fontSize: 12 }}
      onClick={() => router.push("/rule-check")}
    >
      <span aria-hidden>←</span>
      {t("rc_back_to_list")}
    </button>
  );
}

export default function Page({ params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = use(params);
  // 面包屑只显示「审计」文字,长 cm_ ID 不再塞进导航(详情头部用可点击 ID 芯片展示)。
  return (
    <Shell crumbs={["Rule Check", "Audit"]}>
      <BackBar />
      <Suspense fallback={null}>
        <RuleCheckAuditDetailBody auditId={auditId} chrome="page" />
      </Suspense>
    </Shell>
  );
}
