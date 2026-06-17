import { Bus } from "./bus";
import { comprehendDomain } from "./comprehend";
import { plan } from "./builders/planner";
import { generateAgents } from "./generate";
import { buildSkills } from "./builders/skillsmith";
import { validateSpecs, type ValidationResult } from "./builders/validator";
import { simulateChain, type SmokeResult } from "./smoke";
import { fix } from "./builders/fixer";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import { resolveRegistry } from "@/lib/tools/resolve-registry";
import type { BuildEvent, BuildBudget, BuilderCtx, BuildPlan, DomainUnderstanding, SkillSpec, Deployer } from "./types";
import type { LlmCallRow } from "./ledger";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

/** Injected persistence contract — decouples Conductor from Prisma (tests use in-memory). */
export interface BuildStore {
  createRun(domain: string): Promise<string /* runId */>;
  appendEvent(runId: string, seq: number, e: BuildEvent): Promise<void>;
  appendLlmCall(row: LlmCallRow): Promise<void>;
  finishRun(runId: string, status: "done" | "failed", tokensUsed: number): Promise<void>;
}

export interface RunBuildOptions {
  domain: string;
  store: BuildStore;
  onEvent: (e: BuildEvent) => void;
  budget?: BuildBudget;
  /** When present, the conductor SHIPS the generated specs to a real per-domain
   *  Inngest app and fires/observes a real run after smoke passes. Omitted in
   *  hermetic tests (in-process only). Injected by the build route. */
  deployer?: Deployer;
}

export interface RunBuildResult {
  runId: string;
  understanding: DomainUnderstanding;
  plan: BuildPlan;
  skills: SkillSpec[];
  specs: GeneratedAgentSpec[];
  validation: ValidationResult;
  smoke: SmokeResult;
  repairs: number;
}

const DEFAULT_BUDGET: BuildBudget = {
  maxTokens: 2_000_000,
  maxLlmCalls: 250, // headroom: comprehend(5) + up to MAX_REPLAN+1 rounds of plan+skills+per-agent builders
};

const MAX_REPAIR = 3;
const MAX_REPLAN = 2;

export async function runBuild(opts: RunBuildOptions): Promise<RunBuildResult> {
  const { domain, store, onEvent, budget = DEFAULT_BUDGET } = opts;

  // Create the run record
  const runId = await store.createRun(domain);

  const bus = new Bus();

  // Wire bus → store.appendEvent (persists every event with seq)
  bus.subscribe((seq, e) => {
    store.appendEvent(runId, seq, e).catch(() => { /* non-fatal */ });
  });

  // Wire bus → caller's onEvent (SSE fan-out)
  bus.subscribe((_seq, e) => {
    try { onEvent(e); } catch { /* isolate caller failures */ }
  });

  // Build the persist function for LLM calls
  const persistLlm = (row: LlmCallRow) => store.appendLlmCall(row);

  // Fetch ontology
  const ontology = await fetchRunnableOntology(domain);

  // Resolve tool registry for this domain
  const registry = resolveRegistry(domain, ontology);

  // Build the BuilderCtx
  const ctx: BuilderCtx = {
    runId,
    domain,
    ontology,
    registry,
    emit: (e: BuildEvent) => bus.emit(e),
    budget,
    spent: { tokens: 0, calls: 0 },
  };

  let understanding: DomainUnderstanding;
  let buildPlan: BuildPlan;
  let skills: SkillSpec[];
  let specs: GeneratedAgentSpec[];
  let validation: ValidationResult;
  let smoke: SmokeResult;
  let repairs = 0;

  try {
    // Emit build.start — include de-mock visibility for ontology source
    bus.emit({ t: "build.start", domain, source: ontology.source });

    // De-mock visibility: log whether ontology came from Neo4j or snapshot fallback
    bus.emit({
      t: "log",
      line: ontology.source === "snapshot"
        ? "⚠ 本体来自 snapshot 兜底(Neo4j 无该域数据)"
        : "本体来自 Neo4j(:7688)",
    });

    // Stage 1: comprehension (4 facet analysts → integrator → DomainUnderstanding)
    understanding = await comprehendDomain(ctx, persistLlm);

    // Stages 2-5: plan → skills → generate → validate, wrapped in a bounded
    // RE-PLAN loop. When the generated set fails static graph closure (dangling
    // emits / orphan triggers), the closure issues are fed BACK to the Planner so
    // it re-decomposes — correcting structural decomposition errors the per-spec
    // smoke/fixer loop (below) can't. The Planner reasons each attempt freely;
    // the deterministic 1:1 fallback only kicks in if the gateway is down.
    // Every plan()/builder call is now a real LLM call or it throws (no
    // fallback), so re-planning genuinely re-reasons each attempt.
    let replanFeedback: string | undefined;
    // eslint-disable-next-line no-constant-condition
    for (let planAttempt = 0; ; planAttempt++) {
      if (planAttempt > 0) {
        bus.emit({ t: "replan", attempt: planAttempt, reason: replanFeedback ?? "" });
      }

      buildPlan = await plan(ctx, understanding, persistLlm, replanFeedback);
      skills = await buildSkills(ctx, buildPlan.skills, persistLlm);
      specs = await generateAgents(ctx, buildPlan, persistLlm, skills);
      validation = validateSpecs(specs);
      ctx.emit({ t: "validation", ok: validation.ok, issues: validation.issues });

      if (validation.ok || planAttempt >= MAX_REPLAN) break;

      const fbParts: string[] = [];
      if (validation.danglingEmits.length)
        fbParts.push(`悬空 emit(被发出但无人消费,需让其它 agent 消费,或确认它是终止事件): ${validation.danglingEmits.join(", ")}`);
      if (validation.orphanTriggers.length)
        fbParts.push(`孤儿 trigger(被消费但无人产出,需让某 agent 发出它,或确认它是入口事件): ${validation.orphanTriggers.join(", ")}`);
      if (validation.emptyToolAgents.length)
        fbParts.push(`无工具的 agent(应合并或补工具): ${validation.emptyToolAgents.join(", ")}`);
      replanFeedback = fbParts.join("\n");
    }

    // Stage 6: smoke simulation + self-repair loop
    smoke = await simulateChain(specs, registry);

    while (!smoke.passed && repairs < MAX_REPAIR) {
      repairs++;

      // Collect the set of spec.short values that need repair
      const failingShorts = new Set<string>();

      // Unreached agents
      for (const short of smoke.unreached) failingShorts.add(short);

      // Agents that caused tool errors
      for (const { agent } of smoke.errors) failingShorts.add(agent);

      // Dangling event owners: find specs that emit any dangling event
      for (const ev of smoke.dangling) {
        for (const spec of specs) {
          if (spec.emit.includes(ev)) failingShorts.add(spec.short);
        }
      }

      // Run fixer for each failing spec and replace in specs array
      const nextSpecs = [...specs];
      for (const short of failingShorts) {
        const idx = nextSpecs.findIndex((s) => s.short === short);
        if (idx === -1) continue;

        const spec = nextSpecs[idx];

        // Determine failure kind + detail for this spec
        const toolErr = smoke.errors.find((e) => e.agent === short);
        const isUnreached = smoke.unreached.includes(short);
        const danglingEmit = smoke.dangling.find((ev) => spec.emit.includes(ev));

        let kind: "dangling" | "unreached" | "tool-error" = "unreached";
        let detail = `spec ${short} is unreached`;

        if (toolErr) {
          kind = "tool-error";
          detail = toolErr.error;
        } else if (isUnreached) {
          kind = "unreached";
          detail = `agent ${short} has no entry path from any external event`;
        } else if (danglingEmit) {
          kind = "dangling";
          detail = `event ${danglingEmit} is emitted by ${short} but has no consumer`;
        }

        const { spec: patchedSpec } = await fix(ctx, spec, { kind, detail }, persistLlm);
        nextSpecs[idx] = patchedSpec;
      }

      specs = nextSpecs;
      smoke = await simulateChain(specs, registry);
    }

    // Fold the REAL smoke result into per-agent confidence: an agent the chain
    // couldn't reach, that emits a dangling event, or that errored in a tool step
    // must NOT advertise high confidence regardless of its Critic score.
    for (const spec of specs) {
      const failedSmoke =
        smoke.unreached.includes(spec.short) ||
        smoke.dangling.some((ev) => spec.emit.includes(ev)) ||
        smoke.errors.some((e) => e.agent === spec.short);
      if (failedSmoke) spec.confidence = Math.min(spec.confidence, 40);
    }

    // Emit smoke.result
    bus.emit({ t: "smoke.result", passed: smoke.passed, ran: smoke.ranAgents.length, repairs });

    // Emit needs-human if we exhausted repair budget without passing
    if (!smoke.passed) {
      const unreachedList = smoke.unreached.join(", ") || "unknown";
      const reason = `Smoke check did not pass after ${MAX_REPAIR} repair attempts. Unreached: [${unreachedList}]. Dangling: [${smoke.dangling.join(", ")}]. Errors: ${smoke.errors.length}.`;
      bus.emit({ t: "needs-human", reason });
    }

    // ── Ship + real run ──────────────────────────────────────────────────────
    // Only when a Deployer is injected AND the chain passed smoke: persist the
    // specs as deployable AgentVersion rows, bring the per-domain Inngest app
    // online, then fire the entry events and observe the REAL run in the archive.
    // (Hermetic builds have no deployer → this is skipped, staying in-process.)
    if (opts.deployer && smoke.passed) {
      try {
        bus.emit({ t: "ship.start", count: specs.length });
        const shipReport = await opts.deployer.ship(domain, specs);
        bus.emit({
          t: "ship.done",
          versionLabel: shipReport.versionLabel,
          deployed: shipReport.deployed,
          appRegistered: shipReport.appRegistered,
          error: shipReport.error,
        });
        if (shipReport.deployed.length > 0 && shipReport.appRegistered) {
          const runReport = await opts.deployer.observe(domain, specs);
          bus.emit({ t: "run.fired", events: runReport.fired });
          bus.emit({
            t: "run.observed",
            runs: runReport.runs,
            events: runReport.events,
            reachedTerminal: runReport.reachedTerminal,
          });
        }
      } catch (e) {
        bus.emit({ t: "log", line: `⚠ 上架/真实运行失败: ${(e as Error).message}` });
      }
    }

    // Emit build.done with final counts.
    bus.emit({
      t: "build.done",
      tokensUsed: ctx.spent.tokens,
    });

    // A build whose chain never passed smoke is recorded "failed" (it handed off
    // to a human) — not silently "done".
    const finalStatus: "done" | "failed" = smoke.passed ? "done" : "failed";
    await store.finishRun(runId, finalStatus, ctx.spent.tokens);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { bus.emit({ t: "error", message }); } catch { /* ignore */ }
    await store.finishRun(runId, "failed", ctx.spent.tokens).catch(() => {});
    throw err;
  }

  return { runId, understanding, plan: buildPlan, skills, specs, validation, smoke, repairs };
}
