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
    if (!isFinalAttempt) return; // will retry — not terminal yet
    const finishedAtIso = new Date().toISOString();
    const output = {
      error: { name: error?.name, message: error?.message, stack: error?.stack },
    };
    try {
      const event = this.event(ctx);
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
