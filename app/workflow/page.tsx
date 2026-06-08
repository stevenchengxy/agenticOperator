"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { WorkflowContent } from "@/components/workflow/WorkflowContent";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";
import { isRecruitmentDomain, friendlyDomainName } from "@/lib/domain-ids";

export default function WorkflowPage() {
  const { t } = useApp();
  const { domain } = useDomain();
  // The 3rd crumb tracks the active business domain (mirrors the canvas
  // sub-header) instead of the hardcoded recruitment pipeline title. Recruitment
  // keeps its named pipeline; every other domain shows "<域> · 工作流".
  const wfCrumb = isRecruitmentDomain(domain)
    ? t("wf_title")
    : `${friendlyDomainName(domain)} · ${t("wfx_workflowWord")}`;
  return (
    <Shell crumbs={[t("nav_group_build"), t("nav_workflows"), wfCrumb]} directionTag={t("dirB") + " · 工作流画布"}>
      <WorkflowContent />
    </Shell>
  );
}
