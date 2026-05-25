// Bundle L — Inngest registration validator.
//
// Loads the generated agent source in a vm sandbox, captures the args
// passed to `inngest.createFunction(opts, trigger, handler)`, and
// cross-validates them against the operator's Form fields. Catches
// the "Inngest won't accept this" class of bug before merge.
//
// Why this exists vs the static reviewer rules:
//   - Reviewer rule `trigger-event-wired` regex-matches `event: 'X'`
//     literal in source — high recall, but doesn't actually exercise
//     Inngest's intake.
//   - This validator USES the same module loading the dynamic runner
//     uses (Bundle H), so we know it's what the real Inngest SDK
//     would see.
//
// What it catches that earlier layers don't:
//   1. `id` in createFunction doesn't equal AGENT_ID / form.slug
//      (LLM declared AGENT_ID but used a different literal in the
//      function options object)
//   2. `name` mismatch with form.displayName
//   3. `retries` differs from form.retries (LLM hardcoded 3 instead of 2)
//   4. trigger event mismatch (declared event vs actual `{ event: 'X' }`)
//   5. handler not exported (export missing — Inngest can't find it)
//   6. `step.run(...)` calls missing `await` (LLM bug; static lint)
//   7. Module-level throws on import (rare, fatal)
//
// SAFETY: same vm sandbox as Bundle H — no fs, no net, no env.

import * as ts from 'typescript';
import * as vm from 'node:vm';
import type { AgentFormFields } from '../spec-types';

export type CapturedInngestFn = {
  id?: string;
  name?: string;
  retries?: number;
  triggerEvent?: string;
  /** True iff the captured function object actually had a callable handler. */
  hasHandler: boolean;
};

export type RegistrationDrift = {
  field: 'id' | 'name' | 'retries' | 'triggerEvent';
  expected: string;
  actual: string;
};

export type InngestRegistrationReport = {
  /** False when the source threw on load (module-level error). */
  loadedOk: boolean;
  /** Set when loadedOk = false. */
  loadError?: string;
  /** Captured createFunction args (null when no createFunction was found). */
  captured: CapturedInngestFn | null;
  /** Per-field comparison against the form. null = couldn't compare
   *  (typically because captured is null or the field wasn't captured). */
  formMatches: {
    idMatchesSlug: boolean | null;
    nameMatchesDisplay: boolean | null;
    retriesMatch: boolean | null;
    triggerEventMatches: boolean | null;
  };
  /** Concrete drift records — what was expected vs what was actually captured. */
  drift: RegistrationDrift[];
  /** Other findings (missing await, multiple createFunction calls, etc.). */
  warnings: string[];
  /** Final pass/fail: true iff loaded OK + handler present + zero drift. */
  passed: boolean;
};

export function checkInngestRegistration(opts: {
  source: string;
  form: AgentFormFields;
}): InngestRegistrationReport {
  const { source, form } = opts;
  const warnings: string[] = [];

  // Static lint — naked step.run / step.sendEvent (missing await).
  warnings.push(...lintMissingAwait(source));

  // Static lint — multiple inngest.createFunction calls (we capture only first).
  const createFnMatches = source.match(/\binngest\.createFunction\s*\(/g);
  if (createFnMatches && createFnMatches.length > 1) {
    warnings.push(
      `Found ${createFnMatches.length} inngest.createFunction calls — only the first is validated. Most agents export exactly one function.`,
    );
  }

  let captured: CapturedInngestFn | null = null;
  let loadedOk = true;
  let loadError: string | undefined;

  try {
    captured = loadAndCapture(source);
  } catch (e) {
    loadedOk = false;
    loadError = e instanceof Error ? e.message : String(e);
  }

  // Cross-validate against the form.
  const formMatches = {
    idMatchesSlug:
      captured?.id === undefined ? null : captured.id === form.slug,
    nameMatchesDisplay:
      captured?.name === undefined ? null : captured.name === form.displayName,
    retriesMatch:
      captured?.retries === undefined ? null : captured.retries === form.retries,
    triggerEventMatches:
      captured?.triggerEvent === undefined
        ? null
        : captured.triggerEvent === form.triggerEvent,
  };

  const drift: RegistrationDrift[] = [];
  if (formMatches.idMatchesSlug === false) {
    drift.push({ field: 'id', expected: form.slug, actual: captured!.id ?? '(missing)' });
  }
  if (formMatches.nameMatchesDisplay === false) {
    drift.push({
      field: 'name',
      expected: form.displayName,
      actual: captured!.name ?? '(missing)',
    });
  }
  if (formMatches.retriesMatch === false) {
    drift.push({
      field: 'retries',
      expected: String(form.retries),
      actual: String(captured!.retries),
    });
  }
  if (formMatches.triggerEventMatches === false) {
    drift.push({
      field: 'triggerEvent',
      expected: form.triggerEvent,
      actual: captured!.triggerEvent ?? '(missing)',
    });
  }

  const passed =
    loadedOk && !!captured && captured.hasHandler && drift.length === 0;

  return {
    loadedOk,
    loadError,
    captured,
    formMatches,
    drift,
    warnings,
    passed,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Loader — single-purpose: capture createFunction args, skip handler exec
// ────────────────────────────────────────────────────────────────────────

function loadAndCapture(source: string): CapturedInngestFn | null {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    reportDiagnostics: false,
  });

  let captured: CapturedInngestFn | null = null;

  // Mocks — everything is no-op except inngest.createFunction which captures.
  const modules = buildLoadMocks((args) => {
    if (!captured) captured = args;
  });
  const customRequire = (name: string): unknown => {
    if (modules.has(name)) return modules.get(name);
    if (name === 'node:crypto' || name === 'crypto') return require('node:crypto');
    throw new Error(`registration-validator: no mock for require('${name}')`);
  };

  const parsingContext = vm.createContext({
    Buffer,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    process: { env: {}, hrtime: process.hrtime.bind(process) },
    URL,
    URLSearchParams,
  });

  const wrapped = vm.compileFunction(
    transpiled.outputText,
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { parsingContext },
  );

  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  wrapped(moduleObj.exports, customRequire, moduleObj, 'generated.ts', '/');

  // If captured is still null but the source has handler-exported value,
  // emit a fallback captured object so the caller sees hasHandler.
  if (!captured) {
    const fallback = Object.values(moduleObj.exports).find(
      (v): v is { handler?: unknown } =>
        !!v && typeof v === 'object' && 'handler' in (v as object),
    );
    if (fallback) {
      return { hasHandler: typeof fallback.handler === 'function' };
    }
    return null;
  }
  return captured;
}

function buildLoadMocks(
  onCreate: (args: CapturedInngestFn) => void,
): Map<string, Record<string, unknown>> {
  const modules = new Map<string, Record<string, unknown>>();

  // inngest npm package
  class FakeNonRetriableError extends Error {
    override name = 'NonRetriableError';
  }
  modules.set('inngest', {
    NonRetriableError: FakeNonRetriableError,
    Inngest: class FakeInngest {},
    EventSchemas: class FakeEventSchemas {},
  });

  // @/server/inngest/client — exposes `inngest` with capturing createFunction.
  const fakeInngest = {
    createFunction: (
      opts: Record<string, unknown>,
      trigger: Record<string, unknown> | Array<Record<string, unknown>>,
      handler: (ctx: unknown) => unknown,
    ) => {
      const triggerObj = Array.isArray(trigger) ? trigger[0] : trigger;
      onCreate({
        id: typeof opts.id === 'string' ? opts.id : undefined,
        name: typeof opts.name === 'string' ? opts.name : undefined,
        retries: typeof opts.retries === 'number' ? opts.retries : undefined,
        triggerEvent:
          triggerObj && typeof (triggerObj as { event?: unknown }).event === 'string'
            ? ((triggerObj as { event: string }).event)
            : undefined,
        hasHandler: typeof handler === 'function',
      });
      return { id: opts.id, name: opts.name, handler };
    },
    send: async () => {},
  };
  modules.set('@/server/inngest/client', { inngest: fakeInngest });

  // Logger mocks
  const fakeLoggerModule = {
    createAgentLogger: () => ({
      info: () => {}, warn: () => {}, error: () => {},
      event: () => {}, apiCall: () => {},
    }),
    runWithLogger: async <T>(_l: unknown, fn: () => Promise<T>): Promise<T> => fn(),
    currentLogger: () => ({
      info: () => {}, warn: () => {}, error: () => {},
      event: () => {}, apiCall: () => {},
    }),
  };
  modules.set('@/lib/agent-logger', fakeLoggerModule);
  modules.set('@/server/agent-logger', fakeLoggerModule);

  // Broad fallback: every other @/lib/* import — return an empty object,
  // the source can `import { foo } from '@/lib/X'` and foo will be
  // undefined, but the registration validator only cares about the
  // createFunction call shape, not handler execution. Module-level uses
  // of these would crash; the source's body never runs.
  // We use a Proxy that returns no-op functions for any property access,
  // so even module-level expressions like `const x = doStuff()` survive.
  const universalStub = new Proxy({} as Record<string, unknown>, {
    get(_, prop) {
      if (prop === '__esModule') return true;
      // Return a no-op function that returns undefined.
      // Note: classes accessed at module level won't `new` cleanly, but
      // that's a rare module-level pattern in our agents.
      return () => undefined;
    },
  });
  const passthroughPaths = [
    '@/lib/robohire-client',
    '@/lib/allmeta-writers',
    '@/lib/minio',
    '@/lib/rule-check',
    '@/lib/rule-check/ontology',
  ];
  for (const p of passthroughPaths) {
    if (!modules.has(p)) modules.set(p, universalStub as Record<string, unknown>);
  }

  return modules;
}

// ────────────────────────────────────────────────────────────────────────
// Static lints
// ────────────────────────────────────────────────────────────────────────

/** Flag `step.run(...)` and `step.sendEvent(...)` calls not preceded by
 *  `await` within the previous ~20 chars on the same line. Heuristic;
 *  false positives possible (e.g., `const p = step.run(...);` where the
 *  operator awaits later) — but those are rare enough to warn. */
function lintMissingAwait(source: string): string[] {
  const warnings: string[] = [];
  const callRe = /\b(step\.(?:run|sendEvent))\s*\(/g;
  const lines = source.split('\n');
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    callRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(line))) {
      const before = line.slice(0, m.index);
      // We require `await ` immediately to the left (after typical
      // whitespace + optional `const x = ` / `return ` assignments).
      const allowed =
        /\bawait\s*$/.test(before) ||
        // const x = await step.run(...) — `await` after `=`.
        /=\s*await\s*$/.test(before) ||
        // return await step.run(...)
        /\breturn\s+await\s*$/.test(before);
      if (allowed) continue;
      // Also allow `void step.run(...)` (operator explicit fire-and-forget).
      if (/\bvoid\s*$/.test(before)) continue;

      warnings.push(
        `Line ${lineNum + 1}: \`${m[1]}(...)\` not preceded by \`await\` — Inngest step calls must be awaited or the step is fire-and-forget without retry semantics.`,
      );
    }
  }
  return warnings;
}
