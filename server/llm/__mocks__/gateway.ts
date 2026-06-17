// Vitest manual mock for the LLM gateway. Activated per-test with
// `vi.mock("@/server/llm/gateway")`. The agent-factory-v2 builders now have NO
// fallback — a real LLM call or a throw — so hermetic tests must MOCK the LLM
// (instead of the old gateway-down→fallback path). This returns deterministic,
// builder-appropriate responses keyed off the `toolName` (`factory2.<builder>`).

export class GatewayUnavailableError extends Error {
  constructor() {
    super("gateway unavailable (mock)");
    this.name = "GatewayUnavailableError";
  }
}

export function isGatewayConfigured(): boolean {
  return true;
}

/** Parse the comma-separated event vocabulary out of a planner user prompt. */
function parseEvents(user: string): string[] {
  const m = user.match(/可用事件[^\n]*\n([^\n]+)/);
  if (!m) return [];
  return m[1].split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

/** Parse tool names out of a catalog block ("- toolName(...)\n  用途: ..."). */
function firstTools(user: string, n: number): string[] {
  const names: string[] = [];
  for (const line of user.split("\n")) {
    const m = line.match(/^- ([A-Za-z][\w.]*)/);
    if (m) names.push(m[1]);
    if (names.length >= n) break;
  }
  return names;
}

/** Build a small but closeable plan (passes static validation + smoke). */
function mockPlan(user: string): unknown {
  const ev = parseEvents(user);
  const e0 = ev[0] ?? "ENTRY_EVENT";
  const e1 = ev[1] ?? "MID_EVENT";
  const e2 = ev[2] ?? "MID2_EVENT";
  return {
    agents: [
      { name: "MockIntakeAgent", trigger: [e0], emit: [e1], objects: [], ruleRefs: [], rationale: "mock intake" },
      { name: "MockProcessAgent", trigger: [e1], emit: [e2], objects: [], ruleRefs: [], rationale: "mock process" },
      { name: "MockFinishAgent", trigger: [e2], emit: ["MOCK_DONE"], objects: [], ruleRefs: [], rationale: "mock finish" },
    ],
    skills: [{ name: "MockSkill", purpose: "mock shared capability" }],
  };
}

export async function chatComplete(opts: {
  system: string;
  user: string;
  toolName?: string;
  maxTokens?: number;
}): Promise<{ text: string; modelUsed: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const builder = (opts.toolName ?? "").replace(/^factory2\./, "");
  let text = "";
  switch (builder) {
    case "facet-analyst":
      text = "这一类元素对该业务域至关重要,定义了核心流转逻辑。\n- 要点一\n- 要点二\n- 要点三";
      break;
    case "integrator":
      text =
        "该业务域以事件驱动动作、动作产出下游事件的方式形成闭环。各切面通过事件相互联动。对 agent 生成而言,需要把动作封装为工具链并用事件建立反馈机制。";
      break;
    case "planner":
      text = JSON.stringify(mockPlan(opts.user));
      break;
    case "toolsmith": {
      const tools = firstTools(opts.user, 2);
      text = JSON.stringify({ tools: tools.length ? tools : [], retries: 1 });
      break;
    }
    case "promptwriter":
      text =
        "你是一个严谨的业务判定 agent。角色与边界:依据触发事件与工具结果做出判断;只在基础设施故障时抛错,业务 FAIL 为合法结论。请按步骤调用工具,最终输出 JSON {\"decision\":<事件名>,\"reason\":\"...\"}。";
      break;
    case "critic":
      text = JSON.stringify({ score: 0.9, issues: [] });
      break;
    case "skillsmith":
      text = JSON.stringify({ promptFragment: "按既定步骤执行该技能", tools: [], decisionRule: "当需要该能力时应用" });
      break;
    case "fixer":
      text = JSON.stringify({ reason: "mock: 无需结构性修改" });
      break;
    default:
      text = "mock response";
  }
  return {
    text,
    modelUsed: "mock-model",
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}
