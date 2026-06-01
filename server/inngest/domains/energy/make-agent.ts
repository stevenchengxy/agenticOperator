// Ontology agent factory.
//
// Turns one DerivedAgent spec into a real Inngest function. Every agent in a
// domain is produced by this same factory — there is no per-agent bespoke code.
// Handler shape (per spec 2026-06-02 §4.4):
//   event_received → dedup/depth/branch/self-gate → simulate tools → (real LLM
//   for kind=llm) → parse-or-synthesize the emitted event payload → sendEvent →
//   done. Everything is logged via the file logger (bridged to AgentActivity +
//   /audit LogEvent).

import { inngest } from "@/server/inngest/client";
import { chatComplete } from "@/server/llm/gateway";
import { createAgentLogger, runWithLogger } from "@/lib/agent-logger";
import type { DerivedAgent } from "@/lib/ontology-generator/analyze";
import type { OntologyEvent, OntologyObject } from "@/lib/ontology-generator/ontology-source";
import { isAgentActive } from "./is-active";
import { simulateTools, toolResultsForPrompt } from "./sim-tools";
import { buildSchemaHint, parseOrSynthesize } from "./structured-output";
import { claimOnce, MAX_CHAIN_DEPTH } from "./run-state";

export type AgentFactoryOpts = {
  domainId: string;
  /** Seed event that kicks off entry agents (those with no trigger). */
  seedEvent: string;
  /** All domain events, by bare name — for emitted-payload schemas. */
  eventsByName: Map<string, OntologyEvent>;
  /** Object label id → display name, for context in the prompt. */
  objectNameById: Map<string, string>;
  /** Action names that form loops / branches — gated behind enableBranches. */
  branchActions: Set<string>;
};

type Envelope = {
  caseId?: string;
  domainId?: string;
  _depth?: number;
  enableBranches?: boolean;
  source_action?: string;
  payload?: Record<string, unknown>;
  simulated?: boolean;
};

function unwrap(data: unknown): Envelope {
  if (data && typeof data === "object") return data as Envelope;
  return {};
}

export function makeOntologyAgent(spec: DerivedAgent, opts: AgentFactoryOpts) {
  const { domainId, seedEvent, eventsByName, objectNameById, branchActions } = opts;

  const triggers =
    spec.triggerEvents.length > 0
      ? spec.triggerEvents.map((e) => ({ event: `${domainId}/${e}` }))
      : [{ event: seedEvent }];

  return inngest.createFunction(
    { id: spec.slug, name: `${spec.nameZh} · ${spec.short}`, retries: 1, triggers },
    async ({ event, step }: any) => {
      const data = unwrap(event.data);
      const caseId = data.caseId ?? `case-${spec.actionName}`;
      const depth = typeof data._depth === "number" ? data._depth : 0;
      const enableBranches = data.enableBranches === true;

      const logger = createAgentLogger({
        agent: spec.short,
        runId: caseId,
        anchors: { action: spec.actionName, domain: domainId },
      });

      return runWithLogger(logger, async () => {
        logger.event("event_received", {
          trigger: event.name,
          case_id: caseId,
          depth,
          kind: spec.kind,
          source_action: data.source_action ?? "(seed)",
        });

        // Depth cap (hard termination backstop).
        if (depth > MAX_CHAIN_DEPTH) {
          logger.event("skip", { reason: "max-depth", depth });
          return { skipped: "max-depth" };
        }

        // Branch/loop gate — keep the happy path linear & terminating.
        if (branchActions.has(spec.actionName) && !enableBranches) {
          logger.event("skip", { reason: "branch-disabled", action: spec.actionName });
          return { skipped: "branch-disabled" };
        }

        // Once-per-case dedup (memoized in a step so replays are deterministic).
        const first = await step.run("claim-once", () =>
          claimOnce(`${domainId}:${caseId}:${spec.actionName}`),
        );
        if (!first) {
          logger.event("skip", { reason: "already-ran-this-case", case_id: caseId });
          return { skipped: "already-ran" };
        }

        // Self-gate: deploy = activate. Undeployed agents ignore events.
        const active = await step.run("gate", () => isAgentActive(domainId, spec.short));
        if (!active) {
          logger.event("skip", { reason: "not-deployed", short: spec.short });
          return { skipped: "not-deployed" };
        }

        // Simulate the domain tools (external systems absent locally).
        const toolResults = simulateTools(spec.tools, spec.actionName);
        for (const r of toolResults) {
          logger.apiCall(r.tool, {
            url: `sim://${domainId}/${encodeURIComponent(r.tool)}`,
            response: r,
            status: 200,
          });
        }

        // Context objects for the prompt.
        const objectCtx = spec.objects
          .map((id) => `${id}(${objectNameById.get(id) ?? id})`)
          .join("、");

        // Real LLM call for actor=Agent; simulated-human responders skip it.
        const upstream = JSON.stringify(data.payload ?? {});
        let completion = "";
        if (spec.kind === "llm") {
          // Schema hint targets the first emitted event's payload.
          const primaryEvt = eventsByName.get(spec.emitEvents[0] ?? "");
          const userPrompt =
            `${spec.userPrompt}\n\n【上游事件载荷】${upstream}\n` +
            `【工具结果(模拟)】\n${toolResultsForPrompt(toolResults)}\n` +
            `【相关对象】${objectCtx || "(无)"}\n\n${buildSchemaHint(primaryEvt)}`;
          try {
            const res = await step.run("llm", () =>
              chatComplete({
                system: spec.systemPrompt,
                user: userPrompt,
                temperature: 0.2,
                maxTokens: 700,
              }),
            );
            completion = (res as { text?: string }).text ?? "";
            logger.event("decision", {
              action: spec.actionName,
              llm_chars: completion.length,
            });
          } catch (err) {
            logger.event("anomaly", {
              stage: "llm",
              error: (err as Error).message,
              note: "降级为按事件 schema 合成载荷",
            });
          }
        } else {
          logger.event("decision", {
            action: spec.actionName,
            simulated_human: true,
            note: "模拟人工自动决定",
          });
        }

        // Emit each downstream event with a complete payload.
        for (const emitName of spec.emitEvents) {
          const evt = eventsByName.get(emitName);
          const { payload, synthesized } = parseOrSynthesize(completion, evt, spec.actionName);
          if (synthesized && spec.kind === "llm") {
            logger.event("anomaly", { stage: "parse", emit: emitName, note: "合成载荷" });
          }
          await step.sendEvent(`emit-${emitName}`, {
            name: `${domainId}/${emitName}`,
            data: {
              caseId,
              domainId,
              _depth: depth + 1,
              enableBranches,
              source_action: spec.actionName,
              payload,
              simulated: spec.kind !== "llm",
            },
          });
          logger.event("event_emitted", { name: emitName, case_id: caseId });
        }

        logger.event("done", {
          action: spec.actionName,
          emitted: spec.emitEvents,
          tools: spec.tools.length,
        });
        return { ok: true, emitted: spec.emitEvents };
      });
    },
  );
}
