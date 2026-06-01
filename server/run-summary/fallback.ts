// Deterministic fallback renderers for run summaries.
//
// Used when:
//   - LLM gateway not configured (deterministicSummary)
//   - run has 0 AgentActivity AND 0 WorkflowStep rows (emptyRunNotice) —
//     skips the LLM entirely so it can't hallucinate agent names like
//     `JD_Writer` that don't exist in AGENT_MAP
//
// Extracted from app/api/runs/[id]/summary/route.ts.

import { byShortFunction } from "@/lib/agent-functions";
import type { AgentBreakdownRow } from "./prompt";

export function deterministicSummary(
  run: { triggerEvent: string; status: string; suspendedReason: string | null },
  breakdown: AgentBreakdownRow[],
  steps: Array<{ nodeId: string; status: string; error: string | null }>,
  activities: Array<{ agentName: string; narrative: string }>,
): string {
  const lines: string[] = [];
  lines.push("## 概述");
  lines.push(
    `由 \`${run.triggerEvent}\` 触发，当前状态 \`${run.status}\`${run.suspendedReason ? `（${run.suspendedReason}）` : ""}。共涉及 ${breakdown.length} 个 agent，记录 ${steps.length} 个 step、${activities.length} 条 narrative。`,
  );
  lines.push("");
  lines.push("## 各 Agent 做了什么");
  if (breakdown.length === 0) {
    lines.push("- 暂无 agent 活动记录。");
  } else {
    for (const r of breakdown) {
      const fn = byShortFunction(r.agentName);
      const lastBit = r.lastNarrative ? `；最近一次：${truncate(r.lastNarrative, 80)}` : "";
      const fnBit = fn ? `（${fn.summary}）` : "";
      lines.push(
        `- **${r.agentName}** ${fnBit}：执行 ${r.steps} 个 step，累计 ${r.totalDurationMs} ms${r.failed > 0 ? `，**${r.failed} 失败**` : ""}${lastBit}`,
      );
    }
  }
  lines.push("");
  lines.push("## 异常 / 关注点");
  const failed = steps.filter((s) => s.status === "failed" || s.error);
  if (failed.length === 0) {
    lines.push("- 未发现失败 step。");
  } else {
    for (const s of failed) {
      lines.push(`- \`${s.nodeId}\`：${s.error ?? "step 状态为 failed"}`);
    }
  }
  lines.push("");
  lines.push("## 下一步建议");
  if (failed.length > 0) {
    lines.push("- 复盘失败 step 的输入与上游事件，判断是数据问题还是 agent 逻辑问题。");
  } else if (run.status === "suspended" || run.status === "paused") {
    lines.push("- 该 run 处于暂停状态，请检查 `suspendedReason` 并决定是否恢复。");
  } else if (run.status === "running") {
    lines.push("- 仍在执行中。可定期刷新本页观察进度。");
  } else {
    lines.push("- 此 run 已正常完成，可作为基准参考。");
  }
  lines.push("");
  lines.push("> 未配置 LLM 网关（AI_BASE_URL / OPENAI_API_KEY），以上内容由统计字段直接渲染。配置后可获得更具体的语义解读。");
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Honest "no data" notice rendered when a run has 0 AgentActivity AND
// 0 WorkflowStep rows. Without this, calling the LLM on emptiness leads
// to it inventing agent names like `JD_Writer / Recruiter_Agent` that
// don't exist in AGENT_MAP.
export function emptyRunNotice(run: {
  triggerEvent: string;
  status: string;
  startedAt: Date;
  suspendedReason: string | null;
}): string {
  const ageMs = Date.now() - run.startedAt.getTime();
  const ageMin = Math.round(ageMs / 60_000);
  return `## 概述
触发事件 \`${run.triggerEvent}\`，当前状态 \`${run.status}\`${
    run.suspendedReason ? `（${run.suspendedReason}）` : ""
  }。run 开始于 **${ageMin} 分钟前**。

## 数据状态
**这条 run 在 AgentActivity 表里 0 行记录**，在 WorkflowStep 表里也 0 步。无法做有意义的多 agent 路径分析或行为总结——LLM 没有可信数据可依，强行生成会产生幻觉的 agent 名（如 \`JD_Writer\` 等不存在于 AGENT_MAP 的虚构名）。

## 为什么是空的
- AO-main 已禁用所有 Inngest function（见 \`server/inngest/functions.ts\` 的 \`allFunctions: []\`），不会自己写 AgentActivity
- 实际 runtime 在 sibling 项目 \`resume-parser-agent\` (port 3020)，但它没接 AO-main 的 DB
- 所以即使 RPA agent 跑了，活动日志也不会落到这里

## 怎么修
任选其一：
1. RPA runtime 调用 \`POST /api/runs/[runId]/activity\` 把活动行 push 进来（详见路由文件注释）
2. 或者在 AO-main 的 \`server/inngest/functions.ts\` 里 re-enable agents（取消注释 \`allFunctions\` 数组）
3. 或者用 \`POST /api/runs/[runId]/activity\` 手动塞测试数据进来验证 UI

## 下一步建议
接通活动日志契约后，重新点 "重新生成"——LLM 才有真实数据做多 agent 分析。

> 这不是 LLM 不能用，是这条 run 没有数据可让它分析。`;
}
