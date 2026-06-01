// Deterministic domain-tool simulation.
//
// The energy agents reference real external tools (慧采-SCADA / 设备通 / 能控EMS /
// 智调-* engines) that don't exist in this environment. Rather than block the
// chain, each tool call returns a deterministic stand-in result (derived from
// the tool + action names, no randomness) and is logged as a tool apiCall so it
// shows up in the audit trail. The LLM call is real; only the domain tools are
// simulated.

/** Stable small integer hash of a string (deterministic across runs). */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return h;
}

export type SimToolResult = {
  tool: string;
  ok: true;
  note: string;
  value: number;
};

/** Produce a deterministic simulated result for one tool, in the context of an action. */
export function simulateTool(toolName: string, actionName: string): SimToolResult {
  return {
    tool: toolName,
    ok: true,
    note: `模拟「${toolName}」返回(${actionName})`,
    value: hash(`${toolName}|${actionName}`),
  };
}

/** Simulate every tool an action uses; returns the results in order. */
export function simulateTools(tools: string[], actionName: string): SimToolResult[] {
  return tools.map((t) => simulateTool(t, actionName));
}

/** Render simulated tool results into a compact block for the LLM user prompt. */
export function toolResultsForPrompt(results: SimToolResult[]): string {
  if (results.length === 0) return "(无外部工具)";
  return results.map((r) => `- ${r.tool}: ${r.note} [v=${r.value}]`).join("\n");
}
