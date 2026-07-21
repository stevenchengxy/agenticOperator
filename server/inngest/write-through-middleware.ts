// Inngest middleware: write-through persistence of events + runs into the
// Postgres archive, in-process, the instant they happen. This makes events and
// runs durable across Inngest dev-server restarts without waiting for the 30s
// poller. Hooks are best-effort and MUST never throw into a run or a send.
// See lib/inngest-archive/write-through.ts for the actual DB writes.
import { Middleware } from "inngest";
import {
  recordSentEvents,
  recordRunStart,
  recordRunFinish,
  captureRunTrace,
} from "../../lib/inngest-archive/write-through";
import { recordLogEvent } from "../log/log-event";
import { recordNotification } from "../notifications/ingest";

function warn(where: string, e: unknown): void {
  console.warn(`[write-through] ${where}:`, e instanceof Error ? e.message : e);
}

export class WriteThroughMiddleware extends Middleware.BaseMiddleware {
  readonly id = "ao-write-through";

  // Inngest's function slug is app-prefixed: `${appId}-${fnId}`
  // (see lib/inngest-source.test.ts). client.id is the app id.
  private slug(fn: { id: () => string }): string {
    return `${this.client.id}-${fn.id()}`;
  }

  private event(ctx: { event?: unknown }): {
    id?: string;
    name?: string;
    data?: unknown;
    ts?: number;
    received_at?: string;
    sourceApp?: string | null;
    source_app?: string | null;
  } | undefined {
    return ctx.event && typeof ctx.event === "object"
      ? (ctx.event as ReturnType<WriteThroughMiddleware["event"]>)
      : undefined;
  }

  async onRunStart({ ctx, fn }: Middleware.OnRunStartArgs): Promise<void> {
    try {
      const event = this.event(ctx);
      await recordRunStart({
        runId: ctx.runId,
        functionSlug: this.slug(fn),
        functionName: fn.name,
        startedAtIso: new Date().toISOString(),
        appId: this.client.id,
        eventName: event?.name,
        eventId: event?.id,
        event,
      });
    } catch (e) {
      warn("onRunStart", e);
    }
  }

  async onRunComplete({ ctx, fn, output }: Middleware.OnRunCompleteArgs): Promise<void> {
    const finishedAtIso = new Date().toISOString();
    try {
      const event = this.event(ctx);
      await recordRunFinish({
        runId: ctx.runId,
        functionSlug: this.slug(fn),
        functionName: fn.name,
        status: "Completed",
        finishedAtIso,
        output,
        appId: this.client.id,
        eventName: event?.name,
        eventId: event?.id,
        eventData: event?.data,
      });
    } catch (e) {
      warn("onRunComplete", e);
    }
    void captureRunTrace({ runId: ctx.runId, status: "Completed", output, finishedAtIso }).catch(
      (e) => warn("captureRunTrace", e),
    );
  }

  async onRunError({ ctx, fn, error, isFinalAttempt }: Middleware.OnRunErrorArgs): Promise<void> {
    const event = this.event(ctx);
    const functionId = fn.id();
    const nonRetriable = error?.name === "NonRetriableError";
    const payloadJson = JSON.stringify({
      error: { name: error?.name, message: error?.message, stack: error?.stack },
      final_attempt: isFinalAttempt,
      function_id: functionId,
      function_slug: this.slug(fn),
      event_name: event?.name ?? null,
      event_id: event?.id ?? null,
    });

    // Non-final failures are not alerts yet: Inngest still owns recovery. Keep a
    // structured retry row in the unified audit log so operators can prove that
    // automatic retry happened instead of seeing an unexplained time gap.
    if (!isFinalAttempt) {
      try {
        await recordLogEvent({
          type: "step.retrying",
          source: "inngest",
          agent: functionId,
          runId: ctx.runId,
          eventName: event?.name,
          message: `${fn.name} 执行失败，Inngest 将自动重试: ${error?.message ?? "unknown error"}`,
          payloadJson,
        });
      } catch (e) {
        warn("onRunError.retry-log", e);
      }
      return;
    }

    const finishedAtIso = new Date().toISOString();
    const output = {
      error: { name: error?.name, message: error?.message, stack: error?.stack },
    };
    try {
      await recordRunFinish({
        runId: ctx.runId,
        functionSlug: this.slug(fn),
        functionName: fn.name,
        status: "Failed",
        finishedAtIso,
        output,
        appId: this.client.id,
        eventName: event?.name,
        eventId: event?.id,
        eventData: event?.data,
      });
    } catch (e) {
      warn("onRunError", e);
    }
    void captureRunTrace({ runId: ctx.runId, status: "Failed", output, finishedAtIso }).catch((e) =>
      warn("captureRunTrace", e),
    );

    // Every terminal Inngest failure gets both a queryable error row and one
    // deduped in-app alert linked to the run. Agent-local loggers remain useful
    // for richer context, but notification coverage no longer depends on each
    // handler remembering to emit `handler.error`.
    try {
      await recordLogEvent({
        type: "agent_error",
        source: "inngest",
        agent: functionId,
        runId: ctx.runId,
        eventName: event?.name,
        message: `${fn.name} 终态失败: ${error?.message ?? "unknown error"}`,
        payloadJson,
      });
      await recordNotification({
        level: "error",
        category: "agent_error",
        source: fn.name || functionId,
        agent: functionId,
        runId: ctx.runId,
        message: `${fn.name || functionId} ${
          nonRetriable ? "永久错误（无需重试）" : "自动重试耗尽后失败"
        }: ${error?.message ?? "unknown error"}`,
        dedupeHint: `inngest_run_failed.${this.slug(fn)}`,
      });
    } catch (e) {
      warn("onRunError.terminal-observability", e);
    }
  }

  async wrapSendEvent({
    events,
    next,
  }: Middleware.WrapSendEventArgs): Promise<Awaited<ReturnType<Middleware.WrapSendEventArgs["next"]>>> {
    const out = await next();
    try {
      await recordSentEvents(
        events.map((e) => ({
          name: e.name,
          data: e.data,
          ts: e.ts,
          sourceApp: this.client.id,
        })),
        out?.ids ?? [],
      );
    } catch (e) {
      warn("wrapSendEvent", e);
    }
    return out;
  }
}
