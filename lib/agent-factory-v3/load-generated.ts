// ③ Run the AI-WRITTEN .ts in the sandbox (full dynamic execution).
//
// The factory makes the brain hand-write each agent's Inngest .ts (codegen_agent,
// TS-compiler validated) — but historically the sandbox ran a GENERIC interpreter of
// the spec (executeGeneratedAgent), not that code. So "验证通过" proved a re-
// interpretation ran, not the code you'd deploy. This module closes that gap: it
// compiles the generated .ts, loads it through a require-shim of allowlisted deps,
// and returns its REAL Inngest function so the sandbox runs the actual code.
//
// SAFETY (this executes LLM-written code):
//   · ONLY called for sandbox domains (isSandboxDomain) — never a real domain runtime.
//   · require() is shimmed to a FINITE allowlist (inngest client / gateway / ontology
//     rules / the agent's bound tool modules) — an unknown import resolves to {}.
//   · bound tools run dry-run (mock) in the sandbox — no real external side effects.
//   · any compile/load/run failure → returns null → caller falls back to the shell
//     executor, so a bad codegen can never brick the sandbox.
//   · kill-switch: FACTORY_EXEC_GENERATED=0 disables it entirely.

import type { Inngest } from "inngest";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import { resolveRegistry } from "@/lib/tools/resolve-registry";
import * as gatewayMod from "@/server/llm/gateway";
import * as ontologyRulesMod from "@/lib/ontology-rules";

type AnyFn = (...args: unknown[]) => unknown;

/** Compile + load the spec's AI-written .ts and return its real Inngest function,
 *  or null (→ caller uses the shell executor). Best-effort, never throws. */
export async function loadGeneratedAgentFunction(
  spec: GeneratedAgentSpec,
  domain: string,
  client: Inngest,
): Promise<unknown | null> {
  if (process.env.FACTORY_EXEC_GENERATED === "0") return null;
  const code = spec.generatedCode;
  if (!code || spec.codeSource !== "ai" || code.trim().length < 60) return null;
  try {
    const ts = await import("typescript");
    const js = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;

    // ── require shim: only the allowlisted modules the codegen import-guard permits ──
    const reg = resolveRegistry(spec.domainId ?? domain);
    const toolModules: Record<string, Record<string, AnyFn>> = {};
    for (const d of reg.list()) {
      if (!d.impl) continue;
      const exec = d.execute;
      (toolModules[d.impl.module] ??= {})[d.impl.export] = ((...a: unknown[]) =>
        exec ? exec((a[0] ?? {}) as Record<string, unknown>, { dryRun: true }) : Promise.resolve({ __mock: true, tool: d.name })) as AnyFn;
    }
    const inngestProxy = makeNamespacingProxy(client, domain);
    const requireShim = (mod: string): unknown => {
      if (mod === "@/server/inngest/client") return { inngest: inngestProxy };
      if (mod === "@/server/llm/gateway") return gatewayMod;
      if (mod === "@/lib/ontology-rules") return ontologyRulesMod;
      if (toolModules[mod]) return toolModules[mod];
      return {}; // unknown import (codegen allowlist should prevent this) → harmless empty
    };

    const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function("require", "exports", "module", js) as (
      r: (m: string) => unknown, e: Record<string, unknown>, m: { exports: Record<string, unknown> },
    ) => void;
    factory(requireShim, moduleObj.exports, moduleObj);

    // The generated module exports exactly one `export const xAgent = inngest.createFunction(...)`.
    // Find the Inngest-function-shaped export (skip __esModule boolean / strings).
    const candidates = Object.values(moduleObj.exports).filter((v) => v && typeof v === "object" && !Array.isArray(v));
    const fn = candidates.find(isInngestFunction) ?? candidates[0] ?? null;
    return fn ?? null;
  } catch (e) {
    console.warn(`[load-generated] ${spec.slug}: 加载生成代码失败(${(e as Error).message}) — 回退通用 executor`);
    return null;
  }
}

/** Lenient detector for an Inngest function instance (shape varies by version). */
function isInngestFunction(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "function" || typeof o.id === "string" || "opts" in o || "fn" in o || "absoluteId" in o;
}

/** A stand-in `inngest` client whose createFunction namespaces the generated code to
 *  the isolated sandbox: triggers get the `${domain}/` prefix, and the handler's
 *  step.sendEvent prefixes emitted names + preserves `_runId` (so the chain stays
 *  connected and per-case assertion can trace it). The generated code keeps writing
 *  BARE event names — the proxy bridges to the namespaced sandbox transparently. */
function makeNamespacingProxy(client: Inngest, domain: string) {
  const ns = (name: unknown) => (typeof name === "string" && !name.includes("/") ? `${domain}/${name}` : name);
  return {
    createFunction(config: Record<string, unknown>, handler: AnyFn, ...rest: unknown[]) {
      const rawTriggers = (config as { triggers?: unknown }).triggers;
      const triggers = Array.isArray(rawTriggers)
        ? rawTriggers.map((t) => ({ ...(t as object), event: ns((t as { event?: unknown }).event) }))
        : rawTriggers;
      const nsConfig = { ...config, triggers };
      const wrapped = async (ctx: Record<string, unknown>) => {
        const event = ctx.event as { name?: string; data?: Record<string, unknown> } | undefined;
        const incomingRunId = event?.data?._runId;
        const deNs = event ? { ...event, name: typeof event.name === "string" ? event.name.replace(`${domain}/`, "") : event.name } : event;
        const step = ctx.step ? wrapStep(ctx.step, domain, incomingRunId) : ctx.step;
        return handler({ ...ctx, event: deNs, step });
      };
      return (client.createFunction as AnyFn)(nsConfig, wrapped, ...rest);
    },
    send: client.send ? client.send.bind(client) : undefined,
  };
}

/** Proxy `step` so step.sendEvent namespaces the emitted event name + injects the
 *  triggering run's _runId (keeps the chain connected + case-traceable) even if the
 *  generated code forgot to propagate it. All other step methods pass through. */
function wrapStep(step: unknown, domain: string, runId: unknown) {
  const ns = (name: unknown) => (typeof name === "string" && !name.includes("/") ? `${domain}/${name}` : name);
  const fix = (p: unknown) => {
    if (!p || typeof p !== "object") return p;
    const o = p as { name?: unknown; data?: Record<string, unknown> };
    const data = { ...(o.data ?? {}) };
    if (runId != null && data._runId == null) data._runId = runId;
    return { ...o, name: ns(o.name), data };
  };
  return new Proxy(step as Record<string, unknown>, {
    get(target, prop, recv) {
      if (prop === "sendEvent") {
        return (id: string, payload: unknown) =>
          (target.sendEvent as AnyFn)(id, Array.isArray(payload) ? payload.map(fix) : fix(payload));
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? (v as AnyFn).bind(target) : v;
    },
  });
}
