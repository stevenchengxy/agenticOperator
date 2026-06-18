import { requireFactoryAuth } from "@/lib/factory-auth";
import { runBrain } from "@/lib/agent-factory-v3/brain/conductor";
import { P1_TOOLS } from "@/lib/agent-factory-v3/tools";
import { P2_TOOLS, P3_TOOLS } from "@/lib/agent-factory-v3/tools/p2-p3";

const ALL_TOOLS = [...P1_TOOLS, ...P2_TOOLS, ...P3_TOOLS];

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * SSE stream of the autonomous Harness brain. One BrainEvent per `data:` frame —
 * think deltas, tool calls + results, created agents, validation, sandbox runs,
 * the final message. The chatbot renders these live (Claude/Codex-style).
 *
 * Query: ?domain=<slug>&goal=<text>
 * Auth:  Bearer / x-factory-token / ?token= (dev no-op when unset).
 */
export async function GET(req: Request): Promise<Response> {
  const denied = requireFactoryAuth(req, { allowQueryToken: true });
  if (denied) return denied;

  const url = new URL(req.url);
  const domain = url.searchParams.get("domain") ?? "recruit-gen-v1";
  const goal =
    url.searchParams.get("goal") ??
    `为「${domain}」域生成能真正跑通的 agents：覆盖本体里所有 Agent 动作，校验事件图，并在沙箱真实跑通事件链。`;

  if (/[/\\]|\.\./.test(domain)) {
    return new Response(JSON.stringify({ error: "invalid domain" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: unknown) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { /* closed */ }
      };
      // keepalive so proxies don't drop the long-lived stream
      const hb = setInterval(() => { try { controller.enqueue(enc.encode(": hb\n\n")); } catch {} }, 15_000);
      try {
        for await (const ev of runBrain({ domain, goal, tools: ALL_TOOLS })) send(ev);
      } catch (e) {
        send({ t: "error", message: (e as Error).message });
      } finally {
        clearInterval(hb);
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
