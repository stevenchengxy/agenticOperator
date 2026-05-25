// Behavioral analyzer — TS-AST-based extraction of generated agent shape.
//
// Walks the source with the TypeScript Compiler API and emits a
// BehavioralTrace: ordered step.run blocks (id + tool calls), all
// inngest.send / step.sendEvent names. We then diff the trace against a
// hand-written GroundTruth record to score "can this code stand in for
// the production agent?"
//
// AST > regex here because step-id template literals + nested step.run +
// the call-site → import-name resolution all want real tokens.

import * as ts from 'typescript';
import type { GroundTruth, ExpectedStep, ExpectedEmit } from './ground-truth';
import type { ToolRegistryEntry } from '../registries';

export type StepTrace = {
  /** step.run id with template-literal suffix stripped. */
  id: string;
  /** 1-indexed source line where step.run starts. */
  line: number;
  /** Tool registry ids called from this step's callback (resolved from imports). */
  toolsCalled: string[];
};

export type EmitTrace = {
  /** Event name emitted. */
  name: string;
  /** Whether emitted via inngest.send (true) or step.sendEvent (false). */
  viaInngestSend: boolean;
  line: number;
};

export type BehavioralTrace = {
  steps: StepTrace[];
  emits: EmitTrace[];
  /** All imports resolved to their registry id when known. */
  importedToolIds: string[];
};

export type BehavioralDiff = {
  /** Expected steps that appeared. */
  matchedSteps: ExpectedStep[];
  /** Expected steps absent from generated (excluding `optional`). */
  missingSteps: ExpectedStep[];
  /** Generated steps not in ground truth. */
  unexpectedSteps: StepTrace[];
  /** Expected emits found. */
  matchedEmits: ExpectedEmit[];
  /** Expected emits missing. `alternativeOf` is honored — if one branch
   *  fired, the other gets credit. */
  missingEmits: ExpectedEmit[];
  /** Convention check results. */
  conventionsMet: {
    nonRetriable: boolean;
    tryCatch: boolean;
    loggerCalls: number;
    loggerCallsMet: boolean;
  };
};

// ────────────────────────────────────────────────────────────────────────
// Trace extraction
// ────────────────────────────────────────────────────────────────────────

export function extractTrace(
  source: string,
  toolRegistry: ReadonlyArray<ToolRegistryEntry>,
): BehavioralTrace {
  const sf = ts.createSourceFile(
    '__trace.ts',
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  // First pass — collect imported name → tool id, by walking ImportDeclaration.
  const nameToToolId = new Map<string, string>();
  ts.forEachChild(sf, function visit(node) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const fromPath = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : '';
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const localName = el.name.text;
          const importName = el.propertyName ? el.propertyName.text : el.name.text;
          // Find a registry entry that matches both path AND import name.
          const match = toolRegistry.find(
            (t) => t.importFrom === fromPath && t.importName === importName,
          );
          if (match) nameToToolId.set(localName, match.id);
        }
      }
    }
    ts.forEachChild(node, visit);
  });

  // Second pass — collect step.run blocks (in source order) + emits.
  const steps: StepTrace[] = [];
  const emits: EmitTrace[] = [];

  ts.forEachChild(sf, function visit(node) {
    // step.run('id', async () => { ... })
    if (ts.isCallExpression(node) && isStepRun(node.expression)) {
      const idArg = node.arguments[0];
      const id = stringIdOf(idArg);
      const callback = node.arguments[1];
      const toolsCalled =
        callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ? toolsInCallback(callback, nameToToolId)
          : [];
      if (id) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        steps.push({ id: stripStepSuffix(id), line: line + 1, toolsCalled });
      }
    }
    // inngest.send({ name: 'X' }) or step.sendEvent('key', { name: 'X' })
    if (ts.isCallExpression(node)) {
      const viaInngestSend = isInngestSend(node.expression);
      const viaStepSend = isStepSendEvent(node.expression);
      if (viaInngestSend || viaStepSend) {
        const payloadArg = viaInngestSend ? node.arguments[0] : node.arguments[1];
        const name = nameFieldOf(payloadArg);
        if (name) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          emits.push({ name, viaInngestSend, line: line + 1 });
        }
      }
    }
    ts.forEachChild(node, visit);
  });

  return {
    steps,
    emits,
    importedToolIds: [...new Set(steps.flatMap((s) => s.toolsCalled))],
  };
}

// ────────────────────────────────────────────────────────────────────────
// Trace ↔ ground truth diff
// ────────────────────────────────────────────────────────────────────────

export function diffAgainstGroundTruth(
  trace: BehavioralTrace,
  gt: GroundTruth,
  source: string,
): BehavioralDiff {
  // Step match: an expected step matches if there's a trace step with the
  // same id AND either no tool requirement OR the requirement is in toolsCalled.
  const matchedSteps: ExpectedStep[] = [];
  const missingSteps: ExpectedStep[] = [];
  const consumedTraceIdxs = new Set<number>();

  for (const exp of gt.expectedSteps) {
    const idx = trace.steps.findIndex((s, i) => {
      if (consumedTraceIdxs.has(i)) return false;
      if (s.id !== exp.id) return false;
      if (exp.tool && !s.toolsCalled.includes(exp.tool)) return false;
      return true;
    });
    if (idx >= 0) {
      matchedSteps.push(exp);
      consumedTraceIdxs.add(idx);
    } else if (!exp.optional) {
      missingSteps.push(exp);
    } else {
      // Optional step that didn't appear — counts as matched (it's allowed
      // to be absent).
      matchedSteps.push(exp);
    }
  }
  const unexpectedSteps = trace.steps.filter((_, i) => !consumedTraceIdxs.has(i));

  // Emit match: honors alternativeOf.
  const emitNames = new Set(trace.emits.map((e) => e.name));
  const matchedEmits: ExpectedEmit[] = [];
  const missingEmits: ExpectedEmit[] = [];
  for (const exp of gt.expectedEmits) {
    if (emitNames.has(exp.name)) {
      matchedEmits.push(exp);
    } else if (exp.alternativeOf && emitNames.has(exp.alternativeOf)) {
      matchedEmits.push(exp); // alt-of fired
    } else {
      missingEmits.push(exp);
    }
  }

  // Conventions — cheap source-text checks for breadth.
  const nonRetriable = /\bNonRetriableError\b/.test(source);
  const tryCatch = /\btry\s*\{/.test(source);
  const loggerCalls = (source.match(/\blogger\.(info|warn|error|event|apiCall)\b/g) ?? []).length;

  return {
    matchedSteps,
    missingSteps,
    unexpectedSteps,
    matchedEmits,
    missingEmits,
    conventionsMet: {
      nonRetriable: !gt.conventions.nonRetriableUsed || nonRetriable,
      tryCatch: !gt.conventions.tryCatchUsed || tryCatch,
      loggerCalls,
      loggerCallsMet: loggerCalls >= gt.conventions.minLoggerCalls,
    },
  };
}

/** Composite 0-1 score for "how close is the trace to ground truth". */
export function scoreBehavioralDiff(diff: BehavioralDiff, gt: GroundTruth): number {
  const stepScore = gt.expectedSteps.length
    ? diff.matchedSteps.length / gt.expectedSteps.length
    : 1;
  const emitScore = gt.expectedEmits.length
    ? diff.matchedEmits.length / gt.expectedEmits.length
    : 1;
  const conv = diff.conventionsMet;
  const convFlags: boolean[] = [conv.nonRetriable, conv.tryCatch, conv.loggerCallsMet];
  const convScore = convFlags.reduce<number>((a, b) => a + (b ? 1 : 0), 0) / 3;
  // Weighted: steps 0.4, emits 0.3, conventions 0.3
  return stepScore * 0.4 + emitScore * 0.3 + convScore * 0.3;
}

/** Final verdict bucket — keyed off the composite score AND missing-step count. */
export function verdictOf(score: number, diff: BehavioralDiff): 'FULL' | 'PARTIAL' | 'DRAFT' {
  if (diff.missingSteps.length === 0 && score >= 0.9) return 'FULL';
  if (score >= 0.7) return 'PARTIAL';
  return 'DRAFT';
}

// ────────────────────────────────────────────────────────────────────────
// AST helpers
// ────────────────────────────────────────────────────────────────────────

function isStepRun(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'step' &&
    expr.name.text === 'run'
  );
}
function isInngestSend(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'inngest' &&
    expr.name.text === 'send'
  );
}
function isStepSendEvent(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'step' &&
    expr.name.text === 'sendEvent'
  );
}

function stringIdOf(arg: ts.Expression | undefined): string | null {
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    // Template literal — return the head text (e.g. `fetch-requirement-${x}` → `fetch-requirement-`)
    return arg.head.text;
  }
  return null;
}

function stripStepSuffix(id: string): string {
  // Trailing dashes from template-literal heads + `${...}` leftovers.
  return id.replace(/-?\$\{.*?\}.*$/, '').replace(/-+$/, '');
}

function nameFieldOf(arg: ts.Expression | undefined): string | null {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === 'name'
    ) {
      const v = prop.initializer;
      if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return v.text;
    }
  }
  return null;
}

function toolsInCallback(
  cb: ts.ArrowFunction | ts.FunctionExpression,
  nameToToolId: Map<string, string>,
): string[] {
  const found = new Set<string>();
  ts.forEachChild(cb, function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const id = nameToToolId.get(node.expression.text);
      if (id) found.add(id);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      // e.g. `inngest.send(...)` — left side is `inngest`
      const id = nameToToolId.get(node.expression.expression.text);
      if (id) found.add(id);
    }
    ts.forEachChild(node, visit);
  });
  return [...found];
}
