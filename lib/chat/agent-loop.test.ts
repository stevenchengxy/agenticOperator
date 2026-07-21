import { describe, expect, it } from "vitest";
import { buildAgentLoopSnapshot, eventTitle, type CopilotRuntimeEvent } from "./agent-loop";
import type { ChatMessage } from "./types";

describe("buildAgentLoopSnapshot", () => {
  it("builds an idle snapshot before any prompt", () => {
    const snapshot = buildAgentLoopSnapshot([], []);
    expect(snapshot.running).toBe(false);
    expect(snapshot.goal).toBe("等待用户输入");
    expect(snapshot.steps.map((s) => s.status)).toEqual(["idle", "idle", "idle", "idle", "idle"]);
    expect(snapshot.evaluation.state).toBe("waiting");
  });

  it("tracks tool runs, generated skills, and complete evaluation", () => {
    const events: CopilotRuntimeEvent[] = [
      { type: "prompt", sessionId: "s1", content: "最近失败的 run?", at: "2026-06-12T10:00:00.000Z" },
      { type: "assistant_start", sessionId: "s1", at: "2026-06-12T10:00:01.000Z" },
      { type: "tool_start", sessionId: "s1", name: "searchRuns", args: { status: "failed" }, at: "2026-06-12T10:00:02.000Z" },
      { type: "tool_done", sessionId: "s1", name: "searchRuns", ms: 42, preview: "1 runs", at: "2026-06-12T10:00:03.000Z" },
      { type: "assistant_done", sessionId: "s1", content: "找到 1 条。", toolCallsExecuted: 1, at: "2026-06-12T10:00:04.000Z" },
    ];
    const messages: ChatMessage[] = [{ role: "user", content: "最近失败的 run?" }];

    const snapshot = buildAgentLoopSnapshot(events, messages);

    expect(snapshot.running).toBe(false);
    expect(snapshot.goal).toBe("最近失败的 run?");
    expect(snapshot.toolRuns).toHaveLength(1);
    expect(snapshot.toolRuns[0].done?.preview).toBe("1 runs");
    expect(snapshot.skills.map((s) => s.title)).toContain("Run forensics");
    expect(snapshot.evaluation).toMatchObject({ state: "complete", groundedness: 90 });
  });

  it("formats event titles for the log panel", () => {
    expect(eventTitle({ type: "tool_done", sessionId: "s1", name: "searchRuns", ms: 1, at: "x" })).toBe("tool.done searchRuns");
  });
});
