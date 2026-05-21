import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("POST /api/chat/trace", () => {
  it("returns 400 when messages missing", async () => {
    (isGatewayConfigured as any).mockReturnValue(true);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
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
  });

  it("returns gateway-not-configured reply when gateway off", async () => {
    (isGatewayConfigured as any).mockReturnValue(false);
    const res = await POST(makeReq({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply.content).toContain("LLM");
  });

  it("returns assistant reply on simple message (no tool calls)", async () => {
    (isGatewayConfigured as any).mockReturnValue(true);
    (pickGateway as any).mockReturnValue({
      baseURL: "http://fake",
      apiKey: "fake-key",
      model: "gemini-3-flash",
    });
    _state.create.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "hello back", tool_calls: [] } }],
      model: "gemini-3-flash",
    });
    const res = await POST(makeReq({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply.content).toBe("hello back");
    expect(body.toolCallsExecuted).toBe(0);
  });

  it("dispatches tool call and feeds result back", async () => {
    (isGatewayConfigured as any).mockReturnValue(true);
    (findTool as any).mockReturnValue({
      name: "searchRuns",
      execute: vi.fn().mockResolvedValue({
        result: { runs: [{ id: "R-1" }], total: 1 },
        sources: [{ tool: "searchRuns", label: "R-1", url: "/monitor?run=R-1" }],
      }),
    });
    _state.create
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "searchRuns", arguments: '{"agent":"X"}' } }],
          },
        }],
        model: "x",
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "Found 1 run.", tool_calls: [] } }],
        model: "x",
      });
    (pickGateway as any).mockReturnValue({ baseURL: "http://fake", apiKey: "fake-key", model: "x" });

    const res = await POST(makeReq({ messages: [{ role: "user", content: "any runs for X?" }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply.content).toBe("Found 1 run.");
    expect(body.sources).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "searchRuns" })]));
    expect(body.toolCallsExecuted).toBe(1);
  });

  it("handles unknown tool name gracefully", async () => {
    (isGatewayConfigured as any).mockReturnValue(true);
    (findTool as any).mockReturnValue(undefined); // tool not found
    _state.create
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bogus", arguments: "{}" } }] } }],
        model: "x",
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "tool not found, sorry", tool_calls: [] } }],
        model: "x",
      });
    (pickGateway as any).mockReturnValue({ baseURL: "http://fake", apiKey: "fake-key", model: "x" });
    const res = await POST(makeReq({ messages: [{ role: "user", content: "x" }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply.content).toContain("tool not found");
  });

  it("returns 502 when pickGateway throws", async () => {
    (isGatewayConfigured as any).mockReturnValue(true);
    (pickGateway as any).mockImplementation(() => { throw new Error("no LLM"); });
    const res = await POST(makeReq({ messages: [{ role: "user", content: "x" }] }));
    expect(res.status).toBe(502);
  });
});
