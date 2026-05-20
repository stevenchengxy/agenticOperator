// stub-factory.ts — single factory that turns an AgentMeta into a real
// Inngest function for demo / dev end-to-end wiring.
//
// Every business agent in AGENT_MAP gets one stub function that:
//   1. Receives any of the agent's triggersEvents
//   2. Extracts / creates a stable runId from event.data._runId
//   3. Upserts a WorkflowRun row (idempotent across cascade)
//   4. Writes AgentActivity via agent-logger (event_received, agent_start,
//      [hitl], event_emitted, agent_complete)
//   5. Simulates work with a small randomised delay (200-1500 ms via step.sleep)
//   6. For HITL agents: creates a HumanTask row, then auto-resolves after a
//      configurable demo delay (default 5 s, env STUB_HITL_DELAY_MS)
//   7. Emits one of emitsEvents via em.publish, propagating _runId so the
//      entire run chain stays coherent
//   8. For terminal agents: calls markRunComplete
//
// Env knobs:
//   STUB_AGENTS=0          — disable all stubs (default: enabled)
//   STUB_SUCCESS_RATE=0.9  — probability of picking the "success" emit path
//   STUB_HITL_DELAY_MS=5000 — ms before a HITL task auto-resolves

import { randomUUID } from "node:crypto";
import { inngest } from "@/server/inngest/client";
import { em } from "@/server/em";
import {
  createAgentLogger,
  ensureWorkflowRun,
  markRunComplete,
} from "@/server/agent-logger";
import type { AgentMeta } from "@/lib/agent-mapping";
import { prisma } from "@/server/db";

// ── Config ────────────────────────────────────────────────────────────────

const STUB_MIN_DELAY_MS = 200;
const STUB_MAX_DELAY_MS = 1500;
const HITL_AUTO_RESOLVE_MS = parseInt(
  process.env.STUB_HITL_DELAY_MS ?? "5000",
  10,
);
const STUB_SUCCESS_RATE = parseFloat(
  process.env.STUB_SUCCESS_RATE ?? "0.9",
);
const STUB_ENABLED = process.env.STUB_AGENTS !== "0"; // default ON

type EventData = Record<string, unknown> & { _runId?: string };

// ── Factory ───────────────────────────────────────────────────────────────

export function createStubAgent(meta: AgentMeta) {
  if (meta.triggersEvents.length === 0) {
    // Nothing to listen to — skip (e.g. Chatbot which has no trigger events)
    return null;
  }

  // Inngest function id — must be stable across restarts (used as registry key)
  const fnId = `agent.${meta.short.toLowerCase()}`;

  // Build the triggers list from the agent's declared triggersEvents.
  // Inngest v4 API: createFunction({ id, triggers: [...] }, handler)
  // (v3 used three arguments; v4 merges triggers into the options object)
  const triggers = meta.triggersEvents.map((name) => ({ event: name }));

  return inngest.createFunction(
    { id: fnId, name: meta.short, triggers },
    async ({ event, step }) => {
      if (!STUB_ENABLED) {
        return { skipped: true };
      }

      // ── Throttle check (Phase 2 Manage axis) ─────────────────────────────
      // Step 0: read throttle config in its own step so the result is
      // serializable and Inngest can replay it correctly after a sleep.
      const throttleMs = await step.run("read-throttle", async () => {
        const cfg = await prisma.agentConfig
          .findUnique({ where: { id: meta.short } })
          .catch(() => null);
        if (!cfg?.throttleUntil) return 0;
        const ms = new Date(cfg.throttleUntil).getTime() - Date.now();
        // Cap at 5 minutes so stubs don't stall indefinitely
        return ms > 0 ? Math.min(ms, 5 * 60 * 1000) : 0;
      });

      // Step 1: sleep if throttled.
      // IMPORTANT: step.sleep must be called at the TOP LEVEL of the handler
      // (not inside step.run) so Inngest can interrupt and resume correctly.
      if (throttleMs > 0) {
        await step.sleep("throttle-wait", `${throttleMs}ms`);
        await step.run("log-throttle", async () => {
          console.info(
            `[stub-factory] ${meta.short} honored throttle ${throttleMs}ms`,
          );
        });
      }

      const eventData = (event.data ?? {}) as EventData;
      // _runId propagated from earlier agents; fall back to Inngest event id
      // then a fresh UUID. event.id may be undefined in tests.
      const runId: string =
        (typeof eventData._runId === "string" && eventData._runId
          ? eventData._runId
          : undefined) ??
        (typeof event.id === "string" && event.id ? event.id : undefined) ??
        randomUUID();

      // 1. Ensure WorkflowRun row (upsert — idempotent on replay)
      await step.run("ensure-run", () =>
        ensureWorkflowRun({
          runId,
          triggerEvent: event.name,
          triggerData: {
            agent: meta.short,
            event: event.name,
            ...eventData,
          },
        }),
      );

      const log = createAgentLogger({
        agent: meta.short,
        nodeId: meta.wsId,
        runId,
      });

      // 2. Log event received + agent start
      await step.run("log-receive", async () => {
        await log.event("event_received", `Received ${event.name}`, {
          eventId: event.id,
        });
        await log.log("agent_start", `${meta.short} started processing`, {});
      });

      // 3. Simulate work with random delay
      const delay =
        Math.floor(
          Math.random() * (STUB_MAX_DELAY_MS - STUB_MIN_DELAY_MS),
        ) + STUB_MIN_DELAY_MS;
      await step.sleep("simulate-work", `${delay}ms`);

      // 4. HITL handling — create HumanTask, auto-resolve after demo delay
      if (meta.kind === "hitl") {
        const taskId = await step.run("create-hitl-task", async () => {
          const task = await prisma.humanTask.create({
            data: {
              runId,
              nodeId: meta.wsId,
              nodeName: meta.short,
              title: `${meta.short}: please review`,
              payload: JSON.stringify({
                triggerEvent: event.name,
                eventData,
              }),
              status: "pending",
            },
          });
          await log.hitl(`HITL task created: ${task.id}`, {
            taskId: task.id,
          });
          return task.id;
        });

        // Auto-resolve after configurable demo delay
        await step.sleep(
          "hitl-auto-resolve",
          `${HITL_AUTO_RESOLVE_MS}ms`,
        );

        await step.run("resolve-hitl", async () => {
          await prisma.humanTask.update({
            where: { id: taskId },
            data: {
              status: "approved",
              completedAt: new Date(),
              resolvedBy: "stub-auto",
            },
          });
          await log.log("info", `HITL task auto-resolved (demo)`, {
            taskId,
          });
        });
      }

      // 5. Decide outcome (success vs failure path)
      const isSuccess = Math.random() < STUB_SUCCESS_RATE;
      const emitChoices = meta.emitsEvents;

      if (emitChoices.length === 0) {
        // Terminal / no downstream — mark complete and exit
        await step.run("mark-complete", async () => {
          await log.done(`${meta.short} completed (terminal)`, {
            durationMs: delay,
          });
          if (meta.terminal) await markRunComplete(runId, "completed");
        });
        return { runId, terminal: true };
      }

      // Pick emit: success → first choice (happy path); failure → last choice
      // (by convention the failure/rejection variant is listed last in emitsEvents)
      const nextEventName = isSuccess
        ? emitChoices[0]
        : emitChoices[emitChoices.length - 1];

      await step.run("emit-next", async () => {
        await log.event(
          "event_emitted",
          `Emitting ${nextEventName}`,
          { nextEventName, isSuccess },
        );
        await em.publish(
          nextEventName,
          { _runId: runId, source: meta.short, isSuccess } as EventData,
          {
            source: `stub.${meta.short.toLowerCase()}`,
            causedBy: {
              eventId: event.id ?? "",
              name: event.name,
            },
          },
        );
        await log.done(
          `${meta.short} done in ${delay}ms`,
          { durationMs: delay, emitted: nextEventName },
        );
        if (meta.terminal) await markRunComplete(runId, "completed");
      });

      return { runId, emitted: nextEventName };
    },
  );
}
