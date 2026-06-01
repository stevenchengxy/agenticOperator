// Ontology → agent analyzer.
//
// Per spec 2026-06-02 §4.3: every action in a domain's ontology becomes a
// derived agent. Actions whose actor includes "Agent" are real LLM agents
// (kind="llm"); the rest are "simulated-human" auto-responders that stand in
// for a person so the event chain runs end-to-end without a real human.
//
// This replaces the hand-written candidates in profiles.ts — the candidates are
// now derived 1:1 from the real ontology actions, with real trigger→emit edges.

import type { DomainOntology, OntologyAction, OntologyEvent } from "./ontology-source";

export type DerivedAgentKind = "llm" | "simulated-human";

export type DerivedAgent = {
  /** Stable selection id = action name. */
  key: string;
  /** camelCase action name, e.g. "forecastOutput" — also the logger nodeId. */
  actionName: string;
  /** Inngest function id + AgentVersion.slug, e.g. "energy-forecast-output". */
  slug: string;
  /** AgentVersion.short + logger agent name, e.g. "ForecastOutputAgent". */
  short: string;
  nameZh: string;
  nameEn: string;
  descZh: string;
  descEn: string;
  kind: DerivedAgentKind;
  /** Consumed event names (no domain prefix). */
  triggerEvents: string[];
  /** Emitted event names (no domain prefix). */
  emitEvents: string[];
  /** Domain tool names (simulated at runtime). */
  tools: string[];
  /** Object label ids this action reads/writes. */
  objects: string[];
  systemPrompt: string;
  userPrompt: string;
  rationaleZh: string;
  rationaleEn: string;
  /** 0..100 — heuristic display confidence. */
  confidence: number;
};

const SLUG_PREFIX: Record<string, string> = {
  "nengyuandiaodu-v1": "energy",
  "baoxiao-v1": "feikong",
};

function slugPrefix(domainId: string): string {
  return SLUG_PREFIX[domainId] ?? domainId.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function camelToKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

function pascal(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** First sentence / clause of the action description, for a compact card title. */
function shortNameZh(action: OntologyAction): string {
  const desc = (action.description ?? "").trim();
  if (!desc) return action.category ?? action.name;
  // take up to the first Chinese/ASCII sentence break, capped.
  const cut = desc.split(/[，。:：\n(（]/)[0]?.trim() ?? desc;
  return cut.length > 18 ? cut.slice(0, 18) : cut || (action.category ?? action.name);
}

function isAgentActor(action: OntologyAction): boolean {
  return (action.actor ?? []).some((a) => a.toLowerCase() === "agent");
}

/** Build the set of events that have at least one consumer (any action.trigger). */
function consumedEventSet(actions: OntologyAction[]): Set<string> {
  const s = new Set<string>();
  for (const a of actions) for (const e of a.trigger ?? []) s.add(e);
  return s;
}

/**
 * Derive one agent per action. Pure — safe on server and client.
 */
export function deriveAgents(onto: DomainOntology): DerivedAgent[] {
  const consumed = consumedEventSet(onto.actions);
  const prefix = slugPrefix(onto.domainId);

  return onto.actions.map((action) => {
    const kind: DerivedAgentKind = isAgentActor(action) ? "llm" : "simulated-human";
    const trigger = action.trigger ?? [];
    const emit = action.triggered_event ?? [];

    // 「本体依据」: which emitted events are dangling (no downstream consumer)
    // motivates wiring this agent into the chain.
    const dangling = emit.filter((e) => !consumed.has(e));
    const rationaleZh =
      kind === "llm"
        ? `事件 ${trigger.join("/") || "(入口)"} 触发本动作并产出 ${emit.join("/") || "(无)"}` +
          (dangling.length ? `;${dangling.join("/")} 下游暂无消费者` : "")
        : `人工动作 ${action.name},模拟自动产出 ${emit.join("/") || "(无)"} 以闭合链路`;
    const rationaleEn =
      kind === "llm"
        ? `${trigger.join("/") || "(entry)"} triggers this action emitting ${emit.join("/") || "(none)"}`
        : `human action ${action.name}, simulated to auto-emit ${emit.join("/") || "(none)"}`;

    return {
      key: action.name,
      actionName: action.name,
      slug: `${prefix}-${camelToKebab(action.name)}`,
      short: `${pascal(action.name)}Agent`,
      nameZh: shortNameZh(action),
      nameEn: action.name,
      descZh: (action.description ?? "").trim().slice(0, 80) || shortNameZh(action),
      descEn: action.name,
      kind,
      triggerEvents: trigger,
      emitEvents: emit,
      tools: action.tool_use ?? [],
      objects: action.target_objects ?? [],
      systemPrompt: action.system_prompt ?? "",
      userPrompt: action.user_prompt ?? "",
      rationaleZh,
      rationaleEn,
      confidence: kind === "llm" ? 92 : 80,
    };
  });
}

/** Look up the event definition (for payload schema) by bare name. */
export function findEvent(onto: DomainOntology, name: string): OntologyEvent | undefined {
  return onto.events.find((e) => e.name === name);
}
