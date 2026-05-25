// Dynamic runner — actually executes generated agent code against the
// declarative TestCases from test-case-generator.ts.
//
// Pipeline per case:
//   1. Transpile the generated TS source to CJS via the TS compiler API.
//   2. Build a mock module map: tool registry imports → fake functions
//      whose return value (or throw) comes from the test case mockSetup;
//      Inngest framework imports → minimal fakes (NonRetriableError class,
//      inngest.createFunction capturing the handler, inngest.send recording
//      emits, etc.).
//   3. Run the transpiled code via `vm.compileFunction` with our custom
//      require, isolated globals (no fs / net / process.env). Capture the
//      `createFunction`-returned handler.
//   4. Invoke the handler with a fake step proxy (records step.run IDs)
//      and the case's inputEvent. Race against a 5s timeout.
//   5. Compare the captured (step sequence, emits, handler outcome) to the
//      case's expectedOutcome → pass / fail + reason.
//
// SAFETY: the vm context has no fs, no http, no process.env passthrough.
// Generated code can't escape unless it imports something not in our
// mock map, in which case the custom require throws — surfacing the
// missing mock instead of leaking.
//
// LIMITS:
//   - Hangs longer than 5s leak the vm work (Promise.race doesn't kill it,
//     just stops awaiting). Acceptable for an internal eval; for prod-grade
//     isolation, move to worker_threads.
//   - We don't reproduce Inngest's step idempotency / replay semantics —
//     each step.run callback executes exactly once.

import * as ts from 'typescript';
import * as vm from 'node:vm';
import type { TestCase } from './test-case-generator';
import type { ToolRegistryEntry } from '../registries';
import { canonicalFieldNames } from '../ontology/canonical-schemas';

export type HandlerOutcome =
  | 'resolved'
  | 'threw-non-retriable'
  | 'threw-other'
  | 'timeout';

export type DynamicRunResult = {
  testCaseName: string;
  category: TestCase['category'];
  passed: boolean;
  reason: string;
  durationMs: number;
  capturedSteps: string[];
  capturedEmits: string[];
  handlerOutcome: HandlerOutcome;
  errorMessage?: string;
};

const DEFAULT_TIMEOUT_MS = 5_000;

export async function runTestCase(opts: {
  source: string;
  testCase: TestCase;
  toolRegistry: ReadonlyArray<ToolRegistryEntry>;
  timeoutMs?: number;
}): Promise<DynamicRunResult> {
  const t0 = Date.now();
  const capturedSteps: string[] = [];
  const capturedEmits: string[] = [];
  let handlerOutcome: HandlerOutcome = 'resolved';
  let errorMessage: string | undefined;

  try {
    // 1. Transpile TS → CJS.
    const transpiled = ts.transpileModule(opts.source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        skipLibCheck: true,
        // Suppress TS's own complaints — we know the source may reference
        // types we haven't loaded; we only care that JS comes out.
        noEmitOnError: false,
      },
      reportDiagnostics: false,
    });

    // 2. Build module mocks.
    const modules = buildMockModules(opts.testCase, opts.toolRegistry, capturedEmits);

    const customRequire = (name: string): unknown => {
      if (modules.has(name)) return modules.get(name);
      // Allow safe node builtins explicitly.
      if (name === 'node:crypto' || name === 'crypto') return require('node:crypto');
      throw new Error(`dynamic-runner: no mock for require('${name}')`);
    };

    // 3. Compile + execute via vm.
    const parsingContext = vm.createContext({
      Buffer,
      console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      // Stub process — no env passthrough, no exit.
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

    // 4. Find the agent export. Convention: it's the value with a `.handler`
    // function (the shape our fake inngest.createFunction returns).
    const exportedAgent = Object.values(moduleObj.exports).find(
      (v): v is { handler: (ctx: unknown) => Promise<unknown> } =>
        !!v && typeof v === 'object' && typeof (v as { handler?: unknown }).handler === 'function',
    );

    if (!exportedAgent) {
      handlerOutcome = 'threw-other';
      errorMessage =
        'No createFunction-style export found. Generated source must export the result of inngest.createFunction(...).';
    } else {
      // 5. Invoke the handler with a fake step proxy + isolated logger.
      const fakeStep = {
        run: async (id: string, cb: () => unknown): Promise<unknown> => {
          capturedSteps.push(stripStepSuffix(id));
          return cb();
        },
        sendEvent: async (_key: string, payload: { name?: string }): Promise<void> => {
          if (payload?.name) capturedEmits.push(payload.name);
        },
      };
      const fakeLogger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        event: () => {},
        apiCall: () => {},
      };

      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const handlerCall = exportedAgent.handler({
        event: opts.testCase.inputEvent,
        step: fakeStep,
        logger: fakeLogger,
        runId: `eval-${Date.now()}`,
      });

      try {
        await Promise.race([
          handlerCall,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new TimeoutMarker()), timeoutMs),
          ),
        ]);
      } catch (e) {
        if (e instanceof TimeoutMarker) {
          handlerOutcome = 'timeout';
          errorMessage = `Handler did not resolve within ${timeoutMs}ms.`;
        } else if (e && (e as { name?: string }).name === 'NonRetriableError') {
          handlerOutcome = 'threw-non-retriable';
          errorMessage = (e as Error).message;
        } else {
          handlerOutcome = 'threw-other';
          errorMessage = e instanceof Error ? e.message : String(e);
        }
      }
    }
  } catch (e) {
    handlerOutcome = 'threw-other';
    errorMessage = `Setup/exec error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const { pass, reason } = checkExpected(opts.testCase, capturedEmits, handlerOutcome);

  return {
    testCaseName: opts.testCase.name,
    category: opts.testCase.category,
    passed: pass,
    reason,
    durationMs: Date.now() - t0,
    capturedSteps,
    capturedEmits,
    handlerOutcome,
    errorMessage,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Mock module construction
// ────────────────────────────────────────────────────────────────────────

class FakeNonRetriableError extends Error {
  override name = 'NonRetriableError';
}
class FakeRobohireApiError extends Error {
  override name = 'RobohireApiError';
  constructor(
    public httpStatus: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
  get isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500;
  }
}
class TimeoutMarker {}

function buildMockModules(
  tc: TestCase,
  registry: ReadonlyArray<ToolRegistryEntry>,
  capturedEmits: string[],
): Map<string, Record<string, unknown>> {
  const modules = new Map<string, Record<string, unknown>>();

  // ── inngest npm package — exports we care about ────────────────────
  modules.set('inngest', {
    NonRetriableError: FakeNonRetriableError,
    Inngest: class FakeInngest {},
    EventSchemas: class FakeEventSchemas {},
  });

  // ── AO inngest client wrapper ──────────────────────────────────────
  const fakeInngest = {
    createFunction: (
      _opts: Record<string, unknown>,
      _trigger: Record<string, unknown>,
      handler: (ctx: unknown) => Promise<unknown>,
    ) => ({ id: (_opts as { id?: string }).id ?? 'unknown', handler }),
    send: async (payload: { name?: string }): Promise<void> => {
      if (payload?.name) capturedEmits.push(payload.name);
    },
  };
  modules.set('@/server/inngest/client', { inngest: fakeInngest });

  // ── AO logger — both possible import paths ─────────────────────────
  const fakeLoggerModule = {
    createAgentLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      event: () => {},
      apiCall: () => {},
    }),
    runWithLogger: async <T>(_l: unknown, fn: () => Promise<T>): Promise<T> => fn(),
    currentLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, event: () => {}, apiCall: () => {} }),
  };
  modules.set('@/lib/agent-logger', fakeLoggerModule);
  modules.set('@/server/agent-logger', fakeLoggerModule);

  // ── RoboHire client gets RobohireApiError exposed by default so
  // generated `instanceof RobohireApiError` branches resolve correctly
  // when no specific mock overrides it. ──
  modules.set('@/lib/robohire-client', { RobohireApiError: FakeRobohireApiError });

  // ── Tool registry entries: install case-specific mocks ─────────────
  for (const mock of tc.mockSetup) {
    const entry = registry.find((r) => r.id === mock.toolId);
    if (!entry) continue;

    const fn = makeToolMockFn(mock, entry);

    const existing = modules.get(entry.importFrom) ?? {};
    modules.set(entry.importFrom, {
      ...existing,
      [entry.importName]: fn,
    });
  }

  // ── Bundle J — for any allmeta writer NOT explicitly mocked by the
  // test case, install a strict-validating fake that mirrors the real
  // allmeta server: input fields must be canonical or the writer's
  // documented wrapper keys (parsed / requirement). Unknown field ⇒
  // { ok: false, error: 'unknown_field_<X>' }. This catches the
  // "code compiles + behavior looks right but allmeta silently rejects"
  // class of bug that pure mocks miss.
  for (const entry of registry) {
    if (!entry.canonicalEntity) continue;
    const path = entry.importFrom;
    const existing = modules.get(path) ?? {};
    if (existing[entry.importName]) continue; // case-specific mock wins
    modules.set(path, {
      ...existing,
      [entry.importName]: makeStrictAllmetaMock(entry.canonicalEntity),
    });
  }

  return modules;
}

const ALLMETA_WRAPPER_KEYS = new Set(['requirement', 'parsed']);

function makeStrictAllmetaMock(entityName: string) {
  const allowed = canonicalFieldNames(entityName);
  return async (input: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
    if (!input || typeof input !== 'object') {
      return { ok: false, error: `bad input shape (expected object)` };
    }
    for (const key of Object.keys(input)) {
      if (!allowed.has(key) && !ALLMETA_WRAPPER_KEYS.has(key)) {
        return {
          ok: false,
          error: `unknown_field_${key} (not in canonical ${entityName} schema)`,
        };
      }
    }
    return { ok: true };
  };
}

function makeToolMockFn(
  mock: TestCase['mockSetup'][number],
  entry: ToolRegistryEntry,
): (...args: unknown[]) => unknown {
  // RoboHire helpers that throw must use the typed error class so the
  // generated code's `if (e instanceof RobohireApiError && e.isClientError)`
  // branch fires correctly.
  if (mock.returns === '__throw4xx__') {
    const isRobohire = entry.category === 'robohire';
    return () => {
      if (isRobohire) throw new FakeRobohireApiError(400, 'CLIENT', 'Mock 4xx');
      const err = new Error('Mock 4xx');
      (err as { httpStatus?: number }).httpStatus = 400;
      (err as { isClientError?: boolean }).isClientError = true;
      throw err;
    };
  }
  if (mock.returns === '__throw5xx__') {
    return () => {
      const err = new FakeRobohireApiError(500, 'SERVER', 'Mock 5xx');
      throw err;
    };
  }
  // Non-throwing path: an async returns.
  return async () => mock.returns;
}

// ────────────────────────────────────────────────────────────────────────
// Outcome comparison
// ────────────────────────────────────────────────────────────────────────

function checkExpected(
  tc: TestCase,
  capturedEmits: string[],
  outcome: HandlerOutcome,
): { pass: boolean; reason: string } {
  const exp = tc.expectedOutcome;

  // Handler outcome must match (with retriable-error mapping to "threw-other").
  const outcomeMatch =
    (exp.handlerResolves === 'success' && outcome === 'resolved') ||
    (exp.handlerResolves === 'non-retriable-error' && outcome === 'threw-non-retriable') ||
    (exp.handlerResolves === 'retriable-error' && outcome === 'threw-other');

  if (!outcomeMatch) {
    return {
      pass: false,
      reason: `Expected handler to ${exp.handlerResolves}; actual outcome: ${outcome}.`,
    };
  }

  // When emits are expected: at least one of the expected names should appear.
  // (TestCases list alternatives — e.g., either MATCH_PASSED_* or MATCH_FAILED.)
  if (exp.expectedEmits.length > 0) {
    const hit = exp.expectedEmits.some((e) => capturedEmits.includes(e));
    if (!hit) {
      return {
        pass: false,
        reason: `Expected one of [${exp.expectedEmits.join(', ')}] to be emitted; got [${capturedEmits.join(', ') || '—'}].`,
      };
    }
  }

  return { pass: true, reason: 'OK' };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function stripStepSuffix(id: string): string {
  // For template-literal step IDs we record only the static prefix.
  return id.replace(/-?\$\{.*$/, '').replace(/-+$/, '');
}
