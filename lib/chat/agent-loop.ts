import type { ChatMessage, ChatSource } from "./types";

export type CopilotRuntimeEvent =
  | { type: "prompt"; sessionId: string; content: string; at: string }
  | { type: "assistant_start"; sessionId: string; at: string }
  | {
      type: "assistant_done";
      sessionId: string;
      at: string;
      content: string;
      modelUsed?: string;
      toolCallsExecuted: number;
      sources?: ChatSource[];
    }
  | { type: "tool_start"; sessionId: string; at: string; name: string; args: unknown }
  | { type: "tool_done"; sessionId: string; at: string; name: string; ms: number; preview?: string }
  | { type: "compact"; sessionId: string; at: string; summary: string; removedMessages: number }
  | { type: "error"; sessionId: string; at: string; message: string };

export type AgentLoopStatus = "idle" | "running" | "done" | "failed";

export type AgentLoopStep = {
  title: "Observe" | "Plan" | "Act" | "Reflect" | "Review";
  detail: string;
  status: AgentLoopStatus;
};

export type AgentSkill = {
  title: string;
  detail: string;
  generated: boolean;
};

export type AgentToolRun = {
  id: string;
  name: string;
  startedAt: string;
  done?: Extract<CopilotRuntimeEvent, { type: "tool_done" }>;
};

export type AgentEvaluation = {
  completeness: number;
  groundedness: number;
  loopControl: number;
  state: "waiting" | "running" | "complete" | "needs_attention";
};

export type AgentReasoningStep = {
  id: "intake" | "context" | "plan" | "act" | "synthesize" | "review";
  title: string;
  detail: string;
  status: AgentLoopStatus;
};

export type AgentLoopSnapshot = {
  running: boolean;
  latestPrompt?: Extract<CopilotRuntimeEvent, { type: "prompt" }>;
  latestAnswer?: Extract<CopilotRuntimeEvent, { type: "assistant_done" }>;
  latestError?: Extract<CopilotRuntimeEvent, { type: "error" }>;
  goal: string;
  context: string;
  next: string;
  steps: AgentLoopStep[];
  reasoningSteps: AgentReasoningStep[];
  skills: AgentSkill[];
  toolRuns: AgentToolRun[];
  evaluation: AgentEvaluation;
};

export function buildAgentLoopSnapshot(
  events: CopilotRuntimeEvent[],
  messages: ChatMessage[],
): AgentLoopSnapshot {
  const latestPrompt = lastOf(events, "prompt");
  const latestAnswer = lastOf(events, "assistant_done");
  const latestError = lastOf(events, "error");
  const latestStart = lastOf(events, "assistant_start");
  const running = !!latestStart && (!latestAnswer || latestAnswer.at < latestStart.at) && (!latestError || latestError.at < latestStart.at);
  const toolRuns = buildToolRuns(events);
  const steps = buildLoopRows(events);
  const evaluation = buildEvaluation(latestAnswer, latestError, running);
  const reasoningSteps = buildReasoningSteps(events, toolRuns, evaluation);

  return {
    running,
    latestPrompt,
    latestAnswer,
    latestError,
    goal: latestPrompt?.content || "等待用户输入",
    context: compactContextLine(messages),
    next: running ? "观察工具结果并合成回答" : latestAnswer ? "等待继续追问" : "准备新 loop",
    steps,
    reasoningSteps,
    skills: buildSkills(events),
    toolRuns,
    evaluation,
  };
}

export function eventTitle(e: CopilotRuntimeEvent): string {
  if (e.type === "prompt") return "user.prompt";
  if (e.type === "assistant_start") return "assistant.start";
  if (e.type === "assistant_done") return "assistant.done";
  if (e.type === "tool_start") return `tool.start ${e.name}`;
  if (e.type === "tool_done") return `tool.done ${e.name}`;
  if (e.type === "compact") return "memory.compact";
  return "error";
}

function buildReasoningSteps(
  events: CopilotRuntimeEvent[],
  toolRuns: AgentToolRun[],
  evaluation: AgentEvaluation,
): AgentReasoningStep[] {
  const latestPrompt = lastOf(events, "prompt");
  const latestStart = lastOf(events, "assistant_start");
  const latestAnswer = lastOf(events, "assistant_done");
  const latestError = lastOf(events, "error");
  const hasToolStarted = toolRuns.length > 0;
  const hasToolRunning = toolRuns.some((run) => !run.done);

  return [
    {
      id: "intake",
      title: "Intake",
      detail: latestPrompt ? "接收用户目标与当前页面上下文" : "等待用户 prompt",
      status: latestPrompt ? "done" : "idle",
    },
    {
      id: "context",
      title: "Context",
      detail: latestPrompt ? "合并 page context、会话记忆、可用工具清单" : "尚未构建上下文",
      status: latestPrompt ? "done" : "idle",
    },
    {
      id: "plan",
      title: "Plan",
      detail: latestStart ? "选择直接回答或进入工具调用路径" : "等待模型规划",
      status: latestStart ? "done" : latestPrompt ? "running" : "idle",
    },
    {
      id: "act",
      title: "Act",
      detail: hasToolStarted ? `${toolRuns.filter((run) => run.done).length}/${toolRuns.length} tools completed` : "无需工具或尚未调用工具",
      status: hasToolRunning ? "running" : hasToolStarted ? "done" : latestStart ? "done" : "idle",
    },
    {
      id: "synthesize",
      title: "Synthesize",
      detail: latestAnswer ? "已整合证据并生成回答" : latestError ? "生成失败，进入复核" : latestStart ? "等待模型输出" : "尚未开始生成",
      status: latestAnswer ? "done" : latestError ? "failed" : latestStart ? "running" : "idle",
    },
    {
      id: "review",
      title: "Review",
      detail: evaluation.state === "complete" ? "已完成可继续性与证据质量评估" : evaluation.state === "needs_attention" ? "需要人工查看错误" : "等待回答完成后评估",
      status: evaluation.state === "complete" ? "done" : evaluation.state === "needs_attention" ? "failed" : evaluation.state === "running" ? "running" : "idle",
    },
  ];
}

function buildToolRuns(events: CopilotRuntimeEvent[]): AgentToolRun[] {
  const starts = events.filter((e) => e.type === "tool_start");
  const dones = events.filter((e) => e.type === "tool_done");
  return starts.map((start, i) => ({
    id: `${start.name}-${start.at}-${i}`,
    name: start.name,
    startedAt: start.at,
    done: dones.find((done) => done.name === start.name && done.at >= start.at),
  }));
}

function buildSkills(events: CopilotRuntimeEvent[]): AgentSkill[] {
  const tools = unique(events.filter((e) => e.type === "tool_done").map((e) => e.name));
  return [
    { title: "Context Harness", detail: "当前页面、历史摘要、审计上下文注入。", generated: false },
    { title: "Agent Loop", detail: "Observe / Plan / Act / Reflect / Review。", generated: false },
    { title: "Evaluation", detail: "完整度、证据、风险与可继续性评分。", generated: false },
    ...tools.map((tool) => ({
      title: skillNameForTool(tool),
      detail: `${tool} 的可复用诊断套路。`,
      generated: true,
    })),
  ];
}

function buildLoopRows(events: CopilotRuntimeEvent[]): AgentLoopStep[] {
  const latestPrompt = lastOf(events, "prompt");
  const toolStarts = events.filter((e) => e.type === "tool_start");
  const toolDones = events.filter((e) => e.type === "tool_done");
  const answer = lastOf(events, "assistant_done");
  const err = lastOf(events, "error");
  return [
    { title: "Observe", detail: latestPrompt ? latestPrompt.content : "等待 prompt", status: latestPrompt ? "done" : "idle" },
    { title: "Plan", detail: latestPrompt ? "选择上下文与工具" : "尚未规划", status: latestPrompt ? "done" : "idle" },
    {
      title: "Act",
      detail: toolStarts.length ? `${toolDones.length}/${toolStarts.length} tools finished` : "无工具运行",
      status: toolStarts.length && toolStarts.length !== toolDones.length ? "running" : toolStarts.length ? "done" : "idle",
    },
    { title: "Reflect", detail: answer ? "已合成回答" : "等待输出", status: answer ? "done" : err ? "failed" : "idle" },
    { title: "Review", detail: err ? err.message : answer ? "已评估" : "等待完成", status: err ? "failed" : answer ? "done" : "idle" },
  ];
}

function buildEvaluation(
  latestAnswer: Extract<CopilotRuntimeEvent, { type: "assistant_done" }> | undefined,
  latestError: Extract<CopilotRuntimeEvent, { type: "error" }> | undefined,
  running: boolean,
): AgentEvaluation {
  if (latestError) {
    return { completeness: 28, groundedness: 34, loopControl: 42, state: "needs_attention" };
  }
  if (running) {
    return { completeness: 36, groundedness: 40, loopControl: 72, state: "running" };
  }
  if (!latestAnswer) {
    return { completeness: 0, groundedness: 0, loopControl: 0, state: "waiting" };
  }
  return {
    completeness: 84,
    groundedness: latestAnswer.toolCallsExecuted > 0 ? 90 : 68,
    loopControl: 86,
    state: "complete",
  };
}

function compactContextLine(messages: ChatMessage[]): string {
  const hasCompact = messages.some((m) => m.kind === "compact");
  const prompts = messages.filter((m) => m.role === "user").length;
  return `${hasCompact ? "compact memory + " : ""}${prompts} prompt${prompts === 1 ? "" : "s"} + page context + tool harness`;
}

function lastOf<T extends CopilotRuntimeEvent["type"]>(
  events: CopilotRuntimeEvent[],
  type: T,
): Extract<CopilotRuntimeEvent, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i] as Extract<CopilotRuntimeEvent, { type: T }>;
  }
  return undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function skillNameForTool(tool: string): string {
  if (/run/i.test(tool)) return "Run forensics";
  if (/event/i.test(tool)) return "Event trace review";
  if (/rule|audit/i.test(tool)) return "Rule-check diagnosis";
  if (/entity/i.test(tool)) return "Entity lookup";
  return `${tool} skill`;
}
