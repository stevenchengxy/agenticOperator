// Ontology agent factory (shared by the energy + 费控 runnable packs).
//
// Turns one DerivedAgent spec into a real Inngest function. Most actions run as
// an LLM pass-through (kind=llm) or a simulated-human auto-responder; a few
// declare a deterministic `Behavior` (see each domain's behaviors.ts) — the
// rule-check steps and the human gates — and the factory runs that instead of
// the LLM.
//
// Domain-agnostic: the per-domain behaviors, dataset summary, dedupe prefix and
// Inngest client all arrive via `opts`/`client`, so 能源调度 and 费控 share this
// one factory. Helpers in ./is-active ./run-state ./sim-tools ./structured-output
// are likewise domain-agnostic.
//
// Handler shape:
//   event_received → dedup/depth/branch/self-gate → behavior? compute (+ gate:
//   notify + waitForEvent + route) : (simulate tools → LLM → parse) → merge the
//   scenario dataset + upstream payload onto each emitted event → sendEvent →
//   done. Everything is logged via the file logger (→ AgentActivity + /audit).

import type { Inngest } from "inngest";
import { inngest } from "@/server/inngest/client";
import { prisma } from "@/server/db";
import { chatComplete } from "@/server/llm/gateway";
import { recordNotification } from "@/server/notifications/ingest";
import { createAgentLogger, runWithLogger } from "@/lib/agent-logger";
import type { DerivedAgent } from "@/lib/ontology-generator/analyze";
import { isAgentActive } from "./is-active";
import { simulateTools, toolResultsForPrompt } from "./sim-tools";
import { buildSchemaHint, parseOrSynthesize } from "./structured-output";
import { claimOnce, releaseClaim, MAX_CHAIN_DEPTH } from "./run-state";
import type {
  AgentFactoryOpts,
  Behavior,
  Envelope,
  HumanDecision,
} from "@/server/inngest/agent-factory/types";

export type { AgentFactoryOpts } from "@/server/inngest/agent-factory/types";

function unwrap<TData>(data: unknown): Envelope<TData> {
  if (data && typeof data === "object") return data as Envelope<TData>;
  return {};
}

const LLM_TIMEOUT_MS = Number(process.env.ENERGY_LLM_TIMEOUT_MS ?? 10_000);

async function safeLlm(system: string, user: string): Promise<string> {
  try {
    const res = await Promise.race([
      chatComplete({ system, user, temperature: 0.2, maxTokens: 700 }),
      new Promise<{ text: string }>((_, reject) => setTimeout(() => reject(new Error("llm-timeout")), LLM_TIMEOUT_MS)),
    ]);
    return (res as { text?: string }).text ?? "";
  } catch {
    return "";
  }
}

// Best-effort WorkflowRun lifecycle. Energy runs get a real WorkflowRun row
// (caseId = WorkflowRun.id, created by /api/ontology-generator/run), so keep its
// status in sync → /monitor shows 挂起/完成 instead of a perpetual "运行中".
// updateMany never throws on a missing row (synthetic caseId), and the whole
// thing is wrapped soft-fail so it can never block the agent chain.
async function setRunStatus(
  caseId: string,
  status: "running" | "suspended" | "completed",
  opts?: { suspendedReason?: string | null; completed?: boolean },
): Promise<{ status: string }> {
  try {
    await prisma.workflowRun.updateMany({
      where: { id: caseId },
      data: {
        status,
        lastActivityAt: new Date(),
        ...(opts?.suspendedReason !== undefined ? { suspendedReason: opts.suspendedReason } : {}),
        ...(opts?.completed ? { completedAt: new Date() } : {}),
      },
    });
  } catch {
    /* no WorkflowRun row / DB hiccup → ignore, chain proceeds */
  }
  return { status };
}

// `client` lets the same factory build functions for EITHER the main app
// (default) or a per-domain app (server/inngest/domain-app.ts passes the
// domain's own Inngest client) — Inngest events are global to the dev server,
// so cross-app trigger/emit/waitForEvent all work regardless of which app a
// function is registered under.
export function makeOntologyAgent<TData = unknown>(
  spec: DerivedAgent,
  opts: AgentFactoryOpts<TData>,
  client: Inngest = inngest,
) {
  const { domainId, eventNs, seedEvent, eventsByName, objectNameById, branchActions } = opts;
  const behavior: Behavior<TData> | undefined = opts.behaviors[spec.actionName];
  const isTerminal = !!opts.terminalActions?.has(spec.actionName);
  const dedupePrefix = opts.dedupeHintPrefix ?? `${eventNs}_human_gate`;

  const triggerNames = behavior?.triggerOverride?.length
    ? behavior.triggerOverride
    : spec.triggerEvents.length > 0
      ? spec.triggerEvents
      : null;
  const triggers = triggerNames ? triggerNames.map((e) => ({ event: `${eventNs}/${e}` })) : [{ event: seedEvent }];

  return client.createFunction(
    { id: spec.slug, name: `${spec.nameZh} · ${spec.short}`, retries: 0, triggers },
    async ({ event, step }: any) => {
      const data = unwrap<TData>(event.data);
      const caseId = data.caseId ?? `case-${spec.actionName}`;
      const depth = typeof data._depth === "number" ? data._depth : 0;
      const enableBranches = data.enableBranches === true;
      const dataset = (data.dataset ?? null) as TData | null;
      const scenario = data.scenario ?? "happy";
      const upstream = (data.payload ?? {}) as Record<string, unknown>;
      const dsFromData = (dataset as { dsNo?: unknown } | null)?.dsNo;
      const dsNo = typeof dsFromData === "string" ? dsFromData : typeof upstream.dsNo === "string" ? upstream.dsNo : "DS?";

      const logger = createAgentLogger({ agent: spec.short, runId: caseId, anchors: { action: spec.actionName, domain: domainId } });

      return runWithLogger(logger, async () => {
        logger.event("event_received", { trigger: event.name, case_id: caseId, depth, kind: spec.kind, scenario, source_action: data.source_action ?? "(seed)" });

        if (depth > MAX_CHAIN_DEPTH) {
          logger.event("skip", { reason: "max-depth", depth });
          return { skipped: "max-depth" };
        }
        if (branchActions.has(spec.actionName) && !enableBranches) {
          logger.event("skip", { reason: "branch-disabled", action: spec.actionName });
          return { skipped: "branch-disabled" };
        }
        const first = await step.run("claim-once", () => claimOnce(`${domainId}:${caseId}:${spec.actionName}`));
        if (!first) {
          logger.event("skip", { reason: "already-ran-this-case", case_id: caseId });
          return { skipped: "already-ran" };
        }
        const active = await step.run("gate", () => isAgentActive(domainId, spec.short));
        if (!active) {
          logger.event("skip", { reason: "not-deployed", short: spec.short });
          return { skipped: "not-deployed" };
        }

        // Emit one downstream event with the dataset threaded + upstream payload
        // accumulated + this step's new fields merged on top.
        const emitOne = async (emitName: string, extra: Record<string, unknown>) => {
          await step.sendEvent(`emit-${emitName}`, {
            name: `${eventNs}/${emitName}`,
            data: { caseId, domainId, _depth: depth + 1, enableBranches, source_action: spec.actionName, dataset, scenario, payload: { ...upstream, ...extra } },
          });
          logger.event("event_emitted", { name: emitName, case_id: caseId });
        };

        // ── deterministic behavior (rule-check / gate) ───────────────────────
        if (behavior) {
          const result = await behavior.compute({ caseId, dsNo, scenario, dataset, upstream, logger, step });

          if (result.skip) {
            logger.event("skip", { reason: result.skipReason ?? "behavior-skip", action: spec.actionName });
            return { skipped: result.skipReason ?? "behavior-skip" };
          }

          if (result.gate) {
            const g = result.gate;
            const captureCategory = g.category === "event" ? "event_publish" : "agent_lifecycle";
            // Memoized: runs once even though the handler re-executes on resume.
            await step.run("notify-gate", async () => {
              await recordNotification({
                level: "critical",
                category: captureCategory,
                source: g.source,
                agent: spec.short,
                domain: domainId,
                message: `${g.title}\n${g.body}`,
                runId: caseId,
                anchors: g.anchors,
                eventName: g.category === "event" ? `${eventNs}/${spec.emitEvents[0] ?? "RISK"}` : undefined,
                dedupeHint: `${dedupePrefix}.${g.gateKey}.${caseId}`,
              });
              logger.event("gate_opened", { gate: g.gateKey, case_id: caseId, riskType: g.riskType, riskLevel: g.riskLevel, note: "已落 AO 人工待办,挂起等人工决定" });
              return g.gateKey;
            });
            // Run lifecycle: this case is now waiting on a human → 挂起.
            await step.run("mark-suspended", () => setRunStatus(caseId, "suspended", { suspendedReason: `gate:${g.gateKey}` }));

            const decisionEvt = await step.waitForEvent(`await-${g.gateKey}`, {
              event: `${eventNs}/HUMAN_DECISION`,
              timeout: "30d",
              if: `async.data.caseId == "${caseId}" && async.data.gate == "${g.gateKey}"`,
            });
            if (!decisionEvt) {
              logger.event("gate_timeout", { gate: g.gateKey });
              return { skipped: "gate-timeout" };
            }
            const dec = (decisionEvt.data ?? {}) as HumanDecision;
            logger.event("gate_decided", { gate: g.gateKey, decision: dec.decision, operator: dec.operator ?? null, reason: dec.reason ?? null, edits: dec.edits ?? null });
            // Human decided → chain resumes → back to 运行中.
            await step.run("mark-running", () => setRunStatus(caseId, "running", { suspendedReason: null }));

            const routed = g.route(dec);
            if (routed.resetClaims) {
              for (const a of routed.resetClaims) {
                await step.run(`release-${a}`, () => {
                  releaseClaim(`${domainId}:${caseId}:${a}`);
                  return a;
                });
              }
            }
            for (const emitName of routed.emitEvents) await emitOne(emitName, routed.payload);
            logger.event("done", { action: spec.actionName, gate: g.gateKey, decision: dec.decision, emitted: routed.emitEvents });
            return { ok: true, gate: g.gateKey, decision: dec.decision };
          }

          const emits = result.emitEvents ?? spec.emitEvents;
          for (const emitName of emits) await emitOne(emitName, result.payloadByEvent?.[emitName] ?? result.payloadByEvent?.["*"] ?? {});
          if (isTerminal) await step.run("mark-completed", () => setRunStatus(caseId, "completed", { completed: true }));
          logger.event("done", { action: spec.actionName, emitted: emits });
          return { ok: true, emitted: emits };
        }

        // ── default path: simulate tools → LLM (or simulated-human) → parse ──
        const toolResults = simulateTools(spec.tools, spec.actionName);
        for (const r of toolResults) logger.apiCall(r.tool, { url: `sim://${domainId}/${encodeURIComponent(r.tool)}`, response: r, status: 200 });

        const objectCtx = spec.objects.map((id) => `${id}(${objectNameById.get(id) ?? id})`).join("、");
        let completion = "";
        if (spec.kind === "llm") {
          const primaryEvt = eventsByName.get(spec.emitEvents[0] ?? "");
          const brief = opts.datasetBrief?.(dataset) ?? "";
          const userPrompt =
            `${spec.userPrompt}\n\n【场景】${scenario}｜案件 ${dsNo}\n【上游事件载荷】${JSON.stringify(upstream)}\n` +
            (brief ? `【本案数据集摘要】${brief}\n` : "") +
            `【工具结果(模拟)】\n${toolResultsForPrompt(toolResults)}\n【相关对象】${objectCtx || "(无)"}\n\n${buildSchemaHint(primaryEvt)}`;
          completion = await step.run("llm", () => safeLlm(spec.systemPrompt, userPrompt));
          if (completion) logger.event("decision", { action: spec.actionName, llm_chars: completion.length });
          else logger.event("anomaly", { stage: "llm", note: "LLM 网关不可达/超时,降级为按事件 schema 合成载荷" });
        } else {
          logger.event("decision", { action: spec.actionName, simulated_human: true, note: "模拟人工自动决定" });
        }

        for (const emitName of spec.emitEvents) {
          const evt = eventsByName.get(emitName);
          const { payload, synthesized } = parseOrSynthesize(completion, evt, spec.actionName);
          if (synthesized && spec.kind === "llm") logger.event("anomaly", { stage: "parse", emit: emitName, note: "合成载荷" });
          await emitOne(emitName, payload);
        }
        if (isTerminal) await step.run("mark-completed", () => setRunStatus(caseId, "completed", { completed: true }));
        logger.event("done", { action: spec.actionName, emitted: spec.emitEvents, tools: spec.tools.length });
        return { ok: true, emitted: spec.emitEvents };
      });
    },
  );
}
