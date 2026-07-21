import { requireFactoryAuth } from "@/lib/factory-auth";
import { hasConversationDurable } from "@/lib/agent-factory-v3/brain/conversation-store";
import { startRun, subscribeRun, createBrainRun, readBrainRun } from "@/lib/agent-factory-v3/brain/run-registry";
import { P1_TOOLS } from "@/lib/agent-factory-v3/tools";
import { P2_TOOLS, P3_TOOLS } from "@/lib/agent-factory-v3/tools/p2-p3";
import { TOOL_SMITH_TOOLS } from "@/lib/agent-factory-v3/tools/tool-smith";
import { FRONT_DESK_TOOLS } from "@/lib/agent-factory-v3/tools/front-desk";

// FRONT_DESK_TOOLS first so the brain can answer informational questions (域/规则/
// 动作/事件) without running the generation pipeline — the intent-routing lane.
const ALL_TOOLS = [...FRONT_DESK_TOOLS, ...P1_TOOLS, ...P2_TOOLS, ...P3_TOOLS, ...TOOL_SMITH_TOOLS];

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * SSE stream of the autonomous Harness brain. One BrainEvent per `data:` frame —
 * think deltas, tool calls + results, created agents, validation, sandbox runs,
 * the final message. The chatbot renders these live (Claude/Codex-style).
 *
 * The brain now runs in a DETACHED background driver (lib/.../run-registry.ts), so
 * this route is a SUBSCRIBER: it attaches to the run's event stream and forwards
 * frames. A client disconnect just UNSUBSCRIBES — it no longer aborts the brain, so
 * the task keeps running while the user is on another page. Stop is explicit (the
 * /stop route). Three modes:
 *   · ?runId=<id>        — RECONNECT: re-attach to an in-flight (or finished) run.
 *   · ?convId=<id>&goal= — CONTINUE: resume the conversation with a new turn.
 *   · ?domain=&goal=     — NEW: start a fresh background run.
 *
 * Auth: Bearer / x-factory-token / ?token= (dev no-op when unset).
 */
export async function GET(req: Request): Promise<Response> {
  const denied = requireFactoryAuth(req, { allowQueryToken: true });
  if (denied) return denied;

  const url = new URL(req.url);
  const domain = url.searchParams.get("domain") ?? "recruit-gen-v1";
  const goal =
    url.searchParams.get("goal") ??
    `为「${domain}」域生成能真正跑通的 agents：覆盖本体里所有 Agent 动作，校验事件图，并在沙箱真实跑通事件链。`;
  // CHATBOT: a follow-up message carries the conversation id to RESUME (continue the
  // same brain ctx). RECONNECT: a runId re-attaches to a still-running background run.
  const convId = url.searchParams.get("convId") ?? "";
  const attachId = url.searchParams.get("runId") ?? "";

  if (/[/\\]|\.\./.test(domain)) {
    return new Response(JSON.stringify({ error: "invalid domain" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const enc = new TextEncoder();
  // Shared across start()/cancel() so a client disconnect (cancel) detaches the
  // subscriber WITHOUT aborting the background run.
  let closed = false;
  let unsub: null | (() => void) = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (hb) clearInterval(hb);
        try { unsub?.(); } catch { /* */ }
        try { controller.close(); } catch { /* */ }
      };
      const send = (e: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { /* closed */ }
        // A terminal `done` ends THIS client's stream (the run itself is already
        // finalized by the driver — closing here just stops the SSE).
        if (e && typeof e === "object" && (e as { t?: string }).t === "done") close();
      };
      // keepalive so proxies don't drop the long-lived stream
      hb = setInterval(() => { if (!closed) { try { controller.enqueue(enc.encode(": hb\n\n")); } catch { /* */ } } }, 15_000);

      // ── RECONNECT to an existing run ────────────────────────────────────────
      if (attachId) {
        unsub = subscribeRun(attachId, send);
        if (unsub) return; // live (or recently-finished) run in the registry — streaming now
        // Not in the registry → read the durable transcript (finished + evicted,
        // or interrupted by a server restart).
        const run = await readBrainRun(attachId);
        if (!run) { send({ t: "error", message: "找不到这个运行（可能已过期）。" }); close(); return; }
        // Durable replay: conversationId isn't stored on the row — fall back to the runId
        // (continuing after a long-evicted reconnect starts a fresh conversation; rare).
        send({ t: "run.started", runId: attachId, conversationId: attachId });
        for (const ev of run.transcript) send(ev);
        const endedWithDone = run.transcript.length > 0 && (run.transcript[run.transcript.length - 1] as { t?: string }).t === "done";
        if (run.status === "running") {
          // Orphaned by a restart: the row still says running but no live driver
          // exists. Tell the client it was interrupted so it can offer 继续.
          send({ t: "message", text: "⚠ 这个运行在服务器重启时中断了。上面是已生成的内容；点「继续」可从存档接着跑（或「重新开始」重跑）。" });
        }
        if (!endedWithDone) send({ t: "done", tokensUsed: 0, turns: 0, status: "incomplete" });
        close();
        return;
      }

      // ── NEW run or CONTINUE a conversation ──────────────────────────────────
      // Each TURN is its OWN run (fresh runId → its own driver + transcript). A follow-up
      // RESUMES the conversation via the STABLE conversationId — it must NOT reuse the
      // prior run's id: that hit startRun's idempotency guard, which returned the finished
      // prior run so subscribeRun just REPLAYED its greeting and the new message was
      // dropped (the 0-turn / 0-token "re-greet" bug). runId ≠ conversationId now.
      const resuming = !!convId && (await hasConversationDurable(convId));
      const runId = await createBrainRun(domain, goal);
      const conversationId = resuming ? convId : runId;
      startRun({ domain, goal, tools: ALL_TOOLS, runId, conversationId });
      unsub = subscribeRun(runId, send);
      if (!unsub) { send({ t: "error", message: "无法启动运行。" }); close(); }
    },
    // Client disconnected (navigated away / closed tab): JUST detach the subscriber.
    // The background run keeps going — that's the whole point. Stop is explicit (/stop).
    cancel() {
      closed = true;
      if (hb) clearInterval(hb);
      try { unsub?.(); } catch { /* */ }
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
