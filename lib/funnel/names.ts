// 流程追踪页的"id → 真实名字"解析。
//
// 名字按优先级从多源取，全部防御式降级（任一源缺失/不可达都不报错）：
//   1) RuleCheckAudit 快照：候选人 parsed_resume_json.name；
//      岗位 job_requisition_json.client_job_title (+ work_city)。
//      —— 与 /rule-check 的 CandidateProfileCard 用同一组字段路径。
//   2) Neo4j/Allmeta：resolveEntityNames(type, ids)（best-effort，Neo4j
//      不可达时返回空 Map）。
//   3) 调用方再兜底到 id 本身。
//
// 注：本地多为合成审计(rca_no-trace_*)且快照为空、Neo4j 也未必有这些 id，
// 故解析不到时调用方应回退显示 id —— 名字会在真数据流入后自动点亮。

import { resolveEntityNames } from "@/lib/allmeta-client";

export function parseJsonObj(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function pickStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 候选人名 ← parsed_resume_json.name */
export function candidateNameFromSnapshot(parsedResumeJson: string | null | undefined): string | null {
  const r = parseJsonObj(parsedResumeJson);
  return r ? pickStr(r.name) : null;
}

/** 岗位标题/城市 ← job_requisition_json.client_job_title / work_city|city */
export function jobMetaFromSnapshot(jobRequisitionJson: string | null | undefined): {
  title: string | null;
  city: string | null;
} {
  const j = parseJsonObj(jobRequisitionJson);
  if (!j) return { title: null, city: null };
  return {
    title: pickStr(j.client_job_title) ?? pickStr(j.title),
    city: pickStr(j.work_city) ?? pickStr(j.city),
  };
}

// Neo4j 解析有 per-id 往返（并发 5），按返回行数封顶以约束延迟。
const NEO4J_RESOLVE_CAP = 80;

/**
 * 批量把 ids 解析成名字（Neo4j best-effort）。
 * 只解析 `missing`（快照里没解到名字的 id），封顶 NEO4J_RESOLVE_CAP，
 * 全程 catch —— Neo4j 不可达时返回空 Map，调用方继续用 id 兜底。
 */
export async function resolveNamesBestEffort(
  type: "Candidate" | "JobRequisition",
  missing: string[],
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(missing.filter(Boolean))).slice(0, NEO4J_RESOLVE_CAP);
  if (ids.length === 0) return new Map();
  try {
    return await resolveEntityNames(type, ids);
  } catch {
    return new Map();
  }
}
