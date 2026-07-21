import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@/lib/chat/types";

// Per-test completion create mock, accessed via stable object reference.
const _state = { create: vi.fn() };

// Mock openai: use a class (not an arrow fn) so `new OpenAI(...)` works.
vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: (...args: unknown[]) => _state.create(...args) } };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeOpenAI };
});

vi.mock("@/server/llm/gateway", () => ({
  isGatewayConfigured: vi.fn(() => true),
  pickGateway: vi.fn(),
}));

vi.mock("@/lib/chat/global-chat-tools", () => ({
  TOOLS: [],
  TOOL_SCHEMAS: [],
  findTool: vi.fn(),
}));

import { POST } from "./route";
import { pickGateway, isGatewayConfigured } from "@/server/llm/gateway";
import { findTool } from "@/lib/chat/global-chat-tools";

beforeEach(() => {
  (isGatewayConfigured as any).mockReset();
  (pickGateway as any).mockReset();
  (findTool as any).mockReset();
  _state.create.mockReset();
});

function makeReq(body: object): Request {
  return new Request("http://x/api/chat/trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Build an async iterable from an array — simulates OpenAI SSE stream chunks. */
function asyncIterable<T>(arr: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= arr.length) return { value: undefined as T, done: true };
          return { value: arr[i++]!, done: false };
        },
      };
    },
  };
}

/** Read a streaming SSE Response and collect all events. */
async function readSse(res: Response): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      events.push(JSON.parse(line.slice(5).trim()) as StreamEvent);
    }
  }
  return events;
}

function setupGatewayMock(create: ReturnType<typeof vi.fn>) {
  (isGatewayConfigured as any).mockReturnValue(true);
  (pickGateway as any).mockReturnValue({
    baseURL: "http://fake",
    apiKey: "fake-key",
    model: "test-model",
  });
  _state.create.mockImplementation(create);
}

describe("POST /api/chat/trace", () => {
  // ── Validation errors: still plain JSON ──────────────────────────────

  it("returns 400 when messages missing", async () => {
    (isGatewayConfigured as any).mockReturnValue(true);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("BAD_REQUEST");
  });

  it("returns 400 on invalid JSON body", async () => {
    (isGatewayConfigured as any).mockReturnValue(true);
    const req = new Request("http://x/api/chat/trace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("BAD_REQUEST");
  });

  // ── Gateway not configured: still returns SSE with text chunk ────────

  it("streams a gateway-not-configured message when gateway off", async () => {
    (isGatewayConfigured as any).mockReturnValue(false);
    const res = await POST(makeReq({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);
    const chunk = events.find((e): e is { type: "text_chunk"; content: string } => e.type === "text_chunk");
    expect(chunk?.content).toContain("LLM");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  // ── Simple text streaming (no tool calls) ────────────────────────────

  it("streams text_chunk events for a simple reply", async () => {
    setupGatewayMock(() =>
      asyncIterable([
        { choices: [{ delta: { content: "hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    const res = await POST(makeReq({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);
    const texts = events
      .filter((e): e is { type: "text_chunk"; content: string } => e.type === "text_chunk")
      .map((e) => e.content)
      .join("");
    expect(texts).toBe("hello world");
    const done = events.find((e) => e.type === "done") as { type: "done"; toolCallsExecuted: number } | undefined;
    expect(done).toBeDefined();
    expect(done?.toolCallsExecuted).toBe(0);
  });

  it("emits no sources event when no tools were called", async () => {
    setupGatewayMock(() =>
      asyncIterable([
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: {} }] },
      ]),
    );
    const res = await POST(makeReq({ messages: [{ role: "user", content: "hi" }] }));
    const events = await readSse(res);
    expect(events.some((e) => e.type === "sources")).toBe(false);
  });

  // ── Tool call dispatch ───────────────────────────────────────────────

  it("emits tool_call_start / tool_call_done around a tool call", async () => {
    (findTool as any).mockReturnValue({
      name: "searchRuns",
      execute: vi.fn().mockResolvedValue({
        result: { runs: [{ id: "R-1" }], total: 1 },
        sources: [{ tool: "searchRuns", label: "R-1", url: "/monitor?run=R-1" }],
      }),
    });

    // First stream: tool_calls chunks (no content), then stop
    const firstStream = asyncIterable([
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "searchRun", arguments: '{"age' } }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: 'nt":"X"}' } }],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    // Second stream: text response
    const secondStream = asyncIterable([
      { choices: [{ delta: { content: "Found 1 run." } }] },
      { choices: [{ delta: {} }] },
    ]);

    let callCount = 0;
    setupGatewayMock(() => {
      return callCount++ === 0 ? firstStream : secondStream;
    });

    const res = await POST(makeReq({ messages: [{ role: "user", content: "any runs for X?" }] }));
    const events = await readSse(res);

    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_done")).toBe(true);
    const done = events.find((e) => e.type === "done") as { type: "done"; toolCallsExecuted: number } | undefined;
    expect(done?.toolCallsExecuted).toBe(1);
    const texts = events
      .filter((e): e is { type: "text_chunk"; content: string } => e.type === "text_chunk")
      .map((e) => e.content)
      .join("");
    expect(texts).toBe("Found 1 run.");
  });

  it("emits sources event when tools return sources", async () => {
    (findTool as any).mockReturnValue({
      name: "searchRuns",
      execute: vi.fn().mockResolvedValue({
        result: { runs: [], total: 0 },
        sources: [{ tool: "searchRuns", label: "R-2", url: "/monitor?run=R-2" }],
      }),
    });

    let callCount = 0;
    setupGatewayMock(() => {
      if (callCount++ === 0) {
        return asyncIterable([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "searchRuns", arguments: "{}" } }] } }] },
          { choices: [{ delta: {} }] },
        ]);
      }
      return asyncIterable([
        { choices: [{ delta: { content: "done" } }] },
        { choices: [{ delta: {} }] },
      ]);
    });

    const res = await POST(makeReq({ messages: [{ role: "user", content: "x" }] }));
    const events = await readSse(res);
    const sourcesEvt = events.find((e) => e.type === "sources") as { type: "sources"; items: unknown[] } | undefined;
    expect(sourcesEvt).toBeDefined();
    expect(sourcesEvt?.items).toHaveLength(1);
  });

  it("handles unknown tool name gracefully", async () => {
    (findTool as any).mockReturnValue(undefined); // tool not found

    let callCount = 0;
    setupGatewayMock(() => {
      if (callCount++ === 0) {
        return asyncIterable([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "bogus", arguments: "{}" } }] } }] },
          { choices: [{ delta: {} }] },
        ]);
      }
      return asyncIterable([
        { choices: [{ delta: { content: "tool not found, sorry" } }] },
        { choices: [{ delta: {} }] },
      ]);
    });

    const res = await POST(makeReq({ messages: [{ role: "user", content: "x" }] }));
    const events = await readSse(res);
    const toolDone = events.find((e) => e.type === "tool_call_done") as any;
    expect(toolDone?.resultPreview).toBe("(unknown tool)");
    const texts = events
      .filter((e): e is { type: "text_chunk"; content: string } => e.type === "text_chunk")
      .map((e) => e.content)
      .join("");
    expect(texts).toContain("tool not found");
  });

  it("emits error event when pickGateway throws", async () => {
    (isGatewayConfigured as any).mockReturnValue(true);
    (pickGateway as any).mockImplementation(() => { throw new Error("no LLM"); });
    const res = await POST(makeReq({ messages: [{ role: "user", content: "x" }] }));
    // SSE response — need to read the stream
    expect(res.status).toBe(200);
    const events = await readSse(res);
    const errEvt = events.find((e) => e.type === "error") as { type: "error"; message: string } | undefined;
    expect(errEvt?.message).toContain("no LLM");
  });

  it("after MAX_TOOL_TURNS still requesting tools, stops and emits done", async () => {
    (isGatewayConfigured as any).mockReturnValue(true);
    (pickGateway as any).mockReturnValue({ baseURL: "http://fake", apiKey: "fake-key", model: "x" });
    (findTool as any).mockReturnValue({
      name: "searchRuns",
      execute: vi.fn().mockResolvedValue({ result: { runs: [], total: 0 }, sources: [] }),
    });

    // Every call keeps requesting tool_calls (loop forever scenario)
    _state.create.mockImplementation(() =>
      asyncIterable([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${Math.random()}`, function: { name: "searchRuns", arguments: "{}" } }] } }] },
        { choices: [{ delta: {} }] },
      ]),
    );

    const res = await POST(makeReq({ messages: [{ role: "user", content: "loop forever" }] }));
    const events = await readSse(res);
    const done = events.find((e) => e.type === "done") as { type: "done"; toolCallsExecuted: number } | undefined;
    expect(done).toBeDefined();
    expect(done?.toolCallsExecuted).toBeGreaterThanOrEqual(4);
  });
});
