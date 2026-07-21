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

function BackBar({ returnTo }: { returnTo: string }) {
  const { t } = useApp();
  const router = useRouter();
  return (
    <button
      className="flex items-center gap-1.5 text-ink-3 hover:text-ink-1"
      style={{ padding: "10px 20px 0", fontSize: 12 }}
      onClick={() => router.push(returnTo)}
    >
      <span aria-hidden>←</span>
      {t("rc_back_to_list")}
    </button>
  );
}

export default function Page({
  params,
  searchParams,
}: {
  params: Promise<{ auditId: string }>;
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const { auditId } = use(params);
  const requestedReturnTo = use(searchParams).returnTo;
  const returnTo = typeof requestedReturnTo === "string" &&
    (requestedReturnTo === "/rule-check" || requestedReturnTo.startsWith("/rule-check?"))
    ? requestedReturnTo
    : "/rule-check?view=audits";
  // 面包屑只显示「审计」文字,长 cm_ ID 不再塞进导航(详情头部用可点击 ID 芯片展示)。
  return (
    <Shell crumbs={["Rule Check", "Audit"]}>
      <BackBar returnTo={returnTo} />
      <Suspense fallback={null}>
        <RuleCheckAuditDetailBody auditId={auditId} chrome="page" />
      </Suspense>
    </Shell>
  );
}
