import type { BuilderCtx, TargetAgentBrief } from "../types";
import { recordLlmCall, type PersistLlmCall } from "../ledger";
import type { PromptWriterResult } from "./prompt-writer";

export interface CritiqueResult {
  approved: boolean;
  score: number;
  issues: string[];
}

/** Parse the LLM's critique JSON: { score: number, issues: string[] }.
 *  Robust to a TRUNCATED response (a verbose critic can exceed maxTokens) — the
 *  `score` comes first, so we recover the REAL score even if the issues array was
 *  cut off mid-string. This is lenient parsing of a genuine response, NOT a fake
 *  fallback: if no real score is present at all, returns null → the caller throws. */
function parseCritique(text: string): { score: number; issues: string[] } | null {
  if (!text) return null;
  // 1) Try a complete JSON object.
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { score?: unknown; issues?: unknown };
      if (typeof o.score === "number") {
        const score = Math.max(0, Math.min(1, o.score));
        const issues = Array.isArray(o.issues)
          ? (o.issues as unknown[]).filter((i): i is string => typeof i === "string").slice(0, 8)
          : [];
        return { score, issues };
      }
    } catch { /* fall through to lenient extraction */ }
  }
  // 2) Lenient: pull the leading "score" out of a possibly-truncated object.
  const sm = text.match(/"score"\s*:\s*(-?\d*\.?\d+)/);
  if (!sm) return null;
  const score = Math.max(0, Math.min(1, Number(sm[1])));
  const issues: string[] = [];
  const im = text.match(/"issues"\s*:\s*\[([\s\S]*)/);
  if (im) {
    for (const q of im[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) issues.push(q[1]);
  }
  return { score, issues: issues.slice(0, 8) };
}

export async function critique(
  ctx: BuilderCtx,
  brief: TargetAgentBrief,
  prompt: PromptWriterResult,
  tools: string[],
  persist: PersistLlmCall,
): Promise<CritiqueResult> {
  const allowedEvents = brief.emit.join(", ") || "（无）";
  const allowedTools = tools.join(", ") || "（无）";

  const system = [
    "你是严格的 agent prompt 审查员。",
    "对提供的 system prompt 评分(0..1),检查:",
    "① coverage: 是否覆盖每个可发出事件的选择条件",
    "② tools: 是否只用给定工具(出现表外工具 = hallucination,重扣)",
    "③ events: 是否只发出给定事件(表外事件 = hallucination,重扣)",
    "④ json: 输出格式是否为 {\"decision\":<事件名>,\"reason\":...}",
    "⑤ role: 角色与边界是否清晰",
    "只返回 JSON: {\"score\":0..1, \"issues\":[\"...\", ...]}。无问题则 issues 为空。",
    "不要任何解释或代码块标记。",
  ].join("\n");

  const user = [
    `被审查的 agent: ${brief.name}`,
    `只能发出的决策事件: ${allowedEvents}`,
    `只能使用的工具: ${allowedTools}`,
    ``,
    `System prompt:`,
    prompt.system,
  ].join("\n");

  const { text } = await recordLlmCall(ctx, {
    builder: "critic",
    target: brief.name,
    purpose: "评审 system prompt",
    system,
    user,
    persist,
    maxTokens: 700,
  });

  const parsed = parseCritique(text);
  if (!parsed) {
    throw new Error(`critic 为 ${brief.name} 返回无法解析的评审 JSON(无降级):${text.slice(0, 160)}`);
  }

  const approved = parsed.score >= 0.8 || parsed.issues.length === 0;
  ctx.emit({ t: "prompt.critique", name: brief.name, score: parsed.score, approved });
  return { approved, score: parsed.score, issues: parsed.issues };
}
