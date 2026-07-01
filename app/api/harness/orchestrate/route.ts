// Meta-Orchestrator stream. Drives the streaming ReAct meta-brain ("conductor of
// conductors") over a domain and streams its reasoning + orchestration acts as SSE.
//   POST /api/harness/orchestrate {domain}
// The brain inspects the domain, plans build-vs-reuse, drives the factory for novel
// slots, validates the composed chain, resolves gaps, and grades against the
// 招聘-v1 gold standard.

import { runMetaBrain } from "@/lib/agent-harness/meta-brain/conductor";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: Request): Promise<Response> {
  let body: { domain?: string; goal?: string; dryRun?: boolean };
  try { body = await req.json(); } catch { body = {}; }
  const domain = body.domain ?? "Agents-generation";
  // dryRun nudges the brain to use placeholder generation (no LLM factory) so the
  // orchestration LOOP can be verified end-to-end fast. Default = real factory.
  const goal = body.dryRun
    ? `${body.goal ?? `为「${domain}」装配端到端连通的 agent 链,尽量复用、对标 招聘-v1 黄金标准。`}\n[本次为管路验证:generate_agents 一律传 dryRun=true,用占位生成,不要驱动真工厂。]`
    : body.goal;

  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort());

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: unknown) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { /* closed */ }
      };
      const hb = setInterval(() => { try { controller.enqueue(enc.encode(": hb\n\n")); } catch {} }, 15_000);
      try {
        for await (const ev of runMetaBrain({ domain, goal, signal: ac.signal })) {
          send(ev);
        }
      } catch (e) {
        if (!ac.signal.aborted) send({ t: "error", message: (e as Error).message });
      } finally {
        clearInterval(hb);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
