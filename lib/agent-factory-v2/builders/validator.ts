/**
 * validator.ts — Plan 4 Chunk C
 *
 * Static event-graph closure check for GeneratedAgentSpec[].
 * No LLM calls — pure deterministic validation.
 */

import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

/** Regex for terminal-looking event names that are expected to have no consumers.
 *  Includes *_MISSING / *_ERROR (e.g. RESUME_INFO_MISSING, RESUME_PARSE_ERROR) —
 *  these are legitimate dead-end outcomes, not unwired mid-chain events. */
const TERMINAL_RE = /FAIL|SENT|GENERATED|CHECKED|CONFLICT|PASSED_NO|REJECTED|DONE|MISSING|ERROR/i;

/** An issue tied to a specific agent — so the brain can target redesign at the
 *  right agent slug instead of text-matching event names against spec.emit. */
export interface AgentIssue {
  kind:
    | "dangling-emit"
    | "orphan-trigger"
    | "no-tools"
    | "slug-collision"
    // P2 — ontology-grounded checks (only emitted when validateSpecs is given the
    // ontology context). uncovered-agent-action = an actor=Agent ontology action
    // with no spec (the failure that silently dropped the rule-check agent);
    // ungrounded-event = a spec trigger/emit event no ontology action declares.
    | "uncovered-agent-action"
    | "ungrounded-event"
    // fully-AI: a committed spec running a hardcoded TEMPLATE prompt (the LLM
    // authored nothing) is not a real agent — it must fail, not silently ship.
    | "fallback-prompt";
  event?: string;
  agentSlug: string;
  agentAction: string;
  message: string;
}

/** P2 — optional ontology context. When supplied, validateSpecs additionally
 *  checks the generated spec set against the AUTHORITATIVE ontology (completeness
 *  + event groundedness), not just against itself. Omitted → behavior unchanged. */
export interface ValidateOptions {
  /** ontology actions (need .name + .actor) — enables the coverage check. */
  agentActions?: ReadonlyArray<{ name: string; actor: string[] }>;
  /** authoritative event vocabulary (union of all ontology trigger/emit names) —
   *  enables the ungrounded-event check. */
  knownEvents?: string[];
  /** events the USER has classified as legitimate boundary events (external handoff
   *  or terminal) — they have no internal consumer ON PURPOSE, so they must NOT be
   *  flagged as dangling/broken. (project: boundary-event HITL.) */
  boundaryEvents?: string[];
}

export interface ValidationResult {
  ok: boolean;
  danglingEmits: string[];
  orphanTriggers: string[];
  emptyToolAgents: string[];
  slugCollisions: string[];
  issues: string[];
  /** NEW: agent-targeted issues. The brain reads agentIssueMap[slug] to know
   *  WHICH agent to refine_agent on, without parsing summary strings. */
  agentIssueMap: Record<string, AgentIssue[]>;
  /** NEW: structured issue list (every issue carries its agent owner). */
  structuredIssues: AgentIssue[];
}

/**
 * Statically validate the event-graph closure of a set of GeneratedAgentSpec.
 *
 * - danglingEmits: events produced by agents but consumed by none, AND not
 *   terminal-looking (non-terminal dangling = likely wiring bug).
 * - orphanTriggers: events consumed by agents but produced by none (informational;
 *   some are legitimate entry points from the outside world).
 * - emptyToolAgents: specs with 0 tools (agents that would do no work).
 * - slugCollisions: duplicate slug values across specs.
 * - ok: true only when no danglingEmits, no emptyToolAgents, no slugCollisions.
 */
export function validateSpecs(specs: GeneratedAgentSpec[], opts: ValidateOptions = {}): ValidationResult {
  const issues: string[] = [];
  const structuredIssues: AgentIssue[] = [];

  // Build event→agents indexes BEFORE iterating issues, so each issue knows
  // exactly which agent owns the offending event.
  const producedBy = new Map<string, GeneratedAgentSpec[]>();
  const consumedBy = new Map<string, GeneratedAgentSpec[]>();
  for (const spec of specs) {
    for (const ev of spec.emit) {
      if (!ev || ev === "—") continue;
      (producedBy.get(ev) ?? producedBy.set(ev, []).get(ev)!).push(spec);
    }
    for (const ev of spec.trigger) {
      if (!ev || ev === "—") continue;
      (consumedBy.get(ev) ?? consumedBy.set(ev, []).get(ev)!).push(spec);
    }
  }
  const produced = new Set(producedBy.keys());
  const consumed = new Set(consumedBy.keys());

  // danglingEmits: produced but not consumed AND not terminal-looking. Tie to
  // the agent(s) that produced the event so the brain can refine_agent on them.
  // Events the user classified as boundary (external handoff / terminal) are
  // intentionally consumer-less and excluded here — not broken chains.
  const boundarySet = new Set(opts.boundaryEvents ?? []);
  const danglingEmits: string[] = [];
  for (const ev of produced) {
    if (!consumed.has(ev) && !TERMINAL_RE.test(ev) && !boundarySet.has(ev)) {
      danglingEmits.push(ev);
      for (const owner of producedBy.get(ev) ?? []) {
        structuredIssues.push({
          kind: "dangling-emit",
          event: ev,
          agentSlug: owner.slug,
          agentAction: owner.actionName,
          message: `agent「${owner.actionName}」(${owner.slug}) 发出事件 ${ev}，但没有任何 agent 消费它（不是终态事件）`,
        });
      }
    }
  }

  // orphanTriggers: consumed but not produced. Tie to the agent(s) that
  // listen for it — they need an upstream producer or to remove this trigger.
  const orphanTriggers: string[] = [];
  for (const ev of consumed) {
    if (!produced.has(ev)) {
      orphanTriggers.push(ev);
      for (const consumer of consumedBy.get(ev) ?? []) {
        structuredIssues.push({
          kind: "orphan-trigger",
          event: ev,
          agentSlug: consumer.slug,
          agentAction: consumer.actionName,
          message: `agent「${consumer.actionName}」(${consumer.slug}) 监听事件 ${ev}，但没有任何 agent 产出它（可能是外部入口，也可能是设计缺漏）`,
        });
      }
    }
  }

  // emptyToolAgents: specs with 0 tools — agent identity is itself.
  const emptyToolAgents: string[] = [];
  for (const s of specs) {
    if (s.tools.length === 0) {
      const id = s.short || s.slug || s.key;
      emptyToolAgents.push(id);
      structuredIssues.push({
        kind: "no-tools",
        agentSlug: s.slug,
        agentAction: s.actionName,
        message: `agent「${s.actionName}」(${s.slug}) 没绑任何工具，不会做任何工作`,
      });
    }
  }

  // slugCollisions: duplicate slugs across multiple specs.
  const slugCounts = new Map<string, number>();
  for (const spec of specs) {
    slugCounts.set(spec.slug, (slugCounts.get(spec.slug) ?? 0) + 1);
  }
  const slugCollisions = [...slugCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([slug]) => slug);
  for (const slug of slugCollisions) {
    for (const s of specs.filter((s) => s.slug === slug)) {
      structuredIssues.push({
        kind: "slug-collision",
        agentSlug: slug,
        agentAction: s.actionName,
        message: `slug ${slug} 冲突（多个 agent 重名）`,
      });
    }
  }

  // P2 coverage: every actor=Agent ontology action must have a covering spec.
  // The checklist is re-derived from the live ontology (adaptive, per-domain);
  // this is the deterministic completeness gate that catches a silently-omitted
  // agent (e.g. the rule-check agent) which the wiring checks above cannot see —
  // a node that was never generated simply isn't in the spec graph.
  const uncoveredActions: string[] = [];
  if (opts.agentActions) {
    const coveredActions = new Set(specs.map((s) => s.actionName));
    for (const a of opts.agentActions) {
      if (!a.actor.includes("Agent")) continue;
      if (coveredActions.has(a.name)) continue;
      uncoveredActions.push(a.name);
      structuredIssues.push({
        kind: "uncovered-agent-action",
        agentSlug: "(missing)",
        agentAction: a.name,
        message: `本体动作「${a.name}」是 Agent 动作，但没有任何 agent 实现它——必须为它 design_agent`,
      });
    }
  }

  // P2 groundedness: a spec trigger/emit event that no ontology action declares
  // (a hallucinated event). Checked against the authoritative event vocabulary.
  const ungroundedEvents: string[] = [];
  if (opts.knownEvents) {
    const known = new Set(opts.knownEvents);
    for (const s of specs) {
      for (const ev of [...s.trigger, ...s.emit]) {
        if (!ev || ev === "—" || known.has(ev)) continue;
        ungroundedEvents.push(ev);
        structuredIssues.push({
          kind: "ungrounded-event",
          event: ev,
          agentSlug: s.slug,
          agentAction: s.actionName,
          message: `agent「${s.actionName}」(${s.slug}) 引用事件 ${ev}，但本体里没有任何动作声明它（疑似幻觉事件）`,
        });
      }
    }
  }

  // Fully-AI: reject any committed spec whose prompt is a hardcoded fallback
  // template. The brain must author the prompt; a template-backed agent is a
  // band-aid, not a real agent.
  const fallbackPromptAgents: string[] = [];
  for (const s of specs) {
    if (s.promptSource === "fallback") {
      fallbackPromptAgents.push(s.actionName);
      structuredIssues.push({
        kind: "fallback-prompt",
        agentSlug: s.slug,
        agentAction: s.actionName,
        message: `agent「${s.actionName}」(${s.slug}) 的 system prompt 是回退模板（LLM 没有亲自撰写）——必须由大脑现写，不能用兜底模板`,
      });
    }
  }

  // Group structured issues by agent for fast lookup by the brain.
  const agentIssueMap: Record<string, AgentIssue[]> = {};
  for (const iss of structuredIssues) {
    (agentIssueMap[iss.agentSlug] ??= []).push(iss);
  }

  // Build flat issues strings (back-compat for any caller still reading them).
  if (danglingEmits.length > 0) issues.push(`Dangling emits (non-terminal events with no consumer): ${danglingEmits.join(", ")}`);
  if (orphanTriggers.length > 0) issues.push(`Orphan triggers (events with no producer, may be external entry points): ${orphanTriggers.join(", ")}`);
  if (emptyToolAgents.length > 0) issues.push(`Agents with 0 tools (would do no work): ${emptyToolAgents.join(", ")}`);
  if (slugCollisions.length > 0) issues.push(`Duplicate slugs: ${slugCollisions.join(", ")}`);

  if (uncoveredActions.length > 0) issues.push(`Uncovered Agent actions (no spec): ${uncoveredActions.join(", ")}`);
  if (ungroundedEvents.length > 0) issues.push(`Ungrounded events (not in ontology): ${ungroundedEvents.join(", ")}`);

  if (fallbackPromptAgents.length > 0) issues.push(`Fallback-template prompts (LLM authored nothing): ${fallbackPromptAgents.join(", ")}`);

  const ok =
    danglingEmits.length === 0 &&
    emptyToolAgents.length === 0 &&
    slugCollisions.length === 0 &&
    uncoveredActions.length === 0 &&
    ungroundedEvents.length === 0 &&
    fallbackPromptAgents.length === 0;

  return {
    ok,
    danglingEmits,
    orphanTriggers,
    emptyToolAgents,
    slugCollisions,
    issues,
    agentIssueMap,
    structuredIssues,
  };
}
