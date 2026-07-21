"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import type { RuleCheckAuditDetail } from "@/app/api/rule-check-audits/[auditId]/route";

export function pickStr(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim();
}

/**
 * 候选人画像 + 岗位画像 — 把 parsed_resume_full / job_requisition_full 关键字段抠出来
 * 一目了然显示"这是谁,跟岗位匹不匹"。被审计详情的 LLM 响应 tab 与规则筛选 tab 共用。
 */
export function CandidateProfileCard({ detail }: { detail: RuleCheckAuditDetail }) {
  const { t } = useApp();
  const r = (detail.parsed_resume_full ?? {}) as Record<string, unknown>;
  const j = (detail.job_requisition_full ?? {}) as Record<string, unknown>;

  // 从 parsed_resume 抠候选人画像
  const name = pickStr(r.name);
  const gender = pickStr(r.gender);
  const marital = pickStr(r.marital_status);
  const nationality = pickStr(r.nationality);
  const address = pickStr(r.address);
  const phone = pickStr(r.phone);
  const expectedSalary = pickStr(r.expected_salary_range);

  // education
  const edu = Array.isArray(r.education) ? (r.education as Array<Record<string, unknown>>) : [];
  const edu0 = edu[0] ?? {};
  const degree = pickStr(edu0.degree);
  const school = pickStr(edu0.institution);
  const major = pickStr(edu0.field);
  const eduStart = pickStr(edu0.startDate);
  const eduEnd = pickStr(edu0.endDate);

  // experience
  const exp = Array.isArray(r.experience) ? (r.experience as Array<Record<string, unknown>>) : [];
  const totalYears = exp.length > 0 ? `${exp.length} (${exp.slice(0, 3).map((e) => `${pickStr(e.company) || '?'}/${pickStr(e.role) || pickStr(e.title) || '?'}`).join(' / ')})` : null;

  // JR 画像
  const jrTitle = pickStr(j.client_job_title);
  const jrDept = pickStr(j.first_level_department);
  const jrCity = pickStr(j.work_city) || pickStr(j.city);
  const jrSalary = pickStr(j.salary_range);
  const jrDegreeReq = pickStr(j.degree_requirement) || pickStr(j.education_requirement);

  // 归属:客户 × 事业群 × 部门 × 工作室。部门优先取 JR specification.sd_org_name
  // (可读名如「腾讯互娱事业部」),否则退回 first_level_department。
  const spec = (j.specification ?? {}) as Record<string, unknown>;
  const deptDisplay = pickStr(spec.sd_org_name) || jrDept;

  if (!detail.parsed_resume_full && !detail.job_requisition_full) {
    return null;
  }

  // 同一审计上下文 —— 候选人画像 & 岗位画像都标注这条归属。
  const scopeLine = (
    <div
      className="text-ink-3 flex flex-wrap items-center"
      style={{ fontSize: 11, marginTop: 7, gap: "2px 10px", lineHeight: 1.5 }}
    >
      <span className="min-w-0 break-all">
        <span className="hint">{t("rc_attr_client")}</span> {detail.client_display_name || detail.client_name || "?"}
      </span>
      {detail.business_group ? (
        <span>
          <span className="hint">{t("rc_attr_bg")}</span> {detail.business_group}
        </span>
      ) : null}
      {deptDisplay ? (
        <span>
          <span className="hint">{t("rc_attr_dept")}</span> {deptDisplay}
        </span>
      ) : null}
      {detail.studio ? (
        <span>
          <span className="hint">{t("rc_attr_studio")}</span> {detail.studio}
        </span>
      ) : null}
    </div>
  );

  return (
    <div
      className="rc-surface-panel grid rc-card-in"
      style={{
        padding: "14px 16px",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: "12px 22px",
      }}
    >
      {/* Candidate profile */}
      <div>
        <div className="hint" style={{ marginBottom: 7 }}>
          {t("rc_candidate_profile_title")}
        </div>
        <div className="text-[13px] text-ink-1 font-semibold" style={{ marginBottom: 4 }}>
          {name || t("rc_candidate_no_name")}
          {gender ? ` · ${gender}` : ""}
          {marital ? ` · ${marital}` : ""}
          {nationality ? ` · ${nationality}` : ""}
        </div>
        <div className="text-[11.5px] text-ink-2" style={{ lineHeight: 1.6 }}>
          {degree || school || major ? (
            <div>
              <span className="hint">{t("rc_edu_label")}</span> {degree}
              {school ? ` · ${school}` : ""}
              {major ? ` · ${major}` : ""}
              {eduEnd ? ` · ${eduStart || "?"} → ${eduEnd}` : ""}
            </div>
          ) : null}
          {totalYears ? (
            <div>
              <span className="hint">{t("rc_exp_label")}</span> {totalYears}
            </div>
          ) : null}
          {address || phone ? (
            <div className="text-ink-3">
              {address ? `${address}` : ""}
              {phone ? ` · 📞 ${phone.slice(0, 3)}****${phone.slice(-2)}` : ""}
            </div>
          ) : null}
          {expectedSalary ? (
            <div>
              <span className="hint">{t("rc_salary_label")}</span> {expectedSalary}
            </div>
          ) : null}
        </div>
        {scopeLine}
      </div>

      {/* Position profile */}
      <div>
        <div className="hint" style={{ marginBottom: 7 }}>
          {t("rc_jr_profile_title")}
        </div>
        <div className="text-[13px] text-ink-1 font-semibold" style={{ marginBottom: 4 }}>
          {jrTitle || t("rc_jr_no_title")}
          {jrDept ? ` · ${jrDept}` : ""}
        </div>
        <div className="text-[11.5px] text-ink-2" style={{ lineHeight: 1.6 }}>
          {jrCity ? <div><span className="hint">{t("rc_city_label")}</span> {jrCity}</div> : null}
          {jrSalary ? <div><span className="hint">{t("rc_salary_range_label")}</span> {jrSalary}</div> : null}
          {jrDegreeReq ? <div><span className="hint">{t("rc_degree_req_label")}</span> {jrDegreeReq}</div> : null}
        </div>
        {scopeLine}
      </div>
    </div>
  );
}
