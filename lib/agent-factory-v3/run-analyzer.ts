// #6 — whole-run analyzer. Reads a run's full event stream (thinking, tool calls + failures,
// agents designed, validation issues, refines + score moves, reverts, sandbox outcome, errors),
// builds a compact digest, and has an LLM review it: a 0–100 score + strengths / problems /
// suggestions, so the user can see what went wrong each run. The digest is pure + testable; the
// LLM critique degrades to a digest-only result when no gateway is configured.

import type { BrainEvent } from "./brain/types";
import { chatComplete, isGatewayConfigured } from "@/server/llm/gateway";
import { modelChain } from "./brain/model-router";

export interface RunReview {
  scored: boolean;
  score: number;
  summary: string;
  strengths: string[];
  problems: string[];
  suggestions: string[];
  /** which model produced the review (annotated in the UI). */
  model?: string;
  digest: string;
}

const g = (e: BrainEvent, k: string) => (e as unknown as Record<string, unknown>)[k];

/** A compact, human-readable digest of everything the run did — the input to the critic. Pure. */
export function runDigest(events: BrainEvent[]): string {
  const lines: string[] = [];
  let think = 0, tools = 0, toolFails = 0, refines = 0;
  for (const e of events) {
    switch (e.t) {
      case "think": think++; break;
      case "tool.call": tools++; lines.push(`· 工具 ${String(g(e, "name"))}｜理由: ${String(g(e, "reasoning") ?? "").slice(0, 90)}`); break;
      case "tool.result": if (!g(e, "ok")) { toolFails++; lines.push(`    ✗ 失败: ${String(g(e, "summary") ?? "").slice(0, 110)}`); } break;
      case "plan": lines.push(`· 规划: ${String((g(e, "plan") as Record<string, unknown>)?.summary ?? "").slice(0, 120)}`); break;
      case "agent.created": lines.push(`· 设计 agent ${String((g(e, "spec") as Record<string, unknown>)?.short ?? "")}`); break;
      case "validation": lines.push(`· 校验: ${g(e, "ok") ? "闭合 ✓" : "未闭合 — " + ((g(e, "issues") as string[]) ?? []).slice(0, 3).join("；")}`); break;
      case "refine": refines++; lines.push(`· 精修 ${String(g(e, "actionName"))}: ${String(g(e, "critique") ?? "").slice(0, 90)}`); break;
      case "score.delta": lines.push(`· 评分 ${String(g(e, "actionName"))}: ${g(e, "priorTotal")}→${g(e, "newTotal")}${g(e, "regression") ? " (退步)" : ""}`); break;
      case "revert": lines.push(`· 回滚 ${String(g(e, "actionName"))}`); break;
      case "sandbox": lines.push(`· 沙箱: 部署 ${g(e, "deployed") ?? g(e, "functionsRegistered") ?? 0}·跑 ${g(e, "ran") ?? 0}·${g(e, "fullChainRan") ? "端到端通 ✓" : "未通"}`); break;
      case "error": lines.push(`· 错误: ${String(g(e, "message") ?? "").slice(0, 120)}`); break;
      case "done": lines.push(`· 结束: ${String(g(e, "status"))}`); break;
    }
  }
  const head = `本次运行概览: ${think} 段思考 · ${tools} 次工具调用(${toolFails} 失败) · ${refines} 次精修`;
  return `${head}\n${lines.join("\n")}`.slice(0, 14000);
}

const FALLBACK = (digest: string): RunReview => ({ scored: false, score: 0, summary: "（无 LLM 网关，仅给出活动摘要，未评分）", strengths: [], problems: [], suggestions: [], digest });

/** LLM critique of a run. Returns a score + structured findings; degrades to digest-only. */
export async function analyzeRun(events: BrainEvent[], domain: string): Promise<RunReview> {
  const digest = runDigest(events);
  if (!isGatewayConfigured()) return FALLBACK(digest);
  const model = modelChain("hard")[0]; // review is a hard reasoning task → strong tier
  const sys =
    "你是 Agent 工厂运行的【质检评审员】。给定一次「用本体生成 agents」运行的活动摘要，客观评估它在 读本体→规划→设计→校验→试运行→交付 各环节做得怎样：是否接地不脑补、规则是否运行时动态抓、有没有默默降级、遇到问题是否合理解决或恰当询问用户、最终是否真跑通(非模拟)。打一个 0-100 总分。" +
    '只输出 JSON：{"score":number,"summary":string,"strengths":string[],"problems":string[],"suggestions":string[]}，全部用中文，problems/suggestions 要具体到环节和动作。不要任何其它文字。';
  try {
    const res = await chatComplete({ system: sys, user: `业务域: ${domain}\n${digest}`, temperature: 0.3, maxTokens: 1400, model, toolName: "analyze_run" });
    const m = (res.text || "").match(/\{[\s\S]*\}/);
    const j = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
    if (!j) return FALLBACK(digest);
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    return { scored: true, score: Math.max(0, Math.min(100, Math.round(Number(j.score) || 0))), summary: String(j.summary ?? ""), strengths: arr(j.strengths), problems: arr(j.problems), suggestions: arr(j.suggestions), model, digest };
  } catch {
    return FALLBACK(digest);
  }
}
