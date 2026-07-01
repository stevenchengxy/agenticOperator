// The Harness brain's tool/action space (P1). Each is a deterministic, reliable
// capability the autonomous brain decides when to call. The brain provides the
// intelligence (what to build, when to validate/run, how to react to failures);
// these tools provide the reliable execution.

import { fetchLiveOntologyStrict, type OntologyAction } from "@/lib/ontology-generator/ontology-source";
import { resolveRegistry, sandboxDomainFor } from "@/lib/tools/resolve-registry";
import { selectToolsForAction, resolveToolName, suggestToolsForAction, groundToolPicks, toolSignature, type ToolRegistry } from "@/lib/tools/registry";
import { registerPersistedInto } from "@/lib/tools/persisted-tools";
import { hasPendingHumanMsg } from "@/lib/agent-factory-v3/brain/mailbox";
import { reviewSpecsDeterministic, type ReviewFinding } from "../review";
import { deriveContractGraph, contractIssueStrings, contractAgentIssueMap } from "../contract";
import { chatComplete, isGatewayConfigured } from "@/server/llm/gateway";
import { validateAgentCode } from "@/lib/agent-factory-v3/codegen";
import { loadSkills } from "@/lib/agent-factory-v3/skills-library";
import { kebab, pascal, slugifyDomain, inferRetries } from "@/lib/agent-factory-gen/generate";
import { syncDomainDrafts } from "@/lib/agent-factory-gen/persist";
import { validateSpecs } from "@/lib/agent-factory-v2/builders/validator";
import { shipAgents, fireAndObserve } from "@/lib/agent-factory-v2/deploy";
import { proposeTestCases, generate_test_cases } from "./test-cases";
import { collectAgentRuns } from "./agent-io";
import { FACTORY_STRONG_MODEL } from "../brain/stream-gateway";
// NOTE: the agent-harness registry/selection are LAZY-imported inside read_ontology
// (not at module load) — building PRESET_AGENTS does sync source-file scans, which we
// don't want to pay on every tools import, only when read_ontology actually runs.
import { prisma } from "@/server/db";
import type { GeneratedAgentSpec, IoField } from "@/lib/agent-factory-gen/types";

/** RANK-1: a deterministic fingerprint of the specs that ran in a sandbox, so the
 *  finish gate can detect "spec changed since the last green sandbox" (stale-green)
 *  and force a re-run. Equality-comparison string (no crypto needed). */
/** cheap stable djb2 hash (no Date/random) — folds code content into the fingerprint
 *  so any code edit (even same signature) invalidates stale-green sandbox evidence. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
export function specsFingerprint(specs: GeneratedAgentSpec[]): string {
  return specs
    .map((s) => `${s.slug}|${(s.trigger ?? []).join(",")}|${(s.emit ?? []).join(",")}|${(s.tools ?? []).join(",")}|${s.codeSource ?? ""}|${djb2(s.generatedCode ?? "")}`)
    .sort()
    .join(";");
}

/** RANK-4: flag ALL_CAPS_UNDERSCORE event-like tokens in free text (prompt /
 *  decision logic / code) that aren't in the ontology's known events — the
 *  brain's hallucination vector (writing RESUME_PARSED when the real event is
 *  RESUME_PROCESSED). A WARNING, not a hard block, to avoid false positives on
 *  legit constants; the behavioral sandbox gate is the hard backstop. */
const EVENT_TOKEN_ALLOW = new Set(["SYSTEM_PROMPT", "JSON", "TODO", "FIXME", "HTTP", "HTTPS", "API", "URL", "URI", "UUID", "SQL", "CSV", "PDF", "AI"]);
function ungroundedEventTokens(texts: string[], knownEvents: Set<string>): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of (t || "").matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
      const tok = m[0];
      if (!EVENT_TOKEN_ALLOW.has(tok) && !knownEvents.has(tok)) found.add(tok);
    }
  }
  return [...found];
}

/** A rule-check / dedup / risk gate — the ONLY agent kind that deals with rules,
 *  and it does so by FETCHING them at runtime (binding ontology.fetchActionRules),
 *  never by baking rule text into a prompt. */
function isRuleCheckGate(s: GeneratedAgentSpec): boolean {
  return (
    s.tools.includes("ontology.fetchActionRules") ||
    /rule.?check|校验|审核|风控|合规|查重|去重|dedup|lock|黑名单|blacklist/i.test(s.actionName)
  );
}

/** Parse the LLM's input_schema / output_schema arg into typed IoField[]. */
function parseIoSchema(v: unknown): IoField[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { field?: unknown }).field === "string")
    .map((x) => ({
      field: String(x.field),
      type: String(x.type ?? "String"),
      description: x.description ? String(x.description) : undefined,
      source: x.source ? String(x.source) : undefined,
    }));
}
import type { BrainTool, BrainCtx, AgentCardLite, BuildPlan, RefineAttempt, BoundaryProposal } from "../brain/types";

const REASONING = {
  reasoning: { type: "string", description: "一句话说明你为什么现在调用这个工具(会作为你的思考展示给用户)" },
} as const;
function params(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties: { ...REASONING, ...props }, required: ["reasoning", ...required] };
}

/** Persist a FailureReflection with typed-then-raw-SQL fallback. Dev server's
 *  Prisma client predates the model after HMR cycles (typed accessor is
 *  undefined); raw SQL writes to the underlying table directly. Returns the
 *  path used ('typed' | 'raw') so callers can log diagnostics. Throws on
 *  genuine DB errors so callers can choose to swallow or surface. */
async function writeReflectionRow(data: {
  domain: string;
  kind: string;
  summary: string;
  rootCause: string | null;
  lesson: string;
  ranAgents?: string | null;
  failedAgent?: string | null;
}): Promise<"typed" | "raw"> {
  const pc = prisma as unknown as { failureReflection?: { create: (args: unknown) => Promise<unknown> } };
  if (pc.failureReflection?.create) {
    await pc.failureReflection.create({ data });
    return "typed";
  }
  const id = "fr_" + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "FailureReflection" ("id","domain","kind","summary","rootCause","lesson","ranAgents","failedAgent","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    id,
    data.domain,
    data.kind,
    data.summary,
    data.rootCause,
    data.lesson,
    data.ranAgents ?? null,
    data.failedAgent ?? null,
  );
  return "raw";
}

// R4-3: relevance-match each agent action to up to 5 business rules from the
// ontology. Rules carry `relatedEntities` (e.g. "外包招聘需求 (Job_Requisition_Specification)");
// actions carry `target_objects` (id or CJK label). We extract any parenthesized
// id from each rule's relatedEntities and intersect with target_objects. Rules
// with more overlap rank first. Fail-soft: if rule fields are missing the rule
// is simply skipped, so a half-populated ontology doesn't break read_ontology.
function pickRelevantRulesPerAction(
  actions: OntologyAction[],
  rules: Record<string, unknown>[],
): Map<string, Array<{ id: string; name: string; rule: string; enforcement: string; failurePolicy: string }>> {
  const byAction = new Map<string, Array<{ id: string; name: string; rule: string; enforcement: string; failurePolicy: string; relevance: number }>>();
  for (const action of actions) byAction.set(action.name, []);

  // Extract ids and CJK names mentioned in each rule's relatedEntities.
  // Forms seen in production: "外包招聘需求 (Job_Requisition_Specification)" (CJK + id)
  // or "RAAS系统(RAAS_System)" (CJK + id no space) — strip parens for the id.
  for (const rule of rules) {
    const related = Array.isArray(rule.relatedEntities) ? (rule.relatedEntities as string[]) : [];
    if (!related.length) continue;
    const mentionedIds = new Set<string>();
    const mentionedNames = new Set<string>();
    for (const entry of related) {
      const m = entry.match(/\(([^)]+)\)/);
      if (m) mentionedIds.add(m[1].trim());
      // Also keep the CJK prefix (chars before " (" or "(")
      const cjk = entry.split(/[(（]/)[0].trim();
      if (cjk) mentionedNames.add(cjk);
    }
    if (!mentionedIds.size && !mentionedNames.size) continue;

    const ruleInfo = {
      id: typeof rule.id === "string" ? rule.id : "",
      name: typeof rule.businessLogicRuleName === "string" ? rule.businessLogicRuleName : "",
      rule: typeof rule.standardizedLogicRule === "string" ? rule.standardizedLogicRule.slice(0, 240) : "",
      enforcement: typeof rule.enforcementLevel === "string" ? rule.enforcementLevel : "optional",
      failurePolicy: typeof rule.failurePolicy === "string" ? rule.failurePolicy : "warn",
    };

    for (const action of actions) {
      // Count overlap by id (high signal) and by CJK name (lower signal).
      let relevance = 0;
      for (const obj of action.target_objects) {
        if (mentionedIds.has(obj)) relevance += 2;
        else if (mentionedNames.has(obj)) relevance += 1;
        // Also: action.name itself might be referenced in rule's scenarioStage
        // — surfaces process-stage rules for the right step.
        const stage = typeof rule.specificScenarioStage === "string" ? rule.specificScenarioStage : "";
        if (stage && stage.includes(obj)) relevance += 1;
      }
      if (relevance > 0) {
        const arr = byAction.get(action.name)!;
        arr.push({ ...ruleInfo, relevance });
      }
    }
  }

  // Rank within each action: most-relevant first, terminal/fail-close rules
  // surface even at modest relevance because they're decision gates the brain
  // MUST encode. Cap at 5 per action so the prompt doesn't bloat.
  const result = new Map<string, Array<{ id: string; name: string; rule: string; enforcement: string; failurePolicy: string }>>();
  for (const [actionName, candidates] of byAction.entries()) {
    candidates.sort((a, b) => {
      const aTerminal = a.failurePolicy === "terminal" || a.enforcement === "mandatory" ? 1 : 0;
      const bTerminal = b.failurePolicy === "terminal" || b.enforcement === "mandatory" ? 1 : 0;
      if (aTerminal !== bTerminal) return bTerminal - aTerminal;
      return b.relevance - a.relevance;
    });
    result.set(actionName, candidates.slice(0, 5).map(({ relevance: _r, ...rest }) => { void _r; return rest; }));
  }
  return result;
}

function cardOf(s: GeneratedAgentSpec): AgentCardLite {
  return { slug: s.slug, short: s.short, nameZh: s.nameZh, trigger: s.trigger, emit: s.emit, tools: s.tools, unresolved: s.unresolvedTools };
}

type SpecExtras = {
  skills?: Array<{ name: string; purpose: string; promptFragment: string; tools: string[]; decisionRule: string }>;
  research?: Array<{ query: string; findings: string }>;
  extraTools?: string[];
  /** The LLM's per-agent design (deep generation). When present its authored
   *  system prompt + tool selection + decision logic drive the spec, instead of
   *  the deterministic ontology template — that's what makes generation "real". */
  authored?: { systemPrompt?: string; tools?: string[]; decisionLogic?: string };
  /** AI-authored I/O field schemas, grounded in the action's DataObjects. */
  inputSchema?: IoField[];
  outputSchema?: IoField[];
  /** R4-3: business rules matched to this action (from read_ontology relevance
   *  match). Mandatory / terminal-failure rules are woven into the runtime
   *  agent prompt so the deployed agent encodes the constraints at decision time. */
  relevantRules?: Array<{ id: string; name: string; rule: string; enforcement: string; failurePolicy: string }>;
  /** Fix #2: catalog tools pre-matched to this action (suggestToolsForAction).
   *  Used as a FLOOR — when the LLM's authored picks all fail to resolve, the
   *  agent is equipped with these real tools instead of binding zero, so it has
   *  hands to actually call APIs. */
  suggestedTools?: string[];
};

/** Build a runnable GeneratedAgentSpec for an ontology action. Trigger / emit /
 *  objects are ontology FACTS; the system prompt + tool selection + decision
 *  logic come from the LLM's `authored` design when provided (deep generation),
 *  else fall back to the ontology prompt / a template (so it never breaks). Also
 *  weaves in brain-authored skills + web research. */
export function buildSpecFromAction(action: OntologyAction, domain: string, registry: ToolRegistry, extras?: SpecExtras): GeneratedAgentSpec {
  const authored = extras?.authored;
  // Tools: the LLM's authored selection drives, BUT the ontology's declared
  // tool_use is authoritative and always unioned in (P1b) — so e.g. a rule-check
  // action that declares ontology.fetchActionRules always binds it, even if the
  // LLM's authored picks forgot it. For actions with empty tool_use (most),
  // sel.tools is [] so this is a no-op and the LLM's selection stands.
  const sel = selectToolsForAction(action, registry);
  const authoredResolved = (authored?.tools ?? [])
    .map((t) => resolveToolName(t, registry))
    .filter((t): t is string => !!t);
  const baseTools = authored?.tools?.length ? authoredResolved : sel.tools;
  const skillTools = (extras?.skills ?? []).flatMap((s) => s.tools);
  const extraTools = extras?.extraTools ?? [];
  let tools = [...new Set([...sel.tools, ...baseTools, ...[...extraTools, ...skillTools].filter((t) => registry.has(t))])];
  const unresolved = authored?.tools?.length
    ? authored.tools.filter((t) => !resolveToolName(t, registry))
    : [...sel.unresolved, ...extraTools.filter((t) => !registry.has(t))];
  // Fully-AI: NO silent tool FLOOR. The brain must pick the agent's tools from
  // the real library (read_ontology surfaces per-action suggested_tools as
  // VISIBLE candidates, and design_agent's schema enum constrains picks to real
  // names). If the brain under-picks, that surfaces as a validation failure
  // (0-tool agent), not an auto-filled toolset — we never guess tools it didn't
  // choose. (`extras.suggestedTools` is retained on the type for the read_ontology
  // surfacing path but is deliberately NOT used to auto-equip here.)
  const designedPrompt = authored?.systemPrompt && authored.systemPrompt.trim() ? authored.systemPrompt.trim() : "";
  let sys =
    designedPrompt ||
    action.system_prompt ||
    // live actions carry no system_prompt but a rich `description` (the behavioral
    // spec) — use it as the seed so even the deterministic floor is grounded, not a
    // generic name template.
    (action.description && action.description.trim()) ||
    `你是「${action.name}」agent。当收到事件 ${action.trigger.join(" / ") || "(入口)"} 时执行 ${action.name}，` +
      `完成后发出 ${action.triggered_event.join(" 或 ") || "(终态)"}。`;
  if (authored?.decisionLogic && authored.decisionLogic.trim()) {
    sys += "\n\n【分支决策逻辑】\n" + authored.decisionLogic.trim();
  }
  if (extras?.skills?.length) {
    sys += "\n\n【可复用技能】\n" + extras.skills.map((s) => `- ${s.name}（${s.purpose}）：${s.promptFragment}${s.decisionRule ? ` 决策：${s.decisionRule}` : ""}`).join("\n");
  }
  if (extras?.research?.length) {
    sys += "\n\n【领域研究参考(联网得到)】\n" + extras.research.map((r) => r.findings).join("\n").slice(0, 900);
  }
  // R4-3 (scoped by P1c): business rules belong to the rule-check GATE, not to
  // every agent. A rule-check agent FETCHES its rules live from the ontology
  // (Action→step→Rule) via ontology.fetchActionRules — rules change + there are
  // hundreds, so baking them into the prompt is wrong (stale + conflates
  // concerns into downstream agents like matchResume). So: only rule-check
  // agents get rule context, and as a DYNAMIC-FETCH instruction, not static
  // text. Detection: the agent binds the fetch tool, or its action name reads
  // as a rule check. Downstream agents trust the gate and carry no rule text.
  // NOTE: rule-check agents are NOT special-cased here anymore. We used to append
  // a hardcoded "rule-check mechanism" block to their prompt — but that's a static
  // template stitched onto an otherwise AI-authored prompt, which violates the
  // "fully-AI, no hardcoded prompt text" principle. Instead, read_ontology flags
  // the action as `is_rule_check` and the design_agent tool tells the brain to
  // AUTHOR the fetch-rules-by-payload → check → fail-close mechanism into the
  // prompt itself. So the whole prompt is the LLM's, not partly ours.
  const usr = action.user_prompt || `处理当前案例的数据并产出结果，按业务规则决定发出哪个事件。`;
  const steps = (tools.length ? tools : ["process"]).map((tool, i) => ({
    name: tool.split(".").pop() || `step${i + 1}`,
    description: tools.includes(tool) ? `调用 ${tool}` : "处理",
    tool: tools.includes(tool) ? tool : undefined,
  }));
  const spec: GeneratedAgentSpec = {
    key: action.name,
    actionName: action.name,
    slug: `${slugifyDomain(domain)}-${kebab(action.name)}`,
    short: `${pascal(action.name)}Agent`,
    domainId: domain,
    nameZh: action.name,
    kind: action.actor.includes("Human") ? "simulated-human" : "llm",
    trigger: action.trigger,
    emit: action.triggered_event,
    tools,
    unresolvedTools: unresolved,
    objects: action.target_objects,
    systemPrompt: sys,
    userPrompt: usr,
    steps,
    ruleRefs: [],
    retries: inferRetries(tools),
    hitl: action.actor.includes("Human"),
    confidence: designedPrompt ? 0.9 : (action.system_prompt || action.description) ? 0.85 : 0.6,
    promptSource: designedPrompt ? "llm" : action.system_prompt ? "ontology" : action.description ? "ontology-desc" : "fallback",
    toolFlow: "parallel",
    inputSchema: extras?.inputSchema?.length ? extras.inputSchema : undefined,
    outputSchema: extras?.outputSchema?.length ? extras.outputSchema : undefined,
  };
  // RULE-CHECK MECHANISM FLOOR. An agent the review treats as a rule-check/dedup/
  // lock GATE (isRuleCheckGate) MUST fetch its rules at runtime, never bake them
  // into the prompt. Both Sonnet AND gemini consistently ignore the (already strong)
  // design instruction and hardcode rules, so the event contract NEVER closed —
  // the same "规则校验闸口没接上动态抓规则" finding every run. Deterministically
  // GUARANTEE the mechanism: bind ontology.fetchActionRules + append the four
  // dynamic-fetch steps the review checks for. We inject the MECHANISM, never the
  // rules (rules stay live-fetched), so this respects "rules are never hardcoded".
  if (isRuleCheckGate(spec)) {
    if (!spec.tools.includes("ontology.fetchActionRules") && registry.has("ontology.fetchActionRules")) {
      spec.tools.push("ontology.fetchActionRules");
      spec.unresolvedTools = spec.unresolvedTools.filter((t) => t !== "ontology.fetchActionRules");
    }
    if (!/fetchActionRules|动态抓取规则|实时抓取规则/i.test(spec.systemPrompt)) {
      spec.systemPrompt +=
        "\n\n【规则动态抓取机制（系统强制补全——规则随客户/时间会变，以实时抓取为准，不要依赖本 prompt 里写死的任何具体规则）】\n" +
        "① 从触发事件的 payload 识别本次要校验的对象与上下文（候选人/JR/客户/部门等）；\n" +
        "② 绑定并调用 ontology.fetchActionRules 按【当前 action + payload 上下文】实时抓取适用规则；\n" +
        "③ 逐条核对，命中任一强制(mandatory)规则即发出失败事件并落库；\n" +
        "④ 数据不足时 fail-close 保守拦截。";
    }
  }
  // NO deterministic render fallback. The agent's .ts is written ENTIRELY by the
  // LLM via codegen_agent (codeSource="ai", TS-compiler validated); until then
  // generatedCode stays empty, and the finish gate refuses to ship an agent
  // without AI-written code. (specToAgentCode is kept as a dev/test utility only.)
  return spec;
}

const read_ontology: BrainTool = {
  name: "read_ontology",
  description:
    "读取业务域的本体：对象、动作(actions，每个含 trigger 消费事件 / triggered_event 发出事件 / tool_use 工具)、事件、规则。先调用它来理解这个域需要造哪些 agent、怎么串联。",
  parameters: params({ kind: { type: "string", enum: ["all", "actions"], description: "读哪部分，默认 all" } }),
  async execute(_args, ctx) {
    // LIVE Allmeta → Neo4j ONLY. No snapshot fallback: if the live read fails,
    // the factory must NOT silently build on stale local data — it blocks.
    let ont: Awaited<ReturnType<typeof fetchLiveOntologyStrict>>;
    if (ctx.ontology) {
      ont = ctx.ontology;
    } else {
      try {
        ont = await fetchLiveOntologyStrict(ctx.domain);
      } catch (e) {
        ctx.emit({ t: "error", message: (e as Error).message });
        return {
          ok: false,
          summary: `❌ ${(e as Error).message}\n生成已阻断——请修好后用「＋ 开新会话」重试(不会回退本地 snapshot)。`,
        };
      }
    }
    ctx.ontology = ont;
    ctx.registry = ctx.registry ?? resolveRegistry(ctx.domain, ont);
    // Tool-Smith's AI-created tools live in the persistent library; fold the APPROVED
    // ones for this domain into the registry so they show up in availableTools and the
    // brain can bind them just like hand-written tools.
    try { await registerPersistedInto(ctx.registry, ctx.domain); } catch { /* library optional */ }
    const agentActions = ont.actions.filter((a) => a.actor.includes("Agent"));
    // Fully-AI: fail loudly on an empty/unloadable ontology instead of silently
    // "succeeding" on 0 actions. Zero actor=Agent actions means the domain is
    // empty OR the ontology source couldn't be read — either way there is nothing
    // real to generate, so the run must not proceed to a fake finish.
    if (agentActions.length === 0) {
      return {
        ok: false,
        summary: `本体「${ctx.domain}」里没有任何 actor=Agent 的动作（来自 ${ont.source}，共 ${ont.actions.length} 个动作）——可能是域为空或本体加载失败。无法生成 agent，请检查域 id / Allmeta 连接，不要继续。`,
        output: { domain: ctx.domain, source: ont.source, totalActions: ont.actions.length, agentActions: 0 },
      };
    }
    // R4-3: For each agent action, surface up to 5 most relevant business rules
    // so the brain can encode the constraints in its prompt. Match rules by
    // relatedEntities ∩ target_objects (id form OR CJK name form). Without
    // this, the brain only saw "261 rules" as a count — invisible context.
    const rulesByAction = pickRelevantRulesPerAction(agentActions, ont.rules);
    // Cache on ctx so design_agent / refine_agent can weave mandatory rules
    // into the deployed agent's runtime prompt without re-running the match.
    ctx.rulesByAction = {};
    for (const [k, v] of rulesByAction.entries()) ctx.rulesByAction[k] = v;
    // Fix #2: pre-match the REAL catalog to each action so the brain picks
    // concrete namespaced names (robohire.parseResume) instead of inventing
    // lexical variants (parseResumeFile) that bind nothing. Cached on ctx so
    // design_agent / refine_agent floor the agent with these when the LLM's
    // picks don't resolve.
    ctx.suggestedToolsByAction = {};
    for (const a of agentActions) {
      ctx.suggestedToolsByAction[a.name] = suggestToolsForAction(a, ctx.registry, 5);
    }
    // ④ REUSE: score the agent registry (preset ∪ previously-generated) ONCE, then
    // suggest a reusable agent per action by event-signature match. A sandbox-proven
    // generated agent whose signature fits this action should be REUSED (reuse_agent),
    // not re-designed from scratch — that's the intelligent + cheap move. Only
    // `generated` candidates carry a full spec to adopt; `handwritten` are informational.
    const reusableByAction: Record<string, { agentId: string; name: string; score: number; source: string; reusable: boolean; why: string }> = {};
    try {
      const [{ listRegistryAgents }, { selectFromAgents }] = await Promise.all([
        import("@/lib/agent-harness/registry"),
        import("@/lib/agent-harness/selection"),
      ]);
      // Bounded: never let a slow/absent DB stall read_ontology — cap the registry
      // read and skip reuse on timeout (reuse is an enhancement, not a dependency).
      const registry = await Promise.race([
        listRegistryAgents(ctx.domain),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("registry-timeout")), 4000)),
      ]);
      for (const a of agentActions) {
        const sel = selectFromAgents(registry, {
          triggerEvents: a.trigger,
          emitEvents: a.triggered_event,
          domain: ctx.domain,
          capability: `${a.name} ${a.description ?? ""}`.slice(0, 200),
        });
        if (sel.decision === "reuse" && sel.best) {
          reusableByAction[a.name] = {
            agentId: sel.best.id,
            name: sel.best.name,
            score: sel.candidates[0]?.score ?? 0,
            source: sel.best.source,
            reusable: sel.best.source === "generated", // only generated agents can be adopted as specs
            why: sel.reason,
          };
        }
      }
    } catch { /* registry optional — never block read_ontology on it */ }
    // DataObject lookup (by name + id) → the field schemas the brain GROUNDS its
    // AI-authored input/output schema on (each action carries its target objects'
    // properties: {name, type, description}).
    const objIndex = new Map<string, (typeof ont.objects)[number]>();
    for (const o of ont.objects) { objIndex.set(o.name, o); if (o.id) objIndex.set(o.id, o); }
    const actions = agentActions.map((a) => {
      const relevantRules = rulesByAction.get(a.name) ?? [];
      // A rule-check gate = an action that has business rules attached and/or
      // reads as a rule check. The brain AUTHORS its prompt to fetch rules
      // dynamically (no hardcoded rule block in our code) — see design_agent.
      const isRuleCheck = /rule.?check/i.test(a.name) || (relevantRules.length > 0 && /check|校验|审核|风控|合规/i.test(a.name));
      return {
        name: a.name,
        // The action's FULL behavioral spec — the single richest generation signal
        // (what the agent does, which real APIs/edge-cases, how it branches). Live
        // actions carry NO system_prompt, only this; it was being dropped, forcing
        // the brain to infer behavior from the name. design_agent authors the prompt
        // FROM this, grounded.
        description: a.description,
        trigger: a.trigger,
        emit: a.triggered_event,
        tools: a.tool_use,
        // Fix #2: concrete catalog candidates the brain should pick from (by
        // exact name). Replaces guessing — these are guaranteed to resolve.
        suggested_tools: ctx.suggestedToolsByAction[a.name],
        // BUSINESS I/O (DataObject-grounded), straight from the ontology action.
        // The agent's input/output schema starts HERE (tool I/O is separate, in the
        // catalog). inputs carry source_object (e.g. resume_file_path ← Resume.file_path).
        inputs: a.inputs,
        outputs: a.outputs,
        // preconditions that must hold before the agent runs.
        submission_criteria: a.submission_criteria,
        // ontology authored a prompt OR a rich description to author from.
        has_prompt: !!(a.system_prompt || a.description),
        // The DataObjects this action touches — names only; full property schemas
        // are in the top-level `dataObjects` dict (RANK-2: keeps each action small
        // so ALL agentActions survive in context instead of the list truncating).
        target_objects: a.target_objects,
        // If true, the brain must author a DYNAMIC rule-fetch prompt for this
        // agent (fetch by payload → check → fail-close), binding
        // ontology.fetchActionRules — NOT list any rules statically.
        is_rule_check: isRuleCheck,
        // ONLY a count, never the rule TEXT. Surfacing the actual rules here was
        // the leak: the LLM saw them and baked them into prompts (matchResume etc.)
        // despite the instruction. Now even rule-check gates only learn "there are
        // N rules" → they FETCH them at runtime via ontology.fetchActionRules.
        // No agent's prompt ever sees rule text.
        rule_count: relevantRules.length,
        // ④ a previously-built agent whose event signature fits this action. When
        // present + reusable, prefer reuse_agent(action, agent_id) over re-designing.
        reusable_agent: reusableByAction[a.name],
      };
    });
    // The domain's tool library — what the brain can compose from. The registry
    // is ALREADY domain-scoped (resolveRegistry picked it), so list() (no filter)
    // is the full library; filtering by ctx.domain would wrongly drop tools whose
    // descriptor domain is "recruit"/"*". When actions carry no tool_use (live
    // Allmeta domains don't), the brain binds these via generate_agents.extra_tools.
    // Also surfaced to the UI's 工具库.
    const catalog = ctx.registry.list().map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      sideEffect: t.sideEffect,
      signature: toolSignature(t),
      // FULL external-platform I/O contract (the args it takes + the shape it
      // returns) — e.g. robohire.parseResume returns data.{skills,workHistory,
      // gender,endDate,…}. This is where external I/O lives; the brain reads it to
      // map a tool's OUTPUT onto the action's BUSINESS output. Previously only the
      // one-line `signature` was surfaced, hiding the real fields.
      parameters: t.parameters,
      returns: t.returns,
      // The native import line so AI-written code (codegen_agent) can call the
      // real tool (e.g. `import { parseResume } from "@/lib/tools/robohire"`).
      import: t.impl ? `import { ${t.impl.export} } from "${t.impl.module}"` : undefined,
    }));
    ctx.emit({ t: "catalog", tools: catalog });
    // Reusable SKILLS sedimented by prior runs (this domain + general). The brain
    // can use_skill to adopt one instead of re-deriving it — compounding know-how.
    const reusableSkills = (await loadSkills(ctx.domain).catch(() => []))
      .map((s) => ({ name: s.name, slug: s.slug, purpose: s.purpose, domain: s.domain, useCount: s.useCount }));

    // Derived event-flow DIGEST — give the brain the real STRUCTURE to analyze
    // (chains, gates, entry/terminal, orphans), not just counts, so it actually
    // reasons about how the domain wires together before it plans.
    const emitsAll = new Set<string>();
    const triggersAll = new Set<string>();
    for (const a of agentActions) { for (const t of a.trigger) triggersAll.add(t); for (const e of a.triggered_event) emitsAll.add(e); }
    const entryEvents = [...triggersAll].filter((t) => !emitsAll.has(t));
    const terminalEvents = [...emitsAll].filter((e) => !triggersAll.has(e));
    const chains: string[] = [];
    for (const a of agentActions) for (const e of a.triggered_event) for (const b of agentActions) if (b.name !== a.name && b.trigger.includes(e)) chains.push(`${a.name} —${e}→ ${b.name}`);
    const gates = agentActions.filter((a) => /rule.?check|校验|审核|风控|合规|查重|去重|dedup|lock|黑名单/i.test(a.name)).map((a) => a.name);
    const standalone = agentActions.filter((a) => !a.trigger.some((t) => emitsAll.has(t)) && !a.triggered_event.some((e) => triggersAll.has(e))).map((a) => a.name);

    // RANK-2: DataObjects as ONE top-level dict (referenced by name from each
    // action's target_objects), instead of full properties woven into every
    // action. So the action LIST stays small + complete; the brain grounds its
    // input/output schema by looking up dataObjects[<name>].
    const referenced = new Set(agentActions.flatMap((a) => a.target_objects));
    const dataObjects: Record<string, { primaryKey?: string; properties: Array<{ name: string; type?: string; description?: string }> }> = {};
    for (const name of referenced) {
      const o = objIndex.get(name);
      if (o) dataObjects[o.name] = { primaryKey: o.primary_key, properties: (o.properties ?? []).map((p) => ({ name: p.name, type: p.type, description: p.description })) };
    }

    return {
      ok: true,
      summary:
        `本体 ${ctx.domain}（来自 ${ont.source}）：${ont.objects.length} 对象 · ${ont.actions.length} 动作（${agentActions.length} 个 Agent 动作）· ${ont.events.length} 事件 · ${ont.rules.length} 规则 · 工具库 ${catalog.length} 个工具` +
        (reusableSkills.length ? ` · 技能库 ${reusableSkills.length} 个可复用技能` : "") +
        (Object.values(reusableByAction).filter((r) => r.reusable).length ? ` · 🔁 ${Object.values(reusableByAction).filter((r) => r.reusable).length} 个动作可【复用】已有 agent(见 agentActions[].reusable_agent,用 reuse_agent 采纳,别重造)` : "") +
        `\n本体里的【全部 ${agentActions.length} 个 Agent 动作】:${agentActions.map((a) => a.name).join("、")}。` +
        `\n下一步:【先分析讨论这个域,别急着 create_plan】——结合 output.event_flow 把以下讲清楚:① 事件链怎么从入口事件走到终态(${chains.length} 条衔接) ② 哪些动作是规则闸口(${gates.join("、") || "无"}) ③ 规则集中在哪些环节 ④ 有没有孤立/缺触发的动作(${standalone.join("、") || "无"})。分析后 create_plan 必须覆盖【全部 ${agentActions.length} 个 Agent 动作,别脑补本体里没有的动作/事件】,漏任何一个都要说明为什么。`,
      // Order: event_flow + lean action list FIRST (the world model), then tools,
      // then the DataObjects dict + skills (looked up on demand).
      output: {
        domain: ctx.domain,
        source: ont.source,
        event_flow: { agentActionCount: agentActions.length, allAgentActions: agentActions.map((a) => a.name), entryEvents, terminalEvents, chains, gates, standaloneActions: standalone },
        agentActions: actions,
        availableTools: catalog,
        dataObjects,
        reusable_skills: reusableSkills,
      },
    };
  },
};

const design_agent: BrainTool = {
  name: "design_agent",
  description:
    "提交你为【一个】Agent 动作设计好的 agent。在调用前，你必须先真正想清楚：这个 agent 的职责是什么、有哪些边界情况、从工具库里选哪些工具(为什么)、每个分支事件在什么条件下发出，并【亲自写出】它的 system prompt。一次只提交一个 agent——提交后系统会告诉你接着设计谁。这不是模板套用，要逐个深想。" +
    "【规则校验类 agent 特别注意】如果 read_ontology 里这个动作 is_rule_check=true（它是某一环的规则校验闸口），你写的 system_prompt 必须让它【动态抓规则】，而【绝不能把任何具体规则写进 prompt】：① 从触发事件的 payload(schema) 识别本次要校验的对象与上下文（候选人/JR/客户/部门等）；② 绑定并调用 ontology.fetchActionRules 按【当前 action + payload 上下文】实时抓取适用规则；③ 逐条核对，命中任一强制(mandatory)规则即发失败事件并落库；④ 数据不足时 fail-close 保守拦截。规则随客户/时间会变，以实时抓取为准。其它（非校验）agent 的 prompt 里也不要写任何业务规则——规则是校验闸口的职责。" +
    "【input/output schema】你还要亲自定义这个 agent 的输入/输出字段 schema——【参考 read_ontology 里该 action 的 data_objects（DataObjects 的真实属性 name/type/description）来定】，不要瞎编字段。input_schema=它消费的触发事件 payload 字段，output_schema=它发出的结果事件 payload 字段。设计完后可以调 codegen_agent 让你亲手把它写成 .ts 代码。" +
    "【两个信息源,分清楚再组合】① 业务意图与 I/O 看【本体】:read_ontology 里该 action 的 description(完整行为规格,务必读)、inputs/outputs(业务字段,带 source 指向 DataObject)、submission_criteria(前置条件)、data_objects(实体属性)。② 工具怎么调看【工具库】:availableTools 里每个工具的 parameters(入参)和 returns(返回结构)——例如 robohire.parseResume 的 returns.data 里有 skills/workHistory/gender/endDate 等字段。③ 你的活是把两者【组合】:在 system_prompt / decision_logic 里写清楚『调哪个工具→拿到它 returns 里的哪些字段→映射成本 action outputs 里的业务字段→据此发哪个分支事件』。外部平台的字段以工具 returns 为准,业务字段以本体 outputs 为准,别混。",
  parameters: params({
    action: { type: "string", description: "你正在设计的 action 名（来自 read_ontology 的 agentActions[].name）" },
    tools: { type: "array", items: { type: "string" }, description: "为这个 agent 挑的工具——【必须用 availableTools / 该 action 的 suggested_tools 里的完整工具名（含命名空间，例 robohire.parseResume、partnerpg.saveCandidate）】，不要自己造名字。先看 suggested_tools(已按这个 action 预匹配真实工具库),它没覆盖到的再去 availableTools 里找。真没有合适工具就留空并说明缺什么。" },
    system_prompt: { type: "string", description: "你为这个 agent 亲自写的系统提示（中文）：说明它的职责、依据哪些业务规则、如何决策。要具体，不要套模板。" },
    decision_logic: { type: "string", description: "每个分支事件在什么条件下发出（例：6年经验且本科以上→MATCH_PASSED_NEED_INTERVIEW；硬条件不符→MATCH_FAILED）" },
    input_schema: { type: "array", description: "这个 agent 消费的【触发事件 payload 字段】schema——【参考该 action 的 data_objects 的真实属性来定义】,别瞎编。", items: { type: "object", properties: { field: { type: "string", description: "字段名" }, type: { type: "string", description: "String / Number / Boolean / Object / Array 等" }, description: { type: "string", description: "字段含义" }, source: { type: "string", description: "来自哪个 DataObject.属性,例 Candidate.candidate_id" } }, required: ["field", "type"] } },
    output_schema: { type: "array", description: "这个 agent 发出的【结果事件 payload 字段】schema(同样参考 data_objects)。", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, source: { type: "string" } }, required: ["field", "type"] } },
    tool_rationale: { type: "string", description: "简述为什么选这些工具" },
  }, ["action", "system_prompt"]),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先调用 read_ontology 理解本体。" };
    const reg = ctx.registry ?? resolveRegistry(ctx.domain, ctx.ontology);
    ctx.registry = reg;
    const name = String(args.action ?? "").trim();
    const action = ctx.ontology.actions.find((a) => a.name === name);
    if (!action) return { ok: false, summary: `找不到动作「${name}」，请用 read_ontology 里的准确名字。` };

    // Fully-AI: the brain MUST author the system prompt — no template fallback.
    // An empty/whitespace prompt is rejected so the model rewrites it rather than
    // shipping a hardcoded template agent.
    if (!String(args.system_prompt ?? "").trim()) {
      return { ok: false, summary: `agent「${name}」缺少 system prompt——你必须亲自为它写一段中文系统提示（职责/依据的业务规则/分支决策），不能留空套模板。` };
    }

    const design = {
      systemPrompt: String(args.system_prompt ?? ""),
      tools: Array.isArray(args.tools) ? (args.tools as string[]) : [],
      decisionLogic: String(args.decision_logic ?? ""),
    };
    const inputSchema = parseIoSchema(args.input_schema);
    const outputSchema = parseIoSchema(args.output_schema);
    const spec = buildSpecFromAction(action, ctx.domain, reg, {
      skills: ctx.createdSkills,
      research: ctx.research,
      authored: design,
      inputSchema,
      outputSchema,
      relevantRules: ctx.rulesByAction[name] ?? [], // R4-3
    });
    // Persist the brain's REAL design metadata on the spec so later re-emits
    // (codegen / refine / revert) can show it instead of a placeholder.
    spec.designReasoning = typeof args.reasoning === "string" ? args.reasoning : "";
    spec.toolRationale = String(args.tool_rationale ?? "");
    spec.decisionLogic = design.decisionLogic;
    ctx.specs = ctx.specs.filter((s) => s.actionName !== name);
    ctx.specs.push(spec);
    ctx.lastSandbox = null; // spec changed → prior sandbox evidence is stale; must re-verify

    // Defer-persist: nothing is written to the Fleet draft store mid-run. The
    // chatbot still sees the agent live via the agent.created event below; the
    // draft store is written ONCE, only when finish passes the acceptance gate
    // (atomic: a failed run persists nothing → nothing deploys).
    ctx.emit({
      t: "agent.created",
      spec: cardOf(spec),
      design: {
        reasoning: spec.designReasoning,
        systemPrompt: spec.systemPrompt,
        toolRationale: spec.toolRationale,
        decisionLogic: spec.decisionLogic,
        code: spec.generatedCode,
        codeSource: spec.codeSource,
      },
    });

    // Progress + nudge the NEXT undesigned Agent action, so the brain designs
    // them one at a time (streamed) instead of batching.
    const agentActionNames = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
    const doneNames = new Set(ctx.specs.map((s) => s.actionName));
    const done = agentActionNames.filter((n) => doneNames.has(n)).length;
    const remaining = agentActionNames.filter((n) => !doneNames.has(n));
    const promptKind = spec.promptSource === "llm" ? "你亲自设计" : "（system_prompt 偏空，已回退模板，建议重写）";
    const missing = spec.unresolvedTools ?? [];
    // R5: report when the floor/augment kicked in. The final toolset is bigger
    // than the brain's own resolved picks when either (a) the LLM invented names
    // that didn't resolve so it was equipped from suggestions (Fix #2 0-floor),
    // or (b) it under-picked (≤1) and was auto-completed to a read/process/write
    // set (R5). Tell the brain what was added so it can trim via refine_agent
    // rather than think it bound exactly what it picked.
    const authoredPicked = (Array.isArray(args.tools) ? (args.tools as string[]) : [])
      .map((t) => resolveToolName(String(t), reg))
      .filter((t): t is string => !!t);
    const augmentedTools = spec.tools.filter((t) => !authoredPicked.includes(t));
    const augmented = augmentedTools.length > 0 && authoredPicked.length < spec.tools.length;
    const augNote = augmented
      ? ` · ⚙ 已自动补全工具到 ${spec.tools.length} 个（按该动作的高相关工具库，读/算/写配齐）：补了 ${augmentedTools.join("、")}（如有多余用 refine_agent 删）`
      : "";
    const missingNote = missing.length ? ` · ⚠ 工具库暂无：${missing.join(", ")}（需人工补到工具库，或换 suggested_tools 里的真实工具）` : "";
    // P1 — De-Hallucinator: surface tool picks that were a non-real name BRIDGED
    // onto a real tool, so the brain confirms / re-picks instead of unknowingly
    // shipping a guessed binding (the fuzzy bind is no longer silent).
    const picks = Array.isArray(args.tools) ? (args.tools as string[]) : [];
    const grounding = groundToolPicks(picks, reg);
    const bridgedNote = grounding.bridged.length
      ? ` · 🔗 工具名已对到真实库：${grounding.bridged.map((b) => `${b.raw}→${b.resolved}`).join("、")}（你写的不是工具库真名，已绑到最接近的真实工具——确认或用 refine_agent 改）`
      : "";
    // RANK-4: flag event names in the authored prompt/decision-logic that aren't
    // in the ontology — the brain's hallucination vector (RESUME_PARSED vs the
    // real RESUME_PROCESSED). Warning so the brain re-checks the real names.
    const knownEv = new Set(ctx.ontology.actions.flatMap((a) => [...a.trigger, ...a.triggered_event]));
    const ungrounded = ungroundedEventTokens([design.systemPrompt, design.decisionLogic], knownEv);
    const ungroundedNote = ungrounded.length
      ? ` · ⚠ prompt/决策里出现了本体里【没有】的事件名:${ungrounded.join("、")}——很可能是脑补的。核对 read_ontology 的真事件名(这个 action 的 trigger/emit),用真名,否则沙箱链会断。`
      : "";
    // Rule-leak guard: a NON-gate agent (matchResume / createJD / …) must NOT bake
    // business rules into its prompt — even from memory/reflection. Flag rule-id
    // tokens (e.g. "10-25", "27-6") + rule keywords. Rules belong ONLY to the
    // rule-check gate, which FETCHES them at runtime via ontology.fetchActionRules.
    const isGate = isRuleCheckGate(spec);
    const promptText = `${design.systemPrompt}\n${design.decisionLogic}`;
    const ruleLeak = !isGate && (/\b\d{1,2}-\d{1,3}\b/.test(promptText) || /冷冻期|竞对|红线|黑名单|亲属回避|强制规则|mandatory/i.test(promptText));
    const ruleLeakNote = ruleLeak
      ? ` · ⚠ 这是【非校验】agent,但 prompt 里写进了具体业务规则(规则编号/冷冻期/红线/黑名单等)。规则不该进任何业务 agent 的 prompt——它们只属于 rule-check 闸口,且闸口也是【运行时 ontology.fetchActionRules 动态抓】,不写死。把这些规则从 prompt 删掉,改由前置的 rule-check agent 动态抓取核对。`
      : "";
    // Deliberately NO "接着设计：X" nudge — the brain should decide what to do
    // next based on observation (more design? validate? list_agents to check
    // consistency?), not because the tool string-templated the next item.
    return {
      ok: true,
      summary: `已提交 agent「${spec.nameZh}」(${done}/${agentActionNames.length}) · ${promptKind} · 工具 ${spec.tools.length} 个${augNote}${bridgedNote}${missingNote}${ungroundedNote}${ruleLeakNote} · 下一步:调 codegen_agent 把它亲手写成 .ts 代码(本工厂不用渲染兜底,每个 agent 都必须有你写的代码才能 finish)。`,
      output: { committed: spec.short, promptSource: spec.promptSource, tools: spec.tools, augmented, augmentedTools, unresolved: missing, ungroundedEvents: ungrounded, grounding, needsCodegen: true, done, total: agentActionNames.length, remaining },
    };
  },
};

// ④ reuse_agent — adopt a previously-built, signature-matching agent instead of
// re-designing it from scratch. The proven agent's prompt / tools / decision logic /
// AI-written code are carried over; it then flows through the SAME validation +
// sandbox + finish gate as a freshly-designed one. Only `generated` candidates (they
// carry a full GeneratedAgentSpec) can be adopted; hand-written presets are not.
const reuse_agent: BrainTool = {
  name: "reuse_agent",
  description:
    "采纳一个【已经造过、且事件签名匹配】的现成 agent 来覆盖某个动作,而不是从零重新设计。agent_id 来自 read_ontology 的 agentActions[].reusable_agent.agentId(reusable=true 的)。被采纳的 agent 带着它原来的 system prompt / 工具 / 决策逻辑 / AI 亲写代码进入本次生成,照常走校验和沙箱验证——智能且省时。手写预置 agent 不能这样采纳(无完整规格),那种情况照常 design_agent。",
  parameters: params({
    action: { type: "string", description: "要复用到的动作名(本体里的 Agent 动作)" },
    agent_id: { type: "string", description: "要复用的 agent id(来自 reusable_agent.agentId)" },
  }, ["action", "agent_id"]),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const name = String(args.action ?? "").trim();
    const agentId = String(args.agent_id ?? "").trim();
    const action = ctx.ontology.actions.find((a) => a.name === name);
    if (!action) return { ok: false, summary: `本体里找不到动作「${name}」，请用 read_ontology 里的准确名字。` };
    const reg = ctx.registry ?? resolveRegistry(ctx.domain, ctx.ontology);
    ctx.registry = reg;
    let specJson: string | null = null;
    try {
      const row = await prisma.agentVersion.findUnique({ where: { id: agentId }, select: { specJson: true } });
      specJson = row?.specJson ?? null;
    } catch { /* DB hiccup */ }
    if (!specJson) return { ok: false, summary: `复用失败：找不到 agent「${agentId}」的完整规格(多半是手写预置 agent,无法作为 spec 采纳)——请用 design_agent 现造。` };
    let src: Partial<GeneratedAgentSpec>;
    try { src = JSON.parse(specJson) as Partial<GeneratedAgentSpec>; } catch { return { ok: false, summary: "复用失败：源 agent 规格解析错误。" }; }
    if (!src.systemPrompt || !(src.trigger?.length || src.emit?.length)) {
      return { ok: false, summary: "复用失败：源 agent 规格不完整(缺 prompt / 事件签名)——请用 design_agent 现造。" };
    }
    // Adapt the proven design to THIS domain + action (events come from the ontology
    // action; prompt / tools / decision / code carried over from the source agent).
    const adoptedTools = (src.tools ?? []).map((t) => resolveToolName(t, reg)).filter((t): t is string => !!t);
    const spec = buildSpecFromAction(action, ctx.domain, reg, {
      authored: { systemPrompt: src.systemPrompt, tools: adoptedTools, decisionLogic: src.decisionLogic ?? "" },
      inputSchema: src.inputSchema,
      outputSchema: src.outputSchema,
      relevantRules: ctx.rulesByAction[name] ?? [],
    });
    // Carry the proven AI-written code so it satisfies the finish codegen gate as-is.
    if (src.generatedCode && src.codeSource === "ai") { spec.generatedCode = src.generatedCode; spec.codeSource = "ai"; }
    spec.designReasoning = `复用既有 agent (${agentId})`;
    spec.toolRationale = "(复用既有 agent)";
    spec.decisionLogic = src.decisionLogic ?? spec.decisionLogic;
    ctx.specs = ctx.specs.filter((s) => s.actionName !== name);
    ctx.specs.push(spec);
    ctx.lastSandbox = null; // adopted a spec → prior sandbox evidence is stale
    ctx.emit({
      t: "agent.created",
      spec: cardOf(spec),
      design: { reasoning: spec.designReasoning, systemPrompt: spec.systemPrompt, toolRationale: spec.toolRationale, decisionLogic: spec.decisionLogic ?? "", code: spec.generatedCode, codeSource: spec.codeSource },
    });
    return {
      ok: true,
      summary: `已复用既有 agent 覆盖「${name}」(${spec.tools.length} 工具${spec.codeSource === "ai" ? " · 带原代码,可直接沙箱验证" : " · 还需 codegen_agent 补代码"})。会照常走校验 + 沙箱验证。`,
      output: { actionName: name, reusedFrom: agentId, hasCode: spec.codeSource === "ai", tools: spec.tools },
    };
  },
};

// Boundary events — events emitted with no INTERNAL consumer. Many are legitimate
// handoffs to an EXTERNAL platform (Inngest events are global; an emit can be consumed
// by another app / webhook / external subscriber), not broken chains. The AI proposes a
// classification; the user confirms + supplements the external contract; the static
// validation then honors them so they aren't false-flagged as breaks.
const propose_boundary_events: BrainTool = {
  name: "propose_boundary_events",
  description:
    "当 validate_graph 发现某些事件被 emit 了却【没有内部 agent 消费】(悬空),而你判断它们其实是【交给外部平台消费的交接事件】或【本就是终态】(不是真的链断了),用这个工具把它们列出来交给【用户确认】。每个给:event(本体真事件名)、你的初判 kind(external=外部交接 / terminal=终态)、why 一句理由、(external 时)consumer 你猜的外部消费方 + payloadContract 你猜的 payload 契约。提交后会暂停等用户逐个确认/补充;确认后这些事件不再被当成断点,external 的会留一份对外契约给下游核对。【真正该修的断点别放进来】,那些用 refine_agent 修。",
  parameters: params({
    events: {
      type: "array",
      description: "你判断为外部交接/终态的悬空事件",
      items: {
        type: "object",
        properties: {
          event: { type: "string", description: "事件名(本体真事件名)" },
          kind: { type: "string", enum: ["external", "terminal"], description: "external=交给外部平台消费 / terminal=本就是终态" },
          why: { type: "string", description: "一句理由" },
          consumer: { type: "string", description: "(external)你猜的外部消费方:平台/服务/团队" },
          payloadContract: { type: "string", description: "(external)你猜的 payload 契约:外部消费方会拿到哪些字段" },
        },
        required: ["event", "kind"],
      },
    },
  }, ["events"]),
  async execute(args, ctx) {
    const raw = Array.isArray(args.events) ? (args.events as Array<Record<string, unknown>>) : [];
    if (!raw.length) return { ok: false, summary: "没有给出任何边界事件——如果是真断点请用 refine_agent 修,不要走这个流程。" };
    const producersOf = (ev: string) => ctx.specs.filter((s) => (s.emit ?? []).includes(ev)).map((s) => s.short);
    const proposals: BoundaryProposal[] = raw
      .filter((e) => !!e && typeof e === "object" && typeof e.event === "string")
      .map((e) => ({
        event: String(e.event),
        suggestedKind: (["external", "terminal", "break"].includes(String(e.kind)) ? String(e.kind) : "external") as BoundaryProposal["suggestedKind"],
        why: String(e.why ?? ""),
        producers: producersOf(String(e.event)),
        consumer: typeof e.consumer === "string" ? e.consumer : undefined,
        payloadContract: typeof e.payloadContract === "string" ? e.payloadContract : undefined,
      }));
    ctx.awaitingBoundary = true;
    ctx.boundaryProposals = proposals; // kept so a park timeout can auto-apply them
    ctx.emit({ t: "boundary.cases", proposals, awaitingDecision: true });
    return {
      ok: true,
      summary: `已把 ${proposals.length} 个边界事件交给用户确认(${proposals.map((p) => p.event).join("、")})。【现在暂停,等用户逐个确认是外部交接/终态/还是真断点并补充契约——不要继续调别的工具】。用户决定后我会把结果作为消息发给你,你再据此总结对外契约并继续。`,
      output: { proposals, awaitingDecision: true },
    };
  },
};

const validate_graph: BrainTool = {
  name: "validate_graph",
  description: "静态校验所有 agent 的事件图：①结构闭合(每个 emit 被消费、每个 trigger 有产出者、每个 agent 有工具)②【字段约定/payload 合同】下游 agent 在 inputSchema 里要的字段，上游有没有在 outputSchema 里产出——要的字段没人产=运行时读到 undefined 的真 bug(只看事件名查不出)。【返回 agentIssueMap + contract.payloadGaps】把问题绑到具体 agent，直接对有问题的 slug 调 refine_agent(让上游补 outputSchema 字段或下游别要)。",
  parameters: params({}),
  async execute(_args, ctx) {
    // P2 — feed the AUTHORITATIVE ontology context so validateSpecs additionally
    // checks the spec set against the ontology (not just against itself):
    //   · coverage — every actor=Agent action has a spec (catches a silently
    //     dropped agent, which a spec-graph check can't see — a missing node just
    //     isn't in the graph).
    //   · groundedness — every spec trigger/emit event is declared by some
    //     ontology action (catches a hallucinated event).
    const agentActions = ctx.ontology
      ? ctx.ontology.actions.map((a) => ({ name: a.name, actor: a.actor }))
      : undefined;
    const knownEvents = ctx.ontology
      ? [...new Set(ctx.ontology.actions.flatMap((a) => [...a.trigger, ...a.triggered_event]))]
      : undefined;
    const v = validateSpecs(ctx.specs, { agentActions, knownEvents, boundaryEvents: (ctx.boundaryEvents ?? []).filter((b) => b.kind !== "break").map((b) => b.event) });
    const uncovered = v.structuredIssues.filter((i) => i.kind === "uncovered-agent-action").map((i) => i.agentAction);
    const ungrounded = v.structuredIssues.filter((i) => i.kind === "ungrounded-event").map((i) => i.event);
    // CONTRACT layer (P0-1): assemble the AI-authored input/output schemas into a
    // contract graph and reconcile PAYLOADS — a consumer reading a field no
    // producer writes is a real runtime bug that name-level closure can't catch.
    // A payload_gap fails the contract; an untyped_event is a non-blocking note.
    const contract = deriveContractGraph(ctx.specs, ctx.domain);
    const contractMap = contractAgentIssueMap(contract);
    const issues = [
      ...(uncovered.length ? [`缺少 agent 的 Agent 动作：${uncovered.join("、")}`] : []),
      ...v.danglingEmits.map((e) => `悬空 emit：${e}`),
      ...v.orphanTriggers.map((e) => `孤儿 trigger（可能是入口事件）：${e}`),
      ...v.emptyToolAgents.map((a) => `无工具的 agent：${a}`),
      ...(ungrounded.length ? [`幻觉事件（本体未声明）：${[...new Set(ungrounded)].join("、")}`] : []),
      ...contractIssueStrings(contract),
    ];
    // Merge the contract's offending producers into the agent→issues map so the
    // brain can refine the exact agent whose outputSchema is missing fields.
    const agentIssueMap: Record<string, unknown[]> = { ...v.agentIssueMap };
    for (const [action, list] of Object.entries(contractMap)) {
      agentIssueMap[action] = [...(agentIssueMap[action] ?? []), ...list];
    }
    const ok = v.ok && contract.ok;
    // Cache structured result so refine_agent can read agentIssueMap by slug.
    ctx.lastValidation = { ok, agentIssueMap };
    ctx.emit({ t: "validation", ok, issues, agentIssueMap });
    const offenderHint = Object.keys(agentIssueMap).length
      ? ` · 问题 agent: ${Object.keys(agentIssueMap).slice(0, 4).join(", ")}（用 refine_agent 修正）`
      : "";
    return {
      ok,
      summary: ok ? "事件图闭合 ✓(含字段约定)" : `事件图未完全闭合：${issues.slice(0, 4).join("；")}${offenderHint}`,
      // Return the full structured output: brain can read agentIssueMap[slug]
      // directly without parsing summary strings.
      output: {
        ok,
        agentIssueMap,
        structuredIssues: v.structuredIssues,
        // CONTRACT artifact: per-event provided/expected fields + payload gaps,
        // so the brain can reason about the exact field a downstream agent needs.
        contract: {
          ok: contract.ok,
          payloadGaps: contract.events.filter((e) => e.payloadGaps.length).map((e) => ({ event: e.name, missing: e.payloadGaps, producers: e.producers, consumers: e.consumers })),
          issues: contract.issues,
        },
        // Back-compat
        danglingEmits: v.danglingEmits,
        orphanTriggers: v.orphanTriggers,
        emptyToolAgents: v.emptyToolAgents,
        slugCollisions: v.slugCollisions,
      },
    };
  },
};

const sandbox_run: BrainTool = {
  name: "sandbox_run",
  description:
    "把目前生成的所有 agent 部署到隔离的 Inngest 测试域并真实触发运行，观察事件链是否真的串起来跑通、到达终态。会流式发出 sandbox.progress 进度事件（deploying → deployed → firing → polling → settled），用户能看着跑。如果没跑通(reachedTerminal=false)，立刻调 inspect_run 看具体哪个 agent 怎么挂的——不要乱猜。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.specs.length) return { ok: false, summary: "还没有 agent 可跑，请先用 design_agent 设计。" };
    // Feature 2: gate the FIRST real run behind user-approved test cases. If none
    // have been proposed yet, author + propose them now and PARK for the user's
    // 执行/重新生成 decision (the conductor parks on ctx.awaitingApproval) — so the
    // user sees the cases BEFORE any deploy. After 执行, ctx.testCases is set, so the
    // brain's next sandbox_run skips this gate and actually deploys + fires them.
    if (!ctx.testCases?.length && !ctx.awaitingApproval) {
      return proposeTestCases(ctx);
    }
    // P1-2 (audit MAJOR): global sandbox-run budget. The real churn cost is sandbox
    // deploys + tokens, not turn count — without this, cross-agent/replan churn can
    // burn to MAX_TURNS (a timeout, not convergence). Cap the real deploys; past it,
    // stop grinding and force an honest analyze_failure.
    ctx.spent.sandboxRuns = (ctx.spent.sandboxRuns ?? 0) + 1;
    if (ctx.spent.sandboxRuns > MAX_SANDBOX_RUNS) {
      const msg = `已经沙箱跑了 ${ctx.spent.sandboxRuns - 1} 次(预算 ${MAX_SANDBOX_RUNS})——还没全链路跑通,说明不是再试一次能解决的。【别再 sandbox_run】:先 verify_chain 确定性定位断点、定向修一处;若确属数据/环境限制无法跑通,调 analyze_failure(kind=failure) 诚实收尾,不要硬磨。`;
      ctx.emit({ t: "message", text: msg });
      return { ok: false, summary: msg, output: { sandboxRuns: ctx.spent.sandboxRuns - 1, budget: MAX_SANDBOX_RUNS, advice: "verify_chain_or_analyze_failure" } };
    }
    // Deploy to a DEDICATED sandbox app (agentic-operator-sandbox-<domain>),
    // isolated from the domain's own production app — so a test never pollutes
    // the real domain's Inngest app. The Fleet drafts are persisted separately
    // under the real domain by design_agent; the sandbox app is torn down at the
    // end of the session (conductor).
    const sandboxDomain = sandboxDomainFor(ctx.domain);
    // R2-2: streaming progress phases so the long-poll doesn't look like a frozen UI.
    ctx.emit({ t: "sandbox.progress", phase: "deploying", detail: `部署 ${ctx.specs.length} 个 agent 到独立沙箱 app（agentic-operator-${sandboxDomain}）` });
    const ship = await shipAgents(ctx.domain, ctx.specs, { deployDomain: sandboxDomain });
    if (!ship.appRegistered) {
      ctx.emit({ t: "sandbox.progress", phase: "settled", detail: `部署失败：${ship.error ?? "未注册"}` });
      return { ok: false, summary: `上架到 Inngest 沙箱 app 失败：${ship.error ?? "未注册"}`, output: ship };
    }
    // Tear down this sandbox app at session end (set early so an abort still cleans up).
    ctx.pendingSandboxDomain = sandboxDomain;
    ctx.emit({ t: "sandbox.progress", phase: "deployed", detail: `已上架到独立沙箱 app ${ship.appId ?? "Inngest"} · 真实注册 ${ship.functionsRegistered ?? 0} 个函数 (version: ${ship.versionLabel})` });
    ctx.emit({ t: "sandbox.progress", phase: "firing", detail: "触发入口事件…" });
    const run = await fireAndObserve(sandboxDomain, ctx.specs, {
      timeoutMs: 50_000,
      // Feature 2: fire the user-approved test cases (reviewed inputs) instead of a
      // hardcoded seed, so the proof shows real I/O on cases the user signed off on.
      // kind/name/expectedOutcome ride along for the per-case behavioral assertion (②).
      cases: (ctx.testCases ?? []).map((c) => ({ entryEvent: c.entryEvent, payload: c.payload, kind: c.kind, name: c.name, expectedOutcome: c.expectedOutcome })),
      // P2: let a human interrupt mid-sandbox — bail the observe early if they injected
      // a message or aborted, so the brain reacts next turn instead of after ~50s.
      shouldCancel: async () => !!ctx.signal?.aborted || (await hasPendingHumanMsg(ctx.runId)),
      onProgress: (snap: { runsSoFar: number; eventsSoFar: number; reachedTerminal: boolean }) => {
        ctx.emit({
          t: "sandbox.progress",
          phase: snap.reachedTerminal ? "settled" : "polling",
          eventsSoFar: snap.eventsSoFar,
          runsSoFar: snap.runsSoFar,
          detail: `已观察 ${snap.runsSoFar} 个 run · ${snap.eventsSoFar} 个事件${snap.reachedTerminal ? " · 到达终态" : ""}`,
        });
      },
    });
    const appId = run.appId ?? ship.appId ?? `agentic-operator-${sandboxDomain}`;
    const functionsRegistered = run.functionsRegistered ?? ship.functionsRegistered ?? 0;

    // B — registration assertion. 0 functions registered = the deploy didn't
    // take (we fired into the void). Report it as a DEPLOY failure distinct from
    // a logic bug, and don't pretend the chain "ran but didn't reach terminal".
    if (functionsRegistered === 0) {
      ctx.emit({ t: "sandbox", ran: 0, reachedTerminal: false, agents: [], events: [], appId, functionsRegistered: 0, deployFailed: true });
      ctx.emit({ t: "sandbox.progress", phase: "settled", detail: `部署未生效：${appId} 上注册了 0 个函数` });
      return {
        ok: false,
        summary: `⚠ 部署未生效：${appId} 上 Inngest 实际注册了 0 个函数(本该 ${ctx.specs.length} 个)。检查 Inngest dev server 是否在跑、per-domain serve route 是否可达(INNGEST_SERVE_ORIGIN)，再重试 sandbox_run。`,
        output: { deployFailed: true, appId, functionsRegistered: 0, expected: ctx.specs.length },
      };
    }

    const fnPrefix = `agentic-operator-${sandboxDomain}-`;
    const agents = [...new Set(run.runs.map((r) => r.fn.replace(fnPrefix, "")))];
    ctx.lastSandboxRunIds = run.runs.map((r) => r.runId);
    ctx.lastSandboxVersionLabel = ship.versionLabel;

    // A — deploy proof: clickable Inngest dashboard links to the REAL runs.
    const dash = (process.env.INNGEST_BASE_URL ?? "http://localhost:8288").replace(/\/+$/, "");
    const runUrls = run.runs.slice(0, 12).map((r) => ({
      runId: r.runId,
      url: `${dash}/run?runID=${encodeURIComponent(r.runId)}`,
      status: r.status,
      fn: r.fn.replace(fnPrefix, ""),
    }));

    const deployed = functionsRegistered || ctx.specs.length;
    const partial = agents.length < deployed; // not every deployed agent executed
    const degradedAgents = run.degradedAgents ?? [];
    // Don't equate a terminal with success (analysis don't-do #3): a chain that only
    // reaches a FAILURE leaf (MATCH_FAILED, RESUME_LOCKED_CONFLICT…) exercised a
    // reject branch, not the happy path. A real "chain ran" must reach a SUCCESS
    // terminal (an emitted-but-unconsumed event that isn't a failure). Fall back to
    // any-terminal only for domains that define no success leaf at all.
    const FAILISH = /FAIL|REJECT|ERROR|CONFLICT|MISSING|DENIED/i;
    const emittedEv = new Set(ctx.specs.flatMap((s) => s.emit).filter((e) => e && e !== "—"));
    const consumedEv = new Set(ctx.specs.flatMap((s) => s.trigger).filter(Boolean));
    const successTerminals = [...emittedEv].filter((e) => !consumedEv.has(e) && !FAILISH.test(e));
    const reachedSuccessTerminal = successTerminals.some((t) => run.events.some((ev) => ev === t || ev.endsWith(`/${t}`)));
    const reachedGoodEnd = successTerminals.length ? reachedSuccessTerminal : run.reachedTerminal;
    // A chain that only "progressed" on DEGRADED decisions (gateway down → emits[0]
    // fallback) is not really verified — fold that into fullChainRan so the gate
    // rejects it (closes the "degraded masks errors" hole).
    const fullChainRan = !partial && reachedGoodEnd && degradedAgents.length === 0;
    // RANK-1: persist the run OUTCOME as a first-class result, fingerprinted to the
    // specs that ran, so the finish gate can require a real end-to-end run and
    // detect stale-green (spec changed since this run).
    ctx.lastSandbox = {
      specsFingerprint: specsFingerprint(ctx.specs),
      deployed, agentsRan: agents.length, ranAgents: agents,
      reachedTerminal: run.reachedTerminal, reachedSuccessTerminal, fullChainRan, partial, degradedAgents, ts: Date.now(),
    };
    // P2 observability: surface WHICH agents degraded / didn't run, so the UI can
    // mark the exact stuck slots red (the per-slot diagnosis the audit flagged as
    // missing). missedAgents = deployed specs whose fn never executed.
    const missedAgents = ctx.specs.filter((s) => !agents.some((a) => a === s.slug || a.includes(s.slug) || s.slug.includes(a))).map((s) => s.short);
    // Feature 2: capture each agent's REAL input→tools→output from the archive, so
    // the verification panel proves the run with concrete I/O (not just counts). And
    // surface the use cases that were fired, so the panel shows what went in.
    const agentRuns = await collectAgentRuns(ctx.domain, ctx.lastSandboxRunIds, ctx.specs).catch(() => []);
    const cases = (ctx.testCases ?? []).map((c) => ({ name: c.name, entryEvent: c.entryEvent, payload: c.payload }));
    ctx.emit({ t: "sandbox", ran: agents.length, reachedTerminal: run.reachedTerminal, reachedSuccessTerminal, agents, events: run.events, appId, functionsRegistered, deployed, fullChainRan, degradedAgents, missedAgents, runUrls, agentRuns, cases, caseResults: run.caseResults });
    // A partial chain is a FAILURE to surface, not a success — even if a terminal
    // event was seen (an independent branch can hit a terminal while the main
    // chain is stuck). Lead with ran/deployed and push diagnosis hard so the
    // brain doesn't rationalize "2 of 6 ran + saw a terminal" as 跑通.
    const diagnoseHint = partial
      ? ` · ⚠ 只有 ${agents.length}/${deployed} 个 agent 真的跑起来——事件链没串完。先调 verify_chain 确定性定位断点(谁的 emit 和下游 trigger 对不上),再 refine_agent 修正。【不要】当成跑通了。`
      : degradedAgents.length
        ? ` · ⚠ 这些 agent 是 degraded(降级兜底,不是真决策,多半是 LLM 网关挂了):${degradedAgents.join("、")}——链路看似前进其实是假的。修好网关/重跑,degraded 不算跑通。`
        : !run.reachedTerminal
          ? " · 没到终态——【立刻】调 inspect_run 看每个 agent 的真实运行情况（错误、AgentDecision、step 失败原因），再针对失败的 agent 调 refine_agent 修正"
          : successTerminals.length && !reachedSuccessTerminal
            ? ` · ⚠ 只跑到了失败分支终态(${successTerminals.join("/")} 这种成功终态没到达)——只验证了 reject 分支,正常通过的主路径还没跑通。检查喂进去的入口数据是否能走到成功终态(golden fixture),再重跑。`
            : "";
    return {
      ok: run.runs.length > 0,
      summary: `真实部署到 ${appId}(${functionsRegistered} 个函数)并运行：${agents.length}/${deployed} 个 agent 真的跑起来 · 事件链 ${run.events.length} 个 · ${fullChainRan ? "全链路跑通到成功终态 ✓" : reachedSuccessTerminal ? "到达成功终态(但有 agent 没跑/降级)" : run.reachedTerminal ? "只到了失败分支终态(成功主路径未跑通)" : "未到终态"}${diagnoseHint}`,
      output: { app: appId, functionsRegistered, agentsRan: agents.length, deployed, fullChainRan, reachedSuccessTerminal, ranAgents: agents, events: run.events, reachedTerminal: run.reachedTerminal, runIds: ctx.lastSandboxRunIds, runUrls, deployedThisSession: true },
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// P0-1: inspect_run — real per-agent diagnostics from the Postgres archive.
// Brain can finally SEE what happened in a sandbox run instead of guessing
// from event chain. Returns: per-agent { status, step errors, AgentDecision
// (event, reasoning, toolCalls, degraded), input/output of the reason step }.
// ────────────────────────────────────────────────────────────────────────────
const inspect_run: BrainTool = {
  name: "inspect_run",
  description:
    "查看上一次 sandbox_run 里【每个 agent 真实跑出来的细节】：状态、失败的 step、错误信息、AgentDecision（agent 决定发哪个事件、思路、调了什么工具、是否 degraded）。当 sandbox_run 没到终态时必须先调这个看清楚问题，再针对【具体那个 agent】调 refine_agent。不传参数=查上次 sandbox 的所有 run。",
  parameters: params({
    runId: { type: "string", description: "可选——只看某个 runId；不传则查上次 sandbox_run 的所有 runs" },
    agent_slug: { type: "string", description: "可选——只看某个 agent 的跑结果" },
    failed_only: { type: "boolean", description: "可选 (R2-6) — true 时只返回有问题的 agent (failed step / degraded / 非 Completed)。聚焦诊断时用，省 token。" },
  }),
  async execute(args, ctx) {
    const runIdArg = typeof args.runId === "string" ? args.runId.trim() : "";
    const agentFilter = typeof args.agent_slug === "string" ? args.agent_slug.trim() : "";
    const failedOnly = args.failed_only === true;
    const runIds = runIdArg ? [runIdArg] : ctx.lastSandboxRunIds;
    if (runIds.length === 0) {
      return { ok: false, summary: "还没有沙箱跑过——先调 sandbox_run 真实运行一次。" };
    }

    // Fetch run rows + their step archive + agent activity in parallel.
    const fnPrefix = `agentic-operator-${sandboxDomainFor(ctx.domain)}-`;
    const [runs, steps, activities] = await Promise.all([
      prisma.inngestRunArchive.findMany({
        where: { runId: { in: runIds } },
        select: { runId: true, status: true, functionSlug: true, output: true, durationMs: true, startedAt: true, endedAt: true, eventName: true },
      }),
      prisma.inngestStepArchive.findMany({
        where: { runId: { in: runIds } },
        select: { runId: true, name: true, status: true, error: true, output: true, durationMs: true },
      }),
      prisma.agentActivity.findMany({
        where: { runId: { in: runIds }, type: "agent_decision" },
        select: { runId: true, agentName: true, narrative: true, metadata: true },
      }),
    ]);

    type AgentRunSummary = {
      runId: string;
      agentSlug: string;
      agentShort: string;
      status: string;
      durationMs: number | null;
      triggerEvent: string | null;
      decision: { event: string; reasoning: string; toolsUsed: string[]; degraded: boolean } | null;
      failedSteps: Array<{ name: string; status: string; error: string }>;
      emittedEvent: string | null;
    };

    const summaries: AgentRunSummary[] = [];
    for (const r of runs) {
      const agentSlug = r.functionSlug.replace(fnPrefix, "");
      if (agentFilter && agentSlug !== agentFilter) continue;
      const spec = ctx.specs.find((s) => s.short === agentSlug || s.slug === r.functionSlug);
      let decision: AgentRunSummary["decision"] = null;
      const act = activities.find((a) => a.runId === r.runId);
      if (act?.metadata) {
        try {
          const m = JSON.parse(act.metadata) as { chosen?: string; tools?: string[]; degraded?: boolean };
          decision = { event: String(m.chosen ?? ""), reasoning: act.narrative, toolsUsed: m.tools ?? [], degraded: !!m.degraded };
        } catch { /* keep null */ }
      }
      let emittedEvent: string | null = null;
      if (r.output) {
        try { emittedEvent = (JSON.parse(r.output) as { emitted?: string }).emitted ?? null; } catch { /* */ }
      }
      const failedSteps = steps
        .filter((s) => s.runId === r.runId && (s.status === "Failed" || s.status === "error" || !!s.error))
        .map((s) => ({ name: s.name, status: s.status ?? "?", error: (s.error ?? "").slice(0, 400) }));

      summaries.push({
        runId: r.runId,
        agentSlug,
        agentShort: spec?.short ?? agentSlug,
        status: r.status,
        durationMs: r.durationMs ?? null,
        triggerEvent: r.eventName,
        decision,
        failedSteps,
        emittedEvent,
      });
    }

    // R2-6: failed_only filter — when true, only return agents that look broken.
    const isFailing = (s: AgentRunSummary) => s.status !== "Completed" || s.failedSteps.length > 0 || (s.decision?.degraded ?? false);
    const filtered = failedOnly ? summaries.filter(isFailing) : summaries;

    // Emit a UI diagnostic per inspected agent (visible in the right-panel trace).
    for (const s of filtered) {
      ctx.emit({
        t: "inspect",
        runId: s.runId,
        agentSlug: s.agentSlug,
        status: s.status,
        degraded: s.decision?.degraded ?? false,
        error: s.failedSteps[0]?.error,
      });
    }

    const failing = summaries.filter(isFailing);
    const summary = summaries.length === 0
      ? "上次 sandbox 没找到匹配的 run。"
      : failing.length === 0
        ? `检查了 ${summaries.length} 个 run，全部 Completed、无 step 失败、无 degraded ✓`
        : failedOnly
          ? `${failing.length} 个 agent 有问题：${failing.map((f) => `${f.agentSlug}(${f.status}${f.failedSteps[0] ? ` · 失败 step: ${f.failedSteps[0].name}` : ""}${f.decision?.degraded ? " · degraded" : ""})`).slice(0, 4).join("；")}——用 refine_agent 修正`
          : `检查了 ${summaries.length} 个 run，${failing.length} 个有问题：${failing.map((f) => `${f.agentSlug}(${f.status}${f.failedSteps[0] ? ` · 失败 step: ${f.failedSteps[0].name}` : ""}${f.decision?.degraded ? " · degraded" : ""})`).slice(0, 3).join("；")}——用 refine_agent 修正`;
    return {
      ok: true,
      summary,
      output: { runs: filtered, failingAgents: failing.map((f) => f.agentSlug), totalRuns: summaries.length, filtered: failedOnly },
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// P0-3: refine_agent — iterative agent revision. Replaces blind overwrite by
// preserving prior spec snapshot + critique in ctx.attemptHistory, so the LLM
// sees its OWN past attempts and the rationale for change.
// ────────────────────────────────────────────────────────────────────────────
// P4 — per-agent refine budget. After this many attempts, refuse to keep
// grinding (the FlipFlop / over-iteration anti-pattern) and tell the brain to
// revert to the best version or accept and move on.
const REFINE_BUDGET = 3;
// P1-2 (audit MAJOR): global budgets so the iterative loop CONVERGES instead of just
// timing out. Sandbox runs (real Inngest deploys) are the dominant cost; refine total
// across ALL agents catches cross-agent churn that per-agent REFINE_BUDGET misses.
const MAX_SANDBOX_RUNS = 8;
const GLOBAL_REFINE_FACTOR = 3; // total refines allowed ≈ 3 × agent count

const refine_agent: BrainTool = {
  name: "refine_agent",
  description:
    "针对【一个已经设计过】的 agent 做一次结构化修订：传入 critique（上次哪里不对）+ 修改后的 system_prompt / tools / decision_logic。系统会保留上次设计的完整快照到 attemptHistory（你可以用 read_spec 看上次写了啥），然后用你新版替换。和 design_agent 不同：design_agent 是第一次创建；refine_agent 是在已有版本上的可追溯迭代。",
  parameters: params({
    action: { type: "string", description: "要修订的 action 名（必须是 ctx.specs 里已存在的）" },
    critique: { type: "string", description: "上次设计哪里不对、为什么需要改（具体——例：「processResume 没处理解析空字段的 fallback，导致 sandbox 里 RESUME_INFO_MISSING 没被发出」）" },
    system_prompt: { type: "string", description: "修订后的完整 system prompt（中文，覆盖上一版）" },
    tools: { type: "array", items: { type: "string" }, description: "可选——若要改工具绑定，给完整新列表；不传=沿用上次" },
    decision_logic: { type: "string", description: "修订后的分支决策逻辑" },
    changes_summary: { type: "string", description: "一句中文：这次具体改了啥" },
  }, ["action", "critique", "system_prompt", "changes_summary"]),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const name = String(args.action ?? "").trim();
    const prior = ctx.specs.find((s) => s.actionName === name);
    if (!prior) {
      return { ok: false, summary: `agent「${name}」还不存在——这是首次创建，请用 design_agent，不是 refine_agent。` };
    }
    const reg = ctx.registry ?? resolveRegistry(ctx.domain, ctx.ontology);
    ctx.registry = reg;
    const action = ctx.ontology.actions.find((a) => a.name === name);
    if (!action) return { ok: false, summary: `本体里找不到动作「${name}」。` };

    // P4 — retry budget. Stop grinding after REFINE_BUDGET attempts: more refines
    // tend to regress, not improve. Don't record a new attempt; steer the brain.
    const priorAttempts = ctx.attemptHistory[name]?.length ?? 0;
    if (priorAttempts >= REFINE_BUDGET) {
      return {
        ok: false,
        summary: `agent「${name}」已 refine ${priorAttempts} 次，达到重试上限——别再硬修了。要么 revert_refine("${name}") 回滚到最好的一版并接受，要么去 sandbox_run 验证现状；若方向就是错的，用 create_plan 重新规划。`,
        output: { actionName: name, attemptsUsed: priorAttempts, budget: REFINE_BUDGET, advice: "revert_or_accept_or_replan" },
      };
    }
    // P1-2 (audit MAJOR): GLOBAL refine guard — per-agent REFINE_BUDGET doesn't catch
    // cross-agent churn (refine A → refine B → refine A's sibling → …). Cap the total
    // across all agents so the loop can't grind every agent to its budget.
    const totalRefines = Object.values(ctx.attemptHistory).reduce((s, h) => s + (h?.length ?? 0), 0);
    const globalCap = GLOBAL_REFINE_FACTOR * Math.max(1, ctx.specs.length);
    if (totalRefines >= globalCap) {
      return {
        ok: false,
        summary: `全域已累计 refine ${totalRefines} 次(上限 ${globalCap}≈${GLOBAL_REFINE_FACTOR}×${ctx.specs.length} 个 agent)——再逐个微调大概率解决不了,问题很可能在设计/数据/本体层面。停下:用 verify_chain 看链路全貌定位真断点,或 analyze_failure(kind=failure) 诚实记根因收尾,别继续 churn。`,
        output: { totalRefines, globalCap, advice: "stop_churn_verify_or_analyze" },
      };
    }

    // Fully-AI: a refine must carry a real authored prompt — no empty/template.
    if (!String(args.system_prompt ?? "").trim()) {
      return { ok: false, summary: `refine 需要你给出完整的新 system prompt（中文，覆盖上一版）——不能留空。` };
    }

    // Record the prior attempt BEFORE overwriting.
    const history = (ctx.attemptHistory[name] ??= []);
    const attempt: RefineAttempt = {
      attemptNumber: history.length + 1,
      ts: Date.now(),
      priorSpecSnapshot: {
        systemPrompt: prior.systemPrompt,
        tools: [...prior.tools],
        decisionLogic: undefined,
      },
      critique: String(args.critique ?? ""),
      changes: String(args.changes_summary ?? ""),
    };
    history.push(attempt);

    // Build the refined spec. If tools not provided, sticky to prior tools (so a
    // pure prompt-fix doesn't accidentally drop the existing tool binding).
    const refinedTools = Array.isArray(args.tools) && (args.tools as string[]).length > 0
      ? (args.tools as string[])
      : prior.tools;

    const design = {
      systemPrompt: String(args.system_prompt ?? ""),
      tools: refinedTools,
      decisionLogic: String(args.decision_logic ?? ""),
    };
    const spec = buildSpecFromAction(action, ctx.domain, reg, {
      skills: ctx.createdSkills,
      research: ctx.research,
      authored: design,
      relevantRules: ctx.rulesByAction[name] ?? [], // R4-3
    });
    // carry the refined design metadata on the spec so codegen-after-refine
    // preserves the real reasoning/logic (not a placeholder).
    spec.designReasoning = `修订版 #${attempt.attemptNumber}：${attempt.changes}`;
    spec.toolRationale = `(refine: ${attempt.changes})`;
    spec.decisionLogic = design.decisionLogic;
    ctx.specs = ctx.specs.filter((s) => s.actionName !== name);
    ctx.specs.push(spec);
    ctx.lastSandbox = null; // spec changed → prior sandbox evidence is stale; must re-verify

    // Defer-persist: no mid-run draft write (finish persists on acceptance).

    // R2-4: compute structured diff so UI can show what actually changed.
    const priorToolSet = new Set(prior.tools);
    const newToolSet = new Set(spec.tools);
    const toolsAdded = spec.tools.filter((t) => !priorToolSet.has(t));
    const toolsRemoved = prior.tools.filter((t) => !newToolSet.has(t));
    const systemPromptChanged = prior.systemPrompt !== spec.systemPrompt;
    const decisionLogicChanged = !!design.decisionLogic && design.decisionLogic !== (attempt.priorSpecSnapshot.decisionLogic ?? "");
    ctx.emit({
      t: "refine",
      actionName: name,
      attemptNumber: attempt.attemptNumber,
      critique: attempt.critique,
      diff: { systemPromptChanged, toolsAdded, toolsRemoved, decisionLogicChanged },
    });
    ctx.emit({
      t: "agent.created",
      spec: cardOf(spec),
      design: {
        reasoning: `修订版 #${attempt.attemptNumber}：${attempt.changes}`,
        systemPrompt: spec.systemPrompt,
        toolRationale: `(refine: ${attempt.changes})`,
        decisionLogic: design.decisionLogic,
        code: spec.generatedCode,
        codeSource: spec.codeSource,
      },
    });

    // R4-1: AUTO-SCORE the new spec vs the prior spec, surface regression.
    // The brain shouldn't have to call score_spec after every refine — we just
    // run the same scoring function and emit a delta event. If the refine made
    // things meaningfully worse (total drop > 10 OR any single dim drops > 20),
    // the tool summary tells the brain it can call revert_refine to roll back.
    const newDims = scoreSpec(spec, history.length);
    const newTotal = Math.round((newDims.toolResolution + newDims.promptRichness + newDims.decisionCoverage + newDims.refineHealth) / 4);
    const priorDims = scoreSpec(prior, history.length - 1);
    const priorTotal = Math.round((priorDims.toolResolution + priorDims.promptRichness + priorDims.decisionCoverage + priorDims.refineHealth) / 4);
    const delta = newTotal - priorTotal;
    const worstDimDrop = Math.min(
      newDims.toolResolution - priorDims.toolResolution,
      newDims.promptRichness - priorDims.promptRichness,
      newDims.decisionCoverage - priorDims.decisionCoverage,
      newDims.refineHealth - priorDims.refineHealth,
    );
    const regression = delta <= -10 || worstDimDrop <= -20;
    ctx.emit({
      t: "score.delta",
      actionName: name,
      attemptNumber: attempt.attemptNumber,
      priorTotal,
      newTotal,
      delta,
      regression,
      dimensions: newDims,
      priorDimensions: priorDims,
    });
    const scoreNote = regression
      ? ` · ⚠ 质量回归：${priorTotal} → ${newTotal} (Δ${delta})，比上一版更差。考虑调 revert_refine("${name}") 回滚，再换个角度修订。`
      : delta > 0
        ? ` · 质量评分：${priorTotal} → ${newTotal} (+${delta}) ✓ 改进`
        : ` · 质量评分：${priorTotal} → ${newTotal} (Δ${delta})`;

    return {
      ok: !regression,
      summary: `已对 agent「${spec.nameZh}」做第 ${attempt.attemptNumber} 次修订（${attempt.changes}）${scoreNote}`,
      output: {
        actionName: name,
        attemptNumber: attempt.attemptNumber,
        totalAttempts: history.length,
        priorSpecSnapshot: attempt.priorSpecSnapshot,
        score: { priorTotal, newTotal, delta, regression, dimensions: newDims },
      },
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// P1-2: list_agents + read_spec — introspection. Brain can examine what it
// has already built (in the SAME run) for cross-agent consistency, instead of
// reasoning over fading message history.
// ────────────────────────────────────────────────────────────────────────────
const list_agents: BrainTool = {
  name: "list_agents",
  description: "列出你这一轮已经设计了哪些 agent（slug · action · trigger → emit · 工具数 · 来源是 llm 现写还是回退模板）。设计新 agent 之前调一下，避免重复或跟其它 agent 冲突。",
  parameters: params({}),
  async execute(_args, ctx) {
    const items = ctx.specs.map((s) => ({
      slug: s.slug,
      actionName: s.actionName,
      trigger: s.trigger,
      emit: s.emit,
      toolCount: s.tools.length,
      promptSource: s.promptSource,
      attemptCount: ctx.attemptHistory[s.actionName]?.length ?? 0,
    }));
    return {
      ok: true,
      summary: `已设计 ${items.length} 个 agent${items.length ? "：" + items.map((i) => i.actionName).join(", ") : ""}`,
      output: { count: items.length, agents: items },
    };
  },
};

const read_spec: BrainTool = {
  name: "read_spec",
  description: "读出某个已设计 agent 的完整规格（system prompt、工具、attempt 历史等）。修订前调它看清楚上次设计了什么；做跨 agent 一致性检查时也调。",
  parameters: params({
    action: { type: "string", description: "action 名（来自 list_agents 或 read_ontology）" },
  }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `agent「${name}」还没设计过。` };
    const history = ctx.attemptHistory[name] ?? [];
    return {
      ok: true,
      summary: `agent「${spec.nameZh}」: ${spec.tools.length} 工具 · ${spec.trigger.join(",")} → ${spec.emit.join("/")} · ${history.length} 次 refine`,
      output: {
        actionName: spec.actionName,
        slug: spec.slug,
        nameZh: spec.nameZh,
        trigger: spec.trigger,
        emit: spec.emit,
        tools: spec.tools,
        unresolvedTools: spec.unresolvedTools,
        systemPrompt: spec.systemPrompt,
        promptSource: spec.promptSource,
        attemptHistory: history,
      },
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// P1-3: create_plan — explicit BuildPlan artifact. Brain decomposes the
// problem ONCE (after read_ontology), records the plan, then references it
// during per-agent design. Can be re-called if validation/sandbox reveals
// the plan itself was wrong (replan loop).
// ────────────────────────────────────────────────────────────────────────────
const create_plan: BrainTool = {
  name: "create_plan",
  description:
    "在 read_ontology 之后、design_agent 之前调用：把你打算造哪些 agent、什么执行顺序、各自的事件输入输出、要绑哪些工具、有什么边界情况【显式写成一份计划】。这是检查点——你后续设计每个 agent 时可以对照它，校验/沙箱失败时也可以回头修改计划再重新设计（不是必须，但强烈推荐——可避免你后期发现整体方向就错了）。可以多次调用做 replan。",
  parameters: params({
    summary: { type: "string", description: "1-2 句话：你的整体方案" },
    agents: {
      type: "array",
      description: "按事件链执行顺序列出的 agent",
      items: {
        type: "object",
        properties: {
          actionName: { type: "string" },
          role: { type: "string", description: "1 句话：这个 agent 干什么" },
          triggerEvents: { type: "array", items: { type: "string" } },
          emitEvents: { type: "array", items: { type: "string" } },
          toolCandidates: { type: "array", items: { type: "string" }, description: "你打算给它绑哪些工具（从 availableTools 里挑）" },
          edgeCases: { type: "array", items: { type: "string" }, description: "明确写出要处理的边界/异常" },
        },
      },
    },
    notes: { type: "array", items: { type: "string" }, description: "跨 agent 的共同关注点（业务规则、坑、依赖关系）" },
  }, ["summary", "agents"]),
  async execute(args, ctx) {
    const ver = (ctx.currentPlan?.version ?? 0) + 1;
    const planAgents = (Array.isArray(args.agents) ? args.agents : []) as Array<Record<string, unknown>>;
    const plan: BuildPlan = {
      summary: String(args.summary ?? ""),
      agents: planAgents.map((a) => ({
        actionName: String(a.actionName ?? ""),
        role: String(a.role ?? ""),
        triggerEvents: (Array.isArray(a.triggerEvents) ? a.triggerEvents : []) as string[],
        emitEvents: (Array.isArray(a.emitEvents) ? a.emitEvents : []) as string[],
        toolCandidates: (Array.isArray(a.toolCandidates) ? a.toolCandidates : []) as string[],
        edgeCases: (Array.isArray(a.edgeCases) ? a.edgeCases : []) as string[],
      })),
      notes: (Array.isArray(args.notes) ? args.notes : []) as string[],
      version: ver,
    };

    // R2-3: validate plan against ontology so a wrong plan can't silently
    // propagate to design_agent. We don't reject; we flag what's off and let
    // the brain decide whether to replan.
    const warnings: string[] = [];
    const knownActions: string[] = [];
    const knownAvailableTools = new Set<string>();
    if (ctx.ontology) {
      const agentActions = ctx.ontology.actions.filter((a) => a.actor.includes("Agent"));
      knownActions.push(...agentActions.map((a) => a.name));
      const planActionSet = new Set(plan.agents.map((a) => a.actionName));
      const unknown = plan.agents.filter((a) => !knownActions.includes(a.actionName)).map((a) => a.actionName);
      if (unknown.length) warnings.push(`计划里的这些 action 在本体中找不到：${unknown.join(", ")}`);
      const missed = knownActions.filter((n) => !planActionSet.has(n));
      if (missed.length) warnings.push(`本体里这些 Agent 动作没在计划里：${missed.join(", ")}——确认是有意省略还是漏了`);
    }
    if (ctx.registry) {
      ctx.registry.list().forEach((t) => knownAvailableTools.add(t.name));
      const unknownTools = new Set<string>();
      for (const a of plan.agents) {
        for (const t of a.toolCandidates) if (t && !knownAvailableTools.has(t)) unknownTools.add(t);
      }
      if (unknownTools.size) warnings.push(`计划里的这些工具不在工具库：${[...unknownTools].slice(0, 8).join(", ")}（需人工补；或换成已有工具）`);
    }

    ctx.currentPlan = plan;
    ctx.emit({ t: "plan", plan });
    const warnNote = warnings.length ? ` · ⚠ ${warnings.length} 处需注意：${warnings.join("；")}` : "";
    return {
      ok: warnings.length === 0,
      summary: `已记录 BuildPlan v${ver}：${plan.agents.length} 个 agent (${plan.agents.map((a) => a.actionName).join(", ")})${warnNote}`,
      output: { plan, warnings, ontologyActions: knownActions },
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// P1-4: analyze_failure — persist a structured reflection so NEXT brain run
// for this domain starts wiser. The brain writes its own "lessons learned"
// after a failure (or notable success); load happens at brain.start().
// ────────────────────────────────────────────────────────────────────────────
const analyze_failure: BrainTool = {
  name: "analyze_failure",
  description:
    "把你刚刚观察到的失败（或难得的成功经验、隐蔽的坑）总结成一条结构化反思，存进 FailureReflection 表。【下一次】给这个域生成 agent 时，反思会自动注入你的系统提示——这就是跨次学习。在 sandbox 失败 + inspect_run 看清原因后调；finish 之前也可以总结成功经验。",
  parameters: params({
    kind: { type: "string", enum: ["failure", "success", "caveat"], description: "failure=失败根因 / success=有效模式 / caveat=隐蔽坑" },
    summary: { type: "string", description: "1 句：发生了什么" },
    root_cause: { type: "string", description: "为什么会这样（可空）" },
    lesson: { type: "string", description: "下次怎么避免/复制——【可操作】的一句" },
    failed_agent: { type: "string", description: "可选：出问题的 agent slug" },
  }, ["kind", "summary", "lesson"]),
  async execute(args, ctx) {
    const kind = String(args.kind ?? "failure");
    const lesson = String(args.lesson ?? "");
    try {
      const path = await writeReflectionRow({
        domain: ctx.domain,
        kind,
        summary: String(args.summary ?? ""),
        rootCause: typeof args.root_cause === "string" ? args.root_cause : null,
        lesson,
        ranAgents: ctx.specs.length ? JSON.stringify(ctx.specs.map((s) => s.short)) : null,
        failedAgent: typeof args.failed_agent === "string" ? args.failed_agent : null,
      });
      ctx.emit({ t: "reflect", kind, lesson });
      return { ok: true, summary: `已记录反思 (${kind})：${lesson.slice(0, 80)}` + (path === "raw" ? " · raw" : "") };
    } catch (e) {
      return { ok: false, summary: `反思保存失败：${(e as Error).message}` };
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
// R4-2: revert_refine — roll back the most recent refine_agent attempt.
// When R4-1's auto-score detects a regression (delta ≤ -10), the brain can
// undo the bad refine instead of compounding the mistake. Restores the prior
// systemPrompt + tools + decisionLogic from attemptHistory and rebuilds the
// spec. The reverted attempt entry stays in history (as evidence of a tried-
// but-rolled-back path) so we don't lose the audit trail.
// ────────────────────────────────────────────────────────────────────────────
const revert_refine: BrainTool = {
  name: "revert_refine",
  description:
    "回滚某个 agent 的最近一次 refine_agent 修订，把它恢复到 refine 前的状态。当 R4-1 自动评分告诉你某次 refine 让 agent 变差了（regression），与其继续凑合或再 refine 一次硬塞，不如直接 revert 回上一版本，换个角度想清楚再 refine。attemptHistory 不丢，留作 audit。",
  parameters: params({
    action: { type: "string", description: "要回滚的 action 名" },
  }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const current = ctx.specs.find((s) => s.actionName === name);
    if (!current) return { ok: false, summary: `agent「${name}」还没设计过。` };
    const history = ctx.attemptHistory[name] ?? [];
    if (!history.length) {
      return { ok: false, summary: `agent「${name}」从未 refine 过——没有可回滚的版本。如果想换个方向，直接调 design_agent 重写即可。` };
    }
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const action = ctx.ontology.actions.find((a) => a.name === name);
    if (!action) return { ok: false, summary: `本体里找不到动作「${name}」。` };
    const reg = ctx.registry ?? resolveRegistry(ctx.domain, ctx.ontology);
    ctx.registry = reg;

    // Restore from the most recent attempt's priorSpecSnapshot.
    const lastAttempt = history[history.length - 1];
    const restoredAuthored = {
      systemPrompt: lastAttempt.priorSpecSnapshot.systemPrompt,
      tools: [...lastAttempt.priorSpecSnapshot.tools],
      decisionLogic: lastAttempt.priorSpecSnapshot.decisionLogic ?? "",
    };
    const restoredSpec = buildSpecFromAction(action, ctx.domain, reg, {
      skills: ctx.createdSkills,
      research: ctx.research,
      authored: restoredAuthored,
      relevantRules: ctx.rulesByAction[name] ?? [], // R4-3
    });
    ctx.specs = ctx.specs.filter((s) => s.actionName !== name);
    ctx.specs.push(restoredSpec);
    ctx.lastSandbox = null; // spec changed → prior sandbox evidence is stale; must re-verify

    // Defer-persist: no mid-run draft write (finish persists on acceptance).

    ctx.emit({ t: "revert", actionName: name, revertedToAttempt: lastAttempt.attemptNumber - 1 });
    ctx.emit({
      t: "agent.created",
      spec: cardOf(restoredSpec),
      design: {
        reasoning: `回滚 refine #${lastAttempt.attemptNumber} (revert)`,
        systemPrompt: restoredSpec.systemPrompt,
        toolRationale: `(revert: 恢复 refine #${lastAttempt.attemptNumber} 之前的版本)`,
        decisionLogic: restoredAuthored.decisionLogic,
        code: restoredSpec.generatedCode,
        codeSource: restoredSpec.codeSource,
      },
    });
    return {
      ok: true,
      summary: `已回滚 agent「${restoredSpec.nameZh}」第 ${lastAttempt.attemptNumber} 次修订。当前是 refine 前的版本。建议换个角度再思考清楚问题，然后调 refine_agent 用新的 critique 修订；或者跑一次 sandbox_run 看看原版的表现到底是不是真的好。`,
      output: { actionName: name, revertedFromAttempt: lastAttempt.attemptNumber, currentAttemptCount: history.length },
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// R2-4: diff_spec — show what changed across refine attempts for an agent.
// Helps the brain decide whether a refine actually improved things, and lets
// the user audit revision history in the UI.
// ────────────────────────────────────────────────────────────────────────────
const diff_spec: BrainTool = {
  name: "diff_spec",
  description:
    "对比某个 agent 上一版 vs 当前版的差异：system prompt 是否变了、新加/移除了哪些工具、决策逻辑是否变了。沙箱失败 → refine 后，可以用它确认你的修订真的击中了问题；多次 refine 后回顾整个改进轨迹。",
  parameters: params({
    action: { type: "string", description: "agent 的 action 名" },
    attempt_index: { type: "number", description: "可选——对比哪一次 refine（默认对比最近一次）。-1 = 最近, 0 = 第一次，依次类推。" },
  }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const current = ctx.specs.find((s) => s.actionName === name);
    if (!current) return { ok: false, summary: `agent「${name}」还没设计过。` };
    const history = ctx.attemptHistory[name] ?? [];
    if (!history.length) return { ok: true, summary: `agent「${name}」从未 refine 过（只有初版 design_agent）。`, output: { actionName: name, attemptCount: 0 } };
    const idx = typeof args.attempt_index === "number" ? args.attempt_index : -1;
    const target = idx < 0 || idx >= history.length ? history[history.length - 1] : history[idx];
    const prior = target.priorSpecSnapshot;
    const priorTools = new Set(prior.tools);
    const currTools = new Set(current.tools);
    const added = current.tools.filter((t) => !priorTools.has(t));
    const removed = prior.tools.filter((t) => !currTools.has(t));
    // Coarse system-prompt diff (lines added/removed/unchanged count — keeps the
    // result compact; full diff bloat would burn LLM tokens).
    const priorLines = prior.systemPrompt.split("\n");
    const currLines = current.systemPrompt.split("\n");
    const priorLineSet = new Set(priorLines.map((l) => l.trim()).filter(Boolean));
    const currLineSet = new Set(currLines.map((l) => l.trim()).filter(Boolean));
    const addedLines = currLines.filter((l) => l.trim() && !priorLineSet.has(l.trim()));
    const removedLines = priorLines.filter((l) => l.trim() && !currLineSet.has(l.trim()));
    return {
      ok: true,
      summary: `agent「${name}」#${target.attemptNumber} diff: prompt ${addedLines.length}+ / ${removedLines.length}- 行 · 工具 ${added.length}+ / ${removed.length}- · ${target.changes}`,
      output: {
        actionName: name,
        attemptNumber: target.attemptNumber,
        critique: target.critique,
        changes: target.changes,
        promptDiff: {
          addedLineCount: addedLines.length,
          removedLineCount: removedLines.length,
          addedLinesPreview: addedLines.slice(0, 6).map((l) => l.slice(0, 200)),
          removedLinesPreview: removedLines.slice(0, 6).map((l) => l.slice(0, 200)),
        },
        toolsAdded: added,
        toolsRemoved: removed,
        priorSystemPromptLen: prior.systemPrompt.length,
        currentSystemPromptLen: current.systemPrompt.length,
      },
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// R3-2: score_spec — quantify per-agent design quality. Gives the brain (and
// the user, via the trace) a structured number on whether an agent is "good
// enough" yet, instead of relying on the LLM's gut feel. The score is
// rule-based + deterministic; the brain decides what to do with it.
// ────────────────────────────────────────────────────────────────────────────
const score_spec: BrainTool = {
  name: "score_spec",
  description:
    "给一个已设计的 agent 打分（0-100），覆盖四个维度：① 工具解析率（绑的工具有多少在工具库里真的有）；② prompt 富度（长度 + 是否 llm 现写 vs 模板回退）；③ 决策逻辑覆盖（emit 事件数 > 0 时是否在 prompt 里提到分支）；④ refine 健康度（refine 次数过多反而扣分）。设计完一轮后调它判断哪些 agent 还需要再 refine；finish 前可以调一次看整体平均分。",
  parameters: params({
    action: { type: "string", description: "要打分的 action 名" },
  }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `agent「${name}」还没设计。` };
    const history = ctx.attemptHistory[name] ?? [];
    const dims = scoreSpec(spec, history.length);
    const total = Math.round((dims.toolResolution + dims.promptRichness + dims.decisionCoverage + dims.refineHealth) / 4);
    const grade = total >= 85 ? "A" : total >= 70 ? "B" : total >= 55 ? "C" : "D";
    const weakest = (Object.entries(dims) as Array<[string, number]>)
      .sort((a, b) => a[1] - b[1])[0];
    return {
      ok: true,
      summary: `agent「${spec.nameZh}」总分 ${total}/100 (${grade}) · 最弱: ${weakest[0]}=${weakest[1]} · ${describeWeakness(weakest[0], weakest[1], spec)}`,
      output: { actionName: name, total, grade, dimensions: dims, attemptCount: history.length },
    };
  },
};

/** Score one spec across four orthogonal dimensions. Each returns 0-100. */
function scoreSpec(spec: GeneratedAgentSpec, refineCount: number): {
  toolResolution: number; promptRichness: number; decisionCoverage: number; refineHealth: number;
} {
  // Tool resolution: tools array vs. unresolvedTools.
  const totalRequested = spec.tools.length + (spec.unresolvedTools?.length ?? 0);
  const toolResolution = totalRequested === 0 ? 0 : Math.round((spec.tools.length / totalRequested) * 100);
  // Prompt richness: LLM-authored prompts score higher; short prompts penalized.
  const promptLen = spec.systemPrompt.length;
  let promptRichness: number;
  if (spec.promptSource === "fallback") promptRichness = 35;
  else if (spec.promptSource === "ontology") promptRichness = 65;
  else { // llm-authored
    if (promptLen < 200) promptRichness = 60;
    else if (promptLen < 400) promptRichness = 80;
    else if (promptLen < 1200) promptRichness = 95;
    else promptRichness = 85; // > 1200 chars likely bloated
  }
  // Decision coverage: when emit has multiple branches, prompt should mention them.
  if (spec.emit.length <= 1) {
    // single-emit agent — easy by definition.
    var decisionCoverage = 90;
  } else {
    const mentioned = spec.emit.filter((ev) => spec.systemPrompt.includes(ev)).length;
    decisionCoverage = Math.round((mentioned / spec.emit.length) * 100);
  }
  // Refine health: 0 refines = 95, 1 = 90, 2 = 80, 3 = 65, 4+ = 50 (struggling).
  const refineHealth = refineCount === 0 ? 95 : refineCount === 1 ? 90 : refineCount === 2 ? 80 : refineCount === 3 ? 65 : 50;
  return { toolResolution, promptRichness, decisionCoverage, refineHealth };
}

function describeWeakness(dim: string, score: number, spec: GeneratedAgentSpec): string {
  if (dim === "toolResolution") return score < 80 ? `${spec.unresolvedTools?.length ?? 0} 个工具找不到——检查工具名拼写或确认是否需要补到工具库` : "工具几乎全绑上了";
  if (dim === "promptRichness") return spec.promptSource !== "llm" ? "prompt 是模板/回退，建议 refine 现写" : `prompt ${spec.systemPrompt.length} 字符`;
  if (dim === "decisionCoverage") return `${spec.emit.length} 个分支事件，prompt 提到的不够全`;
  if (dim === "refineHealth") return "已多次 refine——若仍不达标，可能方向就错了，考虑 replan";
  return "";
}

// ────────────────────────────────────────────────────────────────────────────
// P3 — review_agent. An INDEPENDENT review pass (separate lens from the author):
//   · deterministic checks (free, reliable): branch coverage, tool grounding,
//     degraded flag — reviewSpecsDeterministic().
//   · semantic check (independent LLM judge, gateway-permitting): for agents that
//     carry MANDATORY business rules, is each rule actually ENCODED in the prompt?
//     Framed as cite-the-span so the judge must point at evidence, not just vote.
// Findings route by action so the brain calls refine_agent on the offenders.
// ────────────────────────────────────────────────────────────────────────────

/** Extract the first JSON array from possibly-fenced / prose-wrapped LLM text. */
function parseJsonArray(text: string): unknown[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Independent LLM judge: does each agent's prompt actually encode its mandatory
 *  rules? Returns ONLY the negative findings (rules-not-encoded). A rule-check
 *  agent that binds the dynamic rule-fetch tool counts as encoded. */
async function judgeRulesEncoded(
  items: Array<{ spec: GeneratedAgentSpec; rules: Array<{ id: string; name: string; rule: string }> }>,
  domain: string,
): Promise<ReviewFinding[]> {
  const sys =
    "你是一个严格的【独立】agent 审查员（不是设计者，带挑刺视角）。送来审查的都是【规则校验闸口】(rule-check / 查重 / 风控类 agent)。" +
    "判断它们有没有【正确接上动态抓规则的机制】——注意：正确做法【不是】把规则写进 prompt，而是 ① 绑定 ontology.fetchActionRules 工具 ② 在 prompt 里描述「从 payload 识别上下文 → 调 fetchActionRules 实时抓规则 → 逐条核对 → 命中强制规则发失败 → 数据不足 fail-close」。" +
    "binds_rule_fetch_tool=true 且 prompt 描述了这套动态机制 → encoded=true。若既没绑工具也没描述机制 → encoded=false。" +
    "对每个 agent 输出 {\"action\":string,\"encoded\":boolean,\"missingRuleHints\":string[],\"evidenceSpan\":string}。" +
    "encoded=true 时 evidenceSpan 给出 prompt 里体现「动态抓规则机制」的片段；false 时 missingRuleHints 说明缺了什么(没绑工具/没描述机制)。只输出 JSON 数组，不要任何其它文字。";
  const payload = items.map((x) => ({
    action: x.spec.actionName,
    mandatory_rules: x.rules.map((r) => ({ id: r.id, name: r.name, rule: (r.rule || "").slice(0, 200) })),
    binds_rule_fetch_tool: x.spec.tools.includes("ontology.fetchActionRules"),
    system_prompt: x.spec.systemPrompt.slice(0, 1500),
  }));
  const user = `域=${domain}。审查这些 agent 的强制规则是否编入 prompt：\n${JSON.stringify(payload, null, 2)}`;
  const res = await chatComplete({ system: sys, user, temperature: 0.5, maxTokens: 1600, model: FACTORY_STRONG_MODEL, toolName: "review_agent.judge" });
  const findings: ReviewFinding[] = [];
  for (const row of parseJsonArray(res.text)) {
    if (!row || typeof row !== "object") continue;
    const r = row as { action?: unknown; encoded?: unknown; missingRuleHints?: unknown };
    if (r.encoded === false) {
      const action = String(r.action ?? "");
      const spec = items.find((x) => x.spec.actionName === action)?.spec;
      if (!spec) continue;
      const hints = Array.isArray(r.missingRuleHints) ? (r.missingRuleHints as unknown[]).map(String).join("、") : "";
      findings.push({
        slug: spec.slug,
        actionName: action,
        kind: "rules-not-encoded",
        detail: `规则校验闸口没接上「动态抓规则」机制：${hints || "(应绑定 ontology.fetchActionRules 并在 prompt 描述 按 payload 抓规则→逐条核对→fail-close)"}。注意：不要把规则写进 prompt——要绑定 ontology.fetchActionRules 动态抓取。`,
      });
    }
  }
  return findings;
}

const review_agent: BrainTool = {
  name: "review_agent",
  description:
    "用一个【独立审查视角】(不同于你设计时的视角)复核你已生成的所有 agent：①确定性检查(代码算,免费可靠)——多分支 agent 的 prompt 是否覆盖每个分支事件、工具是否都接地、有没有降级占位;②语义检查(独立 LLM 审查员,网关可用时)——每个带强制业务规则的 agent,其 prompt 是否真把规则写进去了(要求审查员引用 prompt 片段为证)。返回逐 action 的问题清单——直接对有问题的 action 调 refine_agent。design 完一轮后建议跑一次。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.specs.length) return { ok: false, summary: "还没有 agent 可审查，请先 design_agent。" };
    const findings = reviewSpecsDeterministic(ctx.specs);

    // Semantic check — ONLY for rule-check / dedup-check GATES. A createJD /
    // matchResume / processResume / inviteInterview agent must NOT carry business
    // rules: rule enforcement is the dedicated rule-check (or dedup-check) gate's
    // job, and that gate does it by FETCHING rules dynamically (binding
    // ontology.fetchActionRules) — never by baking rules into a prompt. So a
    // non-gate agent is never judged on "rules encoded", even if the ontology
    // happens to attach rules to its action (that's design context, not a duty).
    let judgeAvailable = false;
    let judgeError: string | null = null;
    if (isGatewayConfigured()) {
      const withRules = ctx.specs
        .filter(isRuleCheckGate)
        .map((spec) => ({
          spec,
          rules: (ctx.rulesByAction[spec.actionName] ?? []).filter((r) => /mandatory|强制/i.test(r.enforcement)),
        }))
        .filter((x) => x.rules.length > 0);
      if (withRules.length) {
        try {
          findings.push(...(await judgeRulesEncoded(withRules, ctx.domain)));
          judgeAvailable = true;
        } catch (e) {
          judgeError = (e as Error).message;
        }
      }
    }

    // Route by action so the brain can refine the specific offenders.
    const byAction: Record<string, ReviewFinding[]> = {};
    for (const f of findings) (byAction[f.actionName] ??= []).push(f);
    ctx.emit({
      t: "validation",
      ok: findings.length === 0,
      issues: findings.map((f) => `${f.actionName}: ${f.detail}`),
      agentIssueMap: byAction as Record<string, unknown[]>,
    });

    const judgeNote = judgeError
      ? ` · ⚠ 语义审查跳过：${judgeError}`
      : !isGatewayConfigured()
        ? " · (LLM 网关未配置，仅做确定性审查)"
        : judgeAvailable
          ? "（含规则编入语义检查）"
          : "（无带强制规则的 agent，跳过语义检查）";
    const head =
      findings.length === 0
        ? `独立审查通过 ✓ 共 ${ctx.specs.length} 个 agent，无问题${judgeNote}`
        : `独立审查发现 ${findings.length} 处问题（${Object.keys(byAction).length} 个 agent）：${findings
            .slice(0, 5)
            .map((f) => `${f.actionName}「${f.detail}」`)
            .join("；")}——对这些 action 调 refine_agent 修正${judgeNote}`;
    return {
      ok: findings.length === 0,
      summary: head,
      output: { findingCount: findings.length, byAction, judgeAvailable },
    };
  },
};

const finish: BrainTool = {
  name: "finish",
  description:
    "完成任务并结束。必须传两个东西：① summary 给用户看的中文总结；② reflection 一条结构化反思，会写入 FailureReflection 表——下次为这个域生成时会自动出现在你的系统提示里。这就是跨次学习：不靠你下次记得，靠你这次把教训留下来。【即使成功也要写】(kind=success 写下成功模式)；失败更要写 (kind=failure)。",
  parameters: params({
    summary: { type: "string", description: "给用户的中文总结：造了哪些 agent、用了哪些工具、是否跑通、最终状态" },
    reflection: {
      type: "object",
      description: "结构化反思（必填）—— 下次的你会从这里学到东西",
      properties: {
        kind: { type: "string", enum: ["failure", "success", "caveat"], description: "failure=失败根因 / success=有效模式 / caveat=隐蔽坑" },
        summary: { type: "string", description: "一句话：这次发生了什么" },
        root_cause: { type: "string", description: "如果是 failure，根因是什么；success 留空也行" },
        lesson: { type: "string", description: "下次怎么避免 / 复制——可操作的一句" },
      },
      required: ["kind", "summary", "lesson"],
    },
  }, ["summary", "reflection"]),
  async execute(args, ctx) {
    // Acceptance gate (fully-AI, atomic). The run can only finish if the generated
    // set passes the SAME deterministic validation the brain sees from
    // validate_graph: every actor=Agent action covered, event graph closed, every
    // tool/event grounded, every prompt actually authored (no fallback template).
    // No force-allow, no degraded shells — if it doesn't pass, finish FAILS and the
    // brain must fix it (or the run fails honestly when the budget runs out).
    if (ctx.ontology) {
      const agentActions = ctx.ontology.actions.map((a) => ({ name: a.name, actor: a.actor }));
      const knownEvents = [...new Set(ctx.ontology.actions.flatMap((a) => [...a.trigger, ...a.triggered_event]))];
      const v = validateSpecs(ctx.specs, { agentActions, knownEvents, boundaryEvents: (ctx.boundaryEvents ?? []).filter((b) => b.kind !== "break").map((b) => b.event) });
      if (!v.ok) {
        const reasons = v.structuredIssues.slice(0, 8).map((i) => `${i.agentAction}「${i.message}」`);
        const msg = `还不能结束——生成结果未通过验收（${v.structuredIssues.length} 项问题）：${reasons.join("；")}。逐项修复后再 finish：覆盖每个 Agent 动作、事件图闭合、工具都接地、每个 prompt 必须你亲自写（不能用回退模板）。`;
        ctx.emit({ t: "message", text: msg });
        return { ok: false, summary: msg, output: { accepted: false, issueCount: v.structuredIssues.length, issues: v.structuredIssues } };
      }
    }
    // Fully-AI codegen gate (no render fallback): EVERY agent's .ts must be
    // hand-written by the LLM via codegen_agent (TS-compiler validated). A spec
    // without codeSource==="ai" can't finish — the brain must codegen it first.
    const missingCode = ctx.specs.filter((s) => s.codeSource !== "ai" || !s.generatedCode?.trim());
    if (missingCode.length) {
      const names = missingCode.map((s) => s.short).join("、");
      const msg = `还不能结束——这些 agent 还没有你亲手写的 .ts 代码：${names}。对每一个调用 codegen_agent 写出完整代码（会过 TS 编译校验），全部写完再 finish。本工厂【不用渲染兜底】，代码必须全部由你（LLM）写。`;
      ctx.emit({ t: "message", text: msg });
      return { ok: false, summary: msg, output: { accepted: false, missingCode: missingCode.map((s) => s.actionName) } };
    }
    // RANK-1 behavioral gate (verifier-in-the-loop): static closure + AI code is
    // NOT enough — the agents must ACTUALLY RUN end-to-end in the sandbox. We
    // require the last sandbox_run to (a) exist, (b) match the CURRENT specs
    // (fingerprint — not stale-green from before a refine), and (c) have run every
    // deployed agent. A 3/6 partial chain can no longer be rationalized into a
    // pass. This is the loop-until-green invariant: a refusal here makes the
    // conductor loop the brain back to fix + re-verify (result.ok guard).
    const fp = specsFingerprint(ctx.specs);
    const sb = ctx.lastSandbox;
    const degradedInSb = sb?.degradedAgents?.length ?? 0;
    // P0-1 (audit BLOCKER): require fullChainRan, not just agentsRan===deployed.
    // The sandbox coverage-pass fires every un-run agent's trigger DIRECTLY, so a
    // BROKEN chain (some agent's emit ≠ the next's trigger) can still reach
    // agentsRan===deployed while never connecting end-to-end. fullChainRan
    // (= !partial && reachedTerminal && no degraded) is the real "the chain
    // actually ran through" signal — it was computed but never gated on. Now it is.
    if (!sb || sb.specsFingerprint !== fp || sb.agentsRan < sb.deployed || degradedInSb > 0 || !sb.fullChainRan) {
      const why = !sb
        ? "还没真在沙箱里跑过——先 sandbox_run。"
        : sb.specsFingerprint !== fp
          ? "上次沙箱跑的是【改动前】的版本(你之后 design/refine/codegen 过)——证据过期了,重新 sandbox_run 验证当前版本。"
          : degradedInSb > 0
            ? `上次沙箱里这些 agent 是 degraded 兜底(不是真决策,通常是 LLM 网关挂了):${sb.degradedAgents.join("、")}——链路看似前进其实是假的,degraded 不算跑通。修好网关后重跑 sandbox_run。`
            : sb.agentsRan < sb.deployed
              ? `上次沙箱只有 ${sb.agentsRan}/${sb.deployed} 个 agent 真的跑起来,事件链没串完。`
              : `上次沙箱里每个 agent 都被触发跑过,但事件链没有自然走到终态(没有 reachedTerminal / 仍有断点)——很可能是某个 agent 的 emit 与下游 trigger 对不上,coverage 兜底把它单独喂起来掩盖了断链。用 verify_chain 定位断点再修。`;
      const msg = `还不能结束——${why}\n先用 verify_chain 看断在哪(哪个 agent 的 emit 和下游 trigger 对不上)→ refine_agent/codegen_agent 修 → 重新 sandbox_run,直到【全部 ${ctx.specs.length} 个 agent 都真跑起来、且无 degraded】再 finish。\n如果你已确认是数据/环境限制、真的无法跑通,【不要强行 finish】,改调 analyze_failure 诚实记录(kind=failure)。`;
      ctx.emit({ t: "message", text: msg });
      return { ok: false, summary: msg, output: { accepted: false, behavioralGate: false, lastSandbox: sb, expectedFingerprint: fp } };
    }
    // Gate passed → persist the final set to the Fleet draft store. This is the
    // ONLY persist point (defer-persist): a failed run never reaches here, so it
    // persists nothing and nothing deploys (atomic whole-run success/fail).
    try { await syncDomainDrafts(ctx.domain, ctx.specs); } catch { /* in-memory specs are the artifact */ }
    // Register the domain's Inngest app slot now that it has generated agents —
    // a keep-alive sentinel keeps `agentic-operator-<domain>` synced (green,
    // ready) even while every agent is still a draft, so deploying them later
    // just attaches to an already-registered app. Best-effort; dynamic import
    // keeps the heavy domain-app graph out of the tools module load.
    try {
      const { ensureDomainAppRegistered } = await import("@/server/inngest/domain-app");
      await ensureDomainAppRegistered(ctx.domain);
    } catch { /* slot registers on deploy */ }

    const summary = String(args.summary || "完成");
    const r = (args.reflection && typeof args.reflection === "object" ? args.reflection : {}) as Record<string, unknown>;
    const llmLesson = String(r.lesson ?? "").trim();
    const llmKind = String(r.kind ?? "").trim();
    const llmReflectionSummary = String(r.summary ?? "").trim();

    // R2-1: cross-run learning closure. Schema-required nested fields are
    // advisory in Gemini's tool-call mode — the model often calls finish with
    // just a `summary` and skips the reflection. We refuse to ship without one:
    // if the LLM gave a usable lesson, persist it; otherwise SYNTHESIZE a
    // structured reflection from the observable run state (refine count,
    // sandbox outcome, validation outcome, agent count). Either way the
    // FailureReflection table gets a row, so the next brain.start for this
    // domain has something to learn from.
    const sawSandbox = ctx.lastSandboxRunIds.length > 0;
    const refineCount = Object.values(ctx.attemptHistory).reduce((n, h) => n + h.length, 0);
    let kind: "failure" | "success" | "caveat";
    let lesson: string;
    let reflectionSummary: string;
    let rootCause: string | null;
    let autoGenerated = false;

    if (llmLesson && llmKind) {
      // Honor the brain's own reflection (it passed the acceptance gate to get
      // here). An invalid kind defaults to "caveat" — never auto-claim success.
      kind = (["failure", "success", "caveat"].includes(llmKind) ? llmKind : "caveat") as "failure" | "success" | "caveat";
      lesson = llmLesson;
      reflectionSummary = llmReflectionSummary || summary.slice(0, 200);
      rootCause = typeof r.root_cause === "string" ? r.root_cause : null;
    } else {
      // Auto-synthesized reflection (LLM omitted one). Never default to "success":
      // the durability write must not fabricate a positive verdict.
      autoGenerated = true;
      kind = "caveat";
      const planNote = ctx.currentPlan ? `按 BuildPlan v${ctx.currentPlan.version} (${ctx.currentPlan.agents.length} agent)` : "无显式计划";
      reflectionSummary = `${ctx.specs.length} 个 agent，${refineCount} 次 refine，沙箱 ${sawSandbox ? "已跑" : "未跑"}（${planNote}）`;
      rootCause = !sawSandbox ? "Brain 结束时未真实跑沙箱验证" : null;
      lesson = refineCount > 0
        ? `${refineCount > 2 ? "多次" : "少量"} refine 后通过验收——下次为同域生成时，重点关注首次 design 时容易遗漏的边界 (refine 集中在哪个 agent 上看 attemptHistory)。`
        : sawSandbox
          ? "首次 design + 沙箱直接通过——可以尝试更精炼或并行的事件链结构。"
          : "下次结束前先跑 sandbox_run——验证事件链是否真闭合。";
    }

    let reflectionSaved = false;
    try {
      await writeReflectionRow({
        domain: ctx.domain,
        kind,
        summary: reflectionSummary,
        rootCause,
        lesson,
        ranAgents: ctx.specs.length ? JSON.stringify(ctx.specs.map((s) => s.short)) : null,
      });
      reflectionSaved = true;
      ctx.emit({ t: "reflect", kind, lesson });
    } catch { /* never fail finish on a DB hiccup */ }

    const note = !reflectionSaved
      ? "（反思写入失败）"
      : autoGenerated
        ? `· 自动生成反思 (${kind})，下次为「${ctx.domain}」生成时会自动注入`
        : `· 已写入反思 (${kind})，下次为「${ctx.domain}」生成时会自动注入到你的系统提示`;
    return {
      ok: true,
      summary: `${summary} ${note}`,
      output: { done: true, reflectionSaved, autoGenerated, reflection: { kind, lesson, summary: reflectionSummary, rootCause } },
    };
  },
};

// codegen_agent — the LLM hand-writes the runnable Inngest .ts for an agent it
// already designed, validated by the real TS compiler. Replaces the deterministic
// render with genuinely AI-written code (codeSource="ai"). The deployed path still
// runs via the generic executor; this is the inspectable, AI-authored artifact.
const codegen_agent: BrainTool = {
  name: "codegen_agent",
  description:
    "把你【已经 design_agent 设计好】的某个 agent,【亲手写成可运行的 Inngest .ts 代码】(替换系统自动渲染的脚手架,标记为「AI 亲写」)。结构:① import——用 availableTools 里你绑定的每个工具的 `import` 字段(真实模块路径)+ `import { inngest } from '@/server/inngest/client'` + `import { chatComplete } from '@/server/llm/gateway'`(规则校验类再 import fetchOntologyActionRules);② 用你写的 input_schema/output_schema 定义 `interface <Name>Input/<Name>Output`(字段类型来自 DataObjects);③ `const SYSTEM_PROMPT = \\`<你写的那段>\\``;④ `export const <name>Agent = inngest.createFunction({ id:'<slug>', name, retries, triggers:[{event:'<trigger事件>'}] }, async ({ event, step }) => { ... })`;⑤ 每个工具一个 `await step.run(...)`;⑥ `chatComplete({ system: SYSTEM_PROMPT, user })` 做决策;⑦ 按 decision 用 `step.sendEvent` 发结果事件,覆盖你 design 的每个分支。提交后会用 TS 编译器校验语法——有错会把错误返给你让你改。设计完每个 agent 后调它一次。",
  parameters: params({
    action: { type: "string", description: "要写代码的 action 名(必须是你已 design_agent 过的)" },
    code: { type: "string", description: "你亲手写的完整 .ts(从 import 到 createFunction 一整个文件)" },
  }, ["action", "code"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const code = String(args.code ?? "");
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `还没设计过「${name}」——先 design_agent 再 codegen_agent。` };
    if (code.trim().length < 80) return { ok: false, summary: "代码太短/为空,请把完整 .ts(import + interface + createFunction)写全。" };
    const { ok, errors } = await validateAgentCode(code);
    if (!ok) return { ok: false, summary: `代码没过 TS 语法校验(${errors.length} 处),修好再交:\n- ${errors.slice(0, 6).join("\n- ")}` };
    // P1 deeper-than-syntax validation: (a) imports must resolve to the real tool
    // library / inngest / gateway / ontology-rules modules (no invented modules);
    // (b) event names in the code must be the agent's real trigger/emit (or
    // ontology events) — not hallucinated. transpile only proves it parses.
    const reg = ctx.registry ?? resolveRegistry(ctx.domain, ctx.ontology ?? undefined);
    const allowedModules = new Set<string>(["@/server/inngest/client", "@/server/llm/gateway", "@/lib/ontology-rules"]);
    for (const tn of spec.tools) { const d = reg.get(tn); if (d?.impl?.module) allowedModules.add(d.impl.module); }
    const importedModules = [...code.matchAll(/import\s+[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const badImports = importedModules.filter((src) => !allowedModules.has(src));
    if (badImports.length) {
      return { ok: false, summary: `代码 import 了未授权/不存在的模块:${badImports.join("、")}。只能 import:本 agent 绑定工具的真实模块(见 availableTools 的 import 字段)+ @/server/inngest/client + @/server/llm/gateway${spec.tools.includes("ontology.fetchActionRules") ? " + @/lib/ontology-rules" : ""}。改对再交。` };
    }
    const knownEv = new Set<string>([...(spec.trigger ?? []), ...(spec.emit ?? [])]);
    if (ctx.ontology) for (const a of ctx.ontology.actions) { for (const e of a.triggered_event ?? []) knownEv.add(e); for (const t of a.trigger ?? []) knownEv.add(t); }
    const badEvents = ungroundedEventTokens([code], knownEv);
    const eventWarn = badEvents.length ? ` · ⚠ 代码里出现了非本体事件名:${badEvents.join("、")}(用本 agent 的真 trigger/emit,否则链对不上)` : "";
    spec.generatedCode = code;
    spec.codeSource = "ai";
    // P1-1 (audit MAJOR): writing new code makes any prior sandbox evidence stale —
    // null it like design/refine/revert do (L544/985/1284). Without this, a
    // design→codegen→sandbox→inspect-finds-bug→codegen-fix sequence kept the OLD
    // code's green sandbox valid (codeSource still "ai", signature unchanged) and
    // finish would pass the NEW code on the OLD evidence. Now codegen forces re-verify.
    ctx.lastSandbox = null;
    // re-emit so the per-agent code card updates to the AI-written version live
    ctx.emit({
      t: "agent.created",
      spec: cardOf(spec),
      design: {
        // preserve the brain's REAL design reasoning / tool rationale / decision
        // logic from design_agent (codegen wrote the code, it didn't re-reason
        // those) — only fall back to the codegen call's reasoning if none stored.
        reasoning: spec.designReasoning || (typeof args.reasoning === "string" ? args.reasoning : ""),
        systemPrompt: spec.systemPrompt,
        toolRationale: spec.toolRationale || "(见 system prompt)",
        decisionLogic: spec.decisionLogic || "(见 system prompt)",
        code,
        codeSource: "ai",
      },
    });
    return { ok: true, summary: `✅「${spec.short}」的 .ts 代码已由你亲手写定,过了 TS 语法校验 + import/事件接地校验,标记为「AI 亲写」(${code.split("\n").length} 行)。${eventWarn}` };
  },
};

// RANK-4: deterministic chain analyzer. The break point of an event chain (an
// upstream emit set ∩ downstream trigger set = ∅) is pure computation — it must
// NOT be delegated to a possibly-hallucinating LLM. verify_chain computes
// reachability from entry events and names exactly which agent is unreachable
// and why, so a sandbox refusal drives a TARGETED fix, not blind retrying.
const verify_chain: BrainTool = {
  name: "verify_chain",
  description:
    "确定性地分析当前所有 agent 的事件链:从入口事件出发做可达性遍历,代码算出【断点】——哪个 agent 不可达(没有任何上游 agent 发出它监听的 trigger 事件)、哪个 emit 事件没人消费(悬空)。再对照上次 sandbox 实际跑了哪些 agent。沙箱没全跑通时【先调它】定位断点,再针对性 refine_agent/codegen_agent 修,别瞎试。",
  parameters: params({}),
  async execute(_args, ctx) {
    const specs = ctx.specs;
    if (!specs.length) return { ok: false, summary: "还没有 agent 可分析,先 design_agent。" };
    const emitters = new Map<string, string[]>();
    const consumers = new Map<string, string[]>();
    const push = (m: Map<string, string[]>, k: string, v: string) => { const a = m.get(k) ?? []; a.push(v); m.set(k, a); };
    for (const s of specs) {
      for (const e of s.emit ?? []) if (e && e !== "—") push(emitters, e, s.short);
      for (const t of s.trigger ?? []) if (t && t !== "—") push(consumers, t, s.short);
    }
    // Ground "entry" events in the ONTOLOGY (real entries = ontology triggers no
    // ontology action emits), NOT in the spec graph — otherwise a typo'd trigger
    // (RESUME_PROCESSED when the producer emits the hallucinated RESUME_PARSED)
    // looks like a valid entry and the break hides. A spec trigger that nobody
    // emits AND isn't a real ontology entry IS the break point.
    const realEntries = new Set<string>();
    if (ctx.ontology) {
      const ontEmits = new Set<string>();
      const ontTrigs = new Set<string>();
      for (const a of ctx.ontology.actions) { for (const e of a.triggered_event ?? []) ontEmits.add(e); for (const t of a.trigger ?? []) ontTrigs.add(t); }
      for (const t of ontTrigs) if (!ontEmits.has(t)) realEntries.add(t);
    }
    // orphan triggers a spec listens on but no spec emits; the BREAKS are those
    // that aren't real ontology entries. (No ontology → can't distinguish entry
    // from typo, so don't false-flag — only sandbox evidence judges then.)
    const orphanTriggers = [...consumers.keys()].filter((t) => !emitters.has(t));
    const breakTriggers = ctx.ontology ? orphanTriggers.filter((t) => !realEntries.has(t)) : [];
    const breaks = specs
      .filter((s) => (s.trigger ?? []).some((t) => breakTriggers.includes(t)))
      .map((s) => {
        const ot = (s.trigger ?? []).filter((t) => breakTriggers.includes(t));
        return { agent: s.short, action: s.actionName, trigger: s.trigger, orphanTriggers: ot, fix: `没有上游 agent 发出 ${ot.join("/")}(也不是本体入口事件)——要么让上游某 agent 的 emit 改成这个、要么把本 agent 的 trigger 改成某上游真发出的事件(对照本体真事件名)` };
      });
    const dangling = [...emitters.keys()].filter((e) => !consumers.has(e)); // emitted, nobody consumes (terminal or gap)
    const sbNote = ctx.lastSandbox
      ? `上次沙箱:${ctx.lastSandbox.agentsRan}/${ctx.lastSandbox.deployed} 真跑${ctx.lastSandbox.fullChainRan ? "、全链路跑通" : "、链未串完"}。`
      : "还没跑过 sandbox。";
    const ok = breaks.length === 0;
    return {
      ok,
      summary: ok
        ? `✓ 事件链对齐 OK:入口 ${[...realEntries].join("/") || "(本体未知)"},${specs.length} 个 agent 的 trigger 都有上游产出或是真入口。${dangling.length ? `悬空(终态/无消费)事件:${dangling.join("、")}。` : ""}${sbNote}`
        : `✗ 链有断点:${breaks.length} 个 agent 的 trigger 没人产出且不是真入口 → ${breaks.map((b) => `${b.agent}(缺上游发 ${b.orphanTriggers.join("/")})`).join("；")}。${sbNote} 对齐这些 trigger/emit(用本体真事件名)后重跑 sandbox_run。`,
      output: { realEntries: [...realEntries], breaks, danglingEvents: dangling, total: specs.length, lastSandbox: ctx.lastSandbox },
    };
  },
};

export const P1_TOOLS: BrainTool[] = [
  read_ontology,
  verify_chain,       // RANK-4 — deterministic chain break locator
  create_plan,        // P1-3 — decompose first (now self-validates vs ontology)
  list_agents,        // P1-2 — see what you already built
  read_spec,          // P1-2 — inspect a specific prior design
  design_agent,       // first-time creation
  reuse_agent,        // ④ — adopt a signature-matching previously-built agent instead of re-designing
  codegen_agent,      // AI hand-writes the .ts (TS-compiler validated) — codeSource="ai"
  refine_agent,       // P0-3 — iterative revision (preserves history + emits diff) + R4-1 auto-score regression
  revert_refine,      // R4-2 — undo a bad refine attempt
  diff_spec,          // R2-4 — see what a refine actually changed
  score_spec,         // R3-2 — quantify per-agent quality (0-100 + grade)
  validate_graph,     // P0-2 — structured agent backref + P0/P2 coverage & groundedness
  propose_boundary_events, // boundary events → user classifies external-handoff/terminal/break
  review_agent,       // P3 — independent review (deterministic + LLM rules-encoded judge)
  generate_test_cases,// Feature 2 — author full-flow test cases for user approval before sandbox
  sandbox_run,        // real deploy (now streams sandbox.progress phases)
  inspect_run,        // P0-1 — see WHY sandbox failed (now supports failed_only)
  analyze_failure,    // P1-4 — write cross-run lesson
  finish,             // R2-1 — finish auto-writes a reflection (required field)
];

/** Side-effect-free subset given to isolated sub-agents (read + report only).
 *  Sub-brains can RESEARCH (read ontology, list specs, read individual specs,
 *  inspect prior runs, diff revisions) — they cannot mutate
 *  (no design/refine/sandbox/finish-write-reflection). */
export const READONLY_TOOLS: BrainTool[] = [read_ontology, list_agents, read_spec, inspect_run, diff_spec, score_spec, finish];
