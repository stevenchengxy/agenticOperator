// Real execution for factory-GENERATED agents.
//
// Replaces the old sleep+emit shell: when a generated agent is triggered, it
// actually runs — calls its OWN LLM with its prompt + the case data, uses its
// bound tools (real function-calling; dry-run dispatch for test domains), and
// DECIDES which single outcome event to emit. So each run reasons about the
// real case and picks a branch — genuinely dynamic, not a stub.

import { chatComplete, isGatewayConfigured, type ChatTool } from "@/server/llm/gateway";
import { resolveRegistry, isForceDryRunDomain, isLiveWriteAllowed } from "@/lib/tools/resolve-registry";
import { registerPersistedInto } from "@/lib/tools/persisted-tools";

export type AgentExecSpec = {
  actionName: string;
  domainId: string;
  systemPrompt: string;
  userPrompt: string;
  tools: string[];
  emit: string[];
};

export type AgentDecision = {
  /** the single outcome event the agent chose to emit (bare name) */
  event: string;
  reasoning: string;
  payload: Record<string, unknown>;
  toolCalls: Array<{ name: string; args: unknown }>;
  degraded: boolean;
};

const sanitize = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, "__");

/** Run a generated agent for one triggering event. Returns the chosen outcome. */
export async function executeGeneratedAgent(
  spec: AgentExecSpec,
  ev: { eventName: string; eventData: Record<string, unknown> },
  opts: { forceDryRun?: boolean } = {},
): Promise<AgentDecision> {
  const emits = spec.emit.filter((e) => e && e !== "—");
  const degrade = (reasoning: string): AgentDecision => ({ event: emits[0] ?? "", reasoning, payload: {}, toolCalls: [], degraded: true });
  if (emits.length === 0) return { event: "", reasoning: "无候选结果事件", payload: {}, toolCalls: [], degraded: false };
  if (!isGatewayConfigured()) return degrade("LLM 网关未配置 — 走默认分支");

  // Registry + dry-run resolve from the spec's REAL domainId (so a sandbox copy
  // still binds the right tool library). forceDryRun pins dry-run regardless —
  // set when running inside a dedicated sandbox app, so a real domain's agents
  // never fire real external side effects during a test.
  const registry = resolveRegistry(spec.domainId);
  // fold in approved AI-created (persisted) tools so deployed agents can run them too.
  try { await registerPersistedInto(registry, spec.domainId); } catch { /* library optional */ }
  const dryRun = opts.forceDryRun || isForceDryRunDomain(spec.domainId);
  const toolCalls: AgentDecision["toolCalls"] = [];
  const nameMap = new Map<string, string>(); // sanitized → real

  const workSchemas: ChatTool[] = spec.tools
    .map((n) => registry.get(n))
    .filter((d): d is NonNullable<typeof d> => !!d)
    .map((d) => {
      const safe = sanitize(d.name);
      nameMap.set(safe, d.name);
      return { type: "function", function: { name: safe, description: d.description, parameters: (d.parameters as Record<string, unknown>) ?? { type: "object", properties: {} } } };
    });

  const decideSchema: ChatTool = {
    type: "function",
    function: {
      name: "decide",
      description: "完成分析后必须调用：从候选结果事件里选恰好一个发出，给出一句中文判断依据和事件 payload。",
      parameters: {
        type: "object",
        properties: {
          event: { type: "string", enum: emits, description: "要发出的结果事件（从候选里选一个）" },
          reasoning: { type: "string", description: "一句中文：你为什么判断发出这个事件" },
          payload: { type: "object", description: "事件载荷（可空对象）" },
        },
        required: ["event", "reasoning"],
      },
    },
  };

  let decision: AgentDecision | null = null;
  const system = spec.systemPrompt || `你是「${spec.actionName}」agent。`;
  const user = [
    spec.userPrompt || "处理当前案例。",
    `\n你收到了事件「${ev.eventName}」。案例数据：`,
    "```json",
    JSON.stringify(ev.eventData ?? {}).slice(0, 1500),
    "```",
    spec.tools.length ? `你可以调用工具来完成工作${dryRun ? "（测试域：工具返回模拟数据，据此判断即可）" : ""}。` : "",
    `\n分析后，你【必须】调用 decide 工具，从这些候选结果事件里选恰好一个发出：${emits.join(" / ")}。`,
  ].join("\n");

  try {
    const res = await chatComplete({
      system,
      user,
      temperature: 0.3,
      maxTokens: 700,
      tools: {
        schema: [...workSchemas, decideSchema],
        maxIterations: 6,
        onToolCall: async (name, args) => {
          if (name === "decide") {
            const a = (args ?? {}) as { event?: string; reasoning?: string; payload?: Record<string, unknown> };
            const chosen = emits.includes(a.event ?? "") ? a.event! : emits[0];
            decision = { event: chosen, reasoning: a.reasoning ?? "", payload: a.payload ?? {}, toolCalls, degraded: false };
            return { ok: true, accepted: chosen };
          }
          const real = nameMap.get(name) ?? name;
          toolCalls.push({ name: real, args });
          const d = registry.get(real);
          if (d?.execute) {
            // P1-3 (audit MAJOR): write/dual-write tools only do REAL side effects on
            // a domain explicitly in the live-write allowlist; otherwise degrade to
            // dry-run (fail-closed) so a mis-wired / not-yet-inventoried domain can't
            // silently fire real inviteCandidate / partner-pg writes. Non-write tools
            // and already-dry-run domains are unaffected.
            const isWrite = d.sideEffect === "write" || d.sideEffect === "dual-write";
            const effectiveDryRun = dryRun || (isWrite && !isLiveWriteAllowed(spec.domainId));
            if (isWrite && !dryRun && effectiveDryRun) {
              console.warn(`[agent-executor] 写工具 ${real} 在域「${spec.domainId}」降级为 dry-run(不在 LIVE_WRITE_DOMAINS 允许名单)——如确需真写,把该域加入 LIVE_WRITE_DOMAINS 环境变量。`);
            }
            try { return await d.execute((args ?? {}) as Record<string, unknown>, { dryRun: effectiveDryRun }); }
            catch (e) { return { error: (e as Error).message }; }
          }
          return { ok: true, note: `${real} 无执行器，按 dry-run 处理` };
        },
      },
    });
    if (decision) return decision;
    // model produced final text without calling decide — keep its text as the reasoning
    return degrade(res.text ? res.text.slice(0, 140) : "模型未调用 decide — 走默认分支");
  } catch (e) {
    return degrade(`执行异常（${(e as Error).message.slice(0, 60)}）— 走默认分支`);
  }
}
