// Static code reviewer for AO Inngest agent source.
//
// Applies 8 hand-rolled rules to a TS source string + an AgentSpec. Each
// rule is a pure function — no LLM, no execution, no project mutation.
// Output is a deduped list of issues with severity, line, and a one-line
// hint pointing at the fix.
//
// Used by:
//   - npm run codegen:eval -- --review     (CLI)
//   - future codegen UI "Review" tab       (Bundle F)
//
// Rules intentionally encode AO conventions, not generic TS quality. For
// language-level checks we already have the in-process tsc compiler
// (Phase 0c). This module asks "is this code AO-shaped?".

import type { AgentSpec } from '../spec-types';
import type { ToolRegistryEntry } from '../registries';
import { canonicalFieldNames } from '../ontology/canonical-schemas';

export type ReviewSeverity = 'error' | 'warning' | 'info';

export type ReviewIssue = {
  ruleId: string;
  severity: ReviewSeverity;
  message: string;
  /** 1-indexed line in the source, when locatable. */
  line?: number;
  /** Short fix hint, shown next to the issue in the UI / CLI. */
  hint?: string;
};

export type ReviewInput = {
  source: string;
  spec: AgentSpec;
  /** Tool registry rows the LLM was allowed to use (current domain). */
  toolRegistry: ReadonlyArray<ToolRegistryEntry>;
};

export type ReviewReport = {
  /** True iff there are zero `error`-severity issues. */
  passed: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: ReviewIssue[];
};

// ────────────────────────────────────────────────────────────────────────
// Rules
// ────────────────────────────────────────────────────────────────────────

type Rule = (input: ReviewInput) => ReviewIssue[];

const RULES: Rule[] = [
  ruleAgentIdConstantPresent,
  ruleAgentNameConstantPresent,
  ruleTriggerEventWired,
  ruleEmitsWired,
  ruleImportsAreAllowed,
  ruleExternalCallsWrappedInTryCatch,
  ruleStepsHaveLogger,
  ruleStepRunsHaveReturn,
  ruleAllmetaCanonicalFieldsOnly,
];

export function reviewCode(input: ReviewInput): ReviewReport {
  const issues: ReviewIssue[] = [];
  for (const rule of RULES) {
    try {
      issues.push(...rule(input));
    } catch (e) {
      issues.push({
        ruleId: 'rule-crash',
        severity: 'warning',
        message: `Reviewer rule crashed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return summarize(issues);
}

// ────────────────────────────────────────────────────────────────────────
// Individual rules
// ────────────────────────────────────────────────────────────────────────

function ruleAgentIdConstantPresent({ source }: ReviewInput): ReviewIssue[] {
  if (/\bconst\s+AGENT_ID\s*=/.test(source)) return [];
  return [
    {
      ruleId: 'agent-id-constant-present',
      severity: 'warning',
      message: "Missing `const AGENT_ID = '<slug>'` declaration.",
      hint: 'AO convention: every agent declares AGENT_ID at top so it can be referenced from logger calls + createFunction.',
    },
  ];
}

function ruleAgentNameConstantPresent({ source }: ReviewInput): ReviewIssue[] {
  if (/\bconst\s+AGENT_NAME\s*=/.test(source)) return [];
  return [
    {
      ruleId: 'agent-name-constant-present',
      severity: 'warning',
      message: 'Missing `const AGENT_NAME` declaration.',
      hint: 'AO convention: AGENT_NAME is interpolated into logger.info messages.',
    },
  ];
}

function ruleTriggerEventWired({ source, spec }: ReviewInput): ReviewIssue[] {
  const re = new RegExp(`event\\s*:\\s*['"\`]${escapeRegex(spec.triggerEvent)}['"\`]`);
  if (re.test(source)) return [];
  return [
    {
      ruleId: 'trigger-event-wired',
      severity: 'error',
      message: `createFunction trigger doesn't reference declared event "${spec.triggerEvent}".`,
      hint: `Add { event: '${spec.triggerEvent}' } to createFunction's 2nd argument.`,
    },
  ];
}

function ruleEmitsWired({ source, spec }: ReviewInput): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (const evt of spec.emitEvents) {
    const re = new RegExp(`name\\s*:\\s*['"\`]${escapeRegex(evt)}['"\`]`);
    if (!re.test(source)) {
      issues.push({
        ruleId: 'emits-wired',
        severity: 'error',
        message: `Declared emit event "${evt}" never appears in code.`,
        hint: `Add inngest.send({ name: '${evt}', data: { ... } }) or step.sendEvent(..., { name: '${evt}', ... }).`,
      });
    }
  }
  return issues;
}

function ruleImportsAreAllowed({ source, toolRegistry }: ReviewInput): ReviewIssue[] {
  // Whitelist: tool registry paths + framework imports + node builtins.
  const allowedPaths = new Set<string>(toolRegistry.map((t) => t.importFrom));
  allowedPaths.add('inngest'); // NonRetriableError + types
  allowedPaths.add('@/server/inngest/client');
  allowedPaths.add('@/lib/agent-logger');
  allowedPaths.add('@/server/agent-logger');

  const issues: ReviewIssue[] = [];
  const importRe = /^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/gm;
  for (const m of source.matchAll(importRe)) {
    const path = m[1];
    if (path.startsWith('node:')) continue; // node builtins always fine
    if (allowedPaths.has(path)) continue;
    const line = lineOf(source, m.index ?? 0);
    issues.push({
      ruleId: 'imports-are-allowed',
      severity: 'warning',
      message: `Import "${path}" is not in the tool registry or framework whitelist.`,
      line,
      hint: 'Add the lib to tool-registry.raas.ts, or use one of the registered tools.',
    });
  }
  return issues;
}

function ruleExternalCallsWrappedInTryCatch({ source, toolRegistry }: ReviewInput): ReviewIssue[] {
  // For every tool with sideEffects starting with 'external HTTP', check
  // that each call site is inside a try block somewhere up the source.
  const externalTools = toolRegistry.filter((t) => t.sideEffects.startsWith('external HTTP'));
  const issues: ReviewIssue[] = [];
  for (const t of externalTools) {
    // Find call sites of the imported name.
    const callRe = new RegExp(`\\b${escapeRegex(t.importName)}\\s*\\(`, 'g');
    for (const m of source.matchAll(callRe)) {
      const callIdx = m.index ?? 0;
      if (!isInsideTryBlock(source, callIdx)) {
        issues.push({
          ruleId: 'external-calls-try-catch',
          severity: 'warning',
          message: `External-HTTP call \`${t.importName}\` not wrapped in try/catch.`,
          line: lineOf(source, callIdx),
          hint: 'Wrap in try/catch + throw NonRetriableError on isClientError (see tool registry exampleCalls).',
        });
      }
    }
  }
  return issues;
}

function ruleStepsHaveLogger({ source, spec }: ReviewInput): ReviewIssue[] {
  // For each declared step in spec, find its step.run('id', …) callback and
  // check the callback body contains a logger.* call. If we can't locate
  // the step (LLM may have used a different id), skip.
  const issues: ReviewIssue[] = [];
  for (const step of spec.steps) {
    const stepRe = new RegExp(
      `step\\.run\\(\\s*[\`'"]${escapeRegex(step.id)}(?:-?\\$\\{[^}]*\\})?[\`'"]`,
      'g',
    );
    const m = stepRe.exec(source);
    if (!m) continue;
    const callbackBody = extractStepCallbackBody(source, m.index + m[0].length);
    if (!callbackBody) continue;
    if (!/\blogger\.(info|warn|error|event|apiCall)\b/.test(callbackBody)) {
      issues.push({
        ruleId: 'steps-have-logger',
        severity: 'info',
        message: `Step "${step.id}" has no logger.* call inside its callback.`,
        line: lineOf(source, m.index),
        hint: 'Add a logger.info one-liner so production traces stay readable.',
      });
    }
  }
  return issues;
}

function ruleStepRunsHaveReturn({ source, spec }: ReviewInput): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (const step of spec.steps) {
    const stepRe = new RegExp(
      `step\\.run\\(\\s*[\`'"]${escapeRegex(step.id)}(?:-?\\$\\{[^}]*\\})?[\`'"]`,
      'g',
    );
    const m = stepRe.exec(source);
    if (!m) continue;
    const body = extractStepCallbackBody(source, m.index + m[0].length);
    if (!body) continue;
    // Heuristic: body should contain `return ` or `throw ` (early exit) on at
    // least one path. If body is short (< 30 chars) we don't bother.
    if (body.length < 30) continue;
    if (!/\breturn\b/.test(body) && !/\bthrow\b/.test(body)) {
      issues.push({
        ruleId: 'step-runs-have-return',
        severity: 'warning',
        message: `Step "${step.id}" callback has no return / throw — downstream steps can't use its value.`,
        line: lineOf(source, m.index),
        hint: 'Return the result so the next step can chain off it (or throw to mark failure).',
      });
    }
  }
  return issues;
}

/**
 * Bundle J rule — every writeXInstance call argument must use ONLY fields
 * from the canonical AllmetaOntology schema for that entity. Catches the
 * "allmeta silently rejects unknown fields" class of bug.
 *
 * Implementation: scan source for `writeXInstance({ ... })` call sites,
 * extract top-level object-literal keys, compare to the canonical set for
 * the corresponding entity, flag any unknown keys.
 */
function ruleAllmetaCanonicalFieldsOnly({ source, toolRegistry }: ReviewInput): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const allmetaWriters = toolRegistry.filter((t) => t.canonicalEntity);

  for (const t of allmetaWriters) {
    const canonicalFields = canonicalFieldNames(t.canonicalEntity!);
    // Allow the `requirement` / `parsed` wrapper keys — those are writer-
    // specific helper keys that the writer unpacks into canonical fields
    // internally (see lib/allmeta-writers/<entity>.ts).
    const allowedExtras = new Set(['requirement', 'parsed']);

    // Find all call sites of this writer.
    const callRe = new RegExp(
      `\\b${escapeRegex(t.importName)}\\s*\\(\\s*\\{`,
      'g',
    );
    for (const m of source.matchAll(callRe)) {
      const startBrace = (m.index ?? 0) + m[0].length - 1;
      const objLit = extractBracedRegion(source, startBrace);
      if (!objLit) continue;
      const keys = extractTopLevelKeys(objLit);
      for (const k of keys) {
        if (canonicalFields.has(k) || allowedExtras.has(k)) continue;
        issues.push({
          ruleId: 'allmeta-canonical-fields-only',
          severity: 'warning',
          message: `${t.importName}({ ${k}: … }) — "${k}" is not in the canonical ${t.canonicalEntity} schema; allmeta will drop or reject it.`,
          line: lineOf(source, m.index ?? 0),
          hint: `Either rename to a canonical ${t.canonicalEntity} field, OR wrap your inputs under \`parsed\`/\`requirement\` so the writer normalizes them.`,
        });
      }
    }
  }
  return issues;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function summarize(issues: ReviewIssue[]): ReviewReport {
  let err = 0;
  let warn = 0;
  let info = 0;
  for (const i of issues) {
    if (i.severity === 'error') err++;
    else if (i.severity === 'warning') warn++;
    else info++;
  }
  return {
    passed: err === 0,
    errorCount: err,
    warningCount: warn,
    infoCount: info,
    issues,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Crude bracket-balancing: walk back from `index` and see if there's an
 *  unbalanced `try {` before the next unclosed `}`. Cheap, good enough for
 *  the reviewer rule. */
function isInsideTryBlock(source: string, index: number): boolean {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const c = source[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        // Found the opening brace at our scope. Check if preceded by 'try'.
        const head = source.slice(Math.max(0, i - 6), i).trim();
        if (head.endsWith('try')) return true;
      } else {
        depth--;
      }
    }
  }
  return false;
}

/** From an index pointing at `{`, return the text BETWEEN the matching
 *  braces (exclusive), with nested braces respected. Returns null on
 *  unbalanced input. Crude but sufficient for top-level reviewer pattern
 *  matching — full TS-AST is Bundle K territory. */
function extractBracedRegion(source: string, openBraceIdx: number): string | null {
  if (source[openBraceIdx] !== '{') return null;
  let depth = 1;
  let i = openBraceIdx + 1;
  let inStr: false | '"' | "'" | '`' = false;
  let inTemplateExpr = 0;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (inStr) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (inStr === '`' && c === '$' && source[i + 1] === '{') {
        inTemplateExpr++;
        i += 2;
        continue;
      }
      if (c === inStr) inStr = false;
    } else if (inTemplateExpr > 0) {
      if (c === '{') inTemplateExpr++;
      else if (c === '}') inTemplateExpr--;
    } else {
      if (c === '"' || c === "'" || c === '`') inStr = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    i++;
  }
  if (depth !== 0) return null;
  return source.slice(openBraceIdx + 1, i - 1);
}

/** Extract top-level object-literal keys from a brace-content snippet.
 *  Skips strings, template literals, nested objects, comments, spread.
 *  Returns [] on parse failure (defensive). */
function extractTopLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let i = 0;
  let depth = 0;
  let inStr: false | '"' | "'" | '`' = false;
  let inLineComment = false;
  let inBlockComment = false;
  let atKeyStart = true;
  let buf = '';

  while (i < body.length) {
    const c = body[i];
    const next = body[i + 1];

    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inStr) inStr = false;
      i++;
      continue;
    }
    // Outside any nested context, ready to read a key.
    if (depth === 0) {
      if (c === '/' && next === '/') {
        inLineComment = true;
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (c === '{' || c === '[' || c === '(') {
        depth++;
        atKeyStart = false;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        inStr = c;
        i++;
        continue;
      }
      if (c === ',') {
        atKeyStart = true;
        buf = '';
        i++;
        continue;
      }
      if (c === ':') {
        // End of key
        const k = buf.trim();
        if (k && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) keys.push(k);
        // Anything that's not a plain ident (like quoted keys, computed
        // keys) is intentionally skipped — we don't validate those.
        buf = '';
        // Skip the value until next top-level comma or end.
        atKeyStart = false;
        i++;
        continue;
      }
      if (atKeyStart) {
        // Building the key name candidate.
        if (/\s/.test(c)) {
          // Whitespace allowed before key starts; if buf already has
          // content, treat as end of key.
          i++;
          continue;
        }
        buf += c;
      }
      i++;
      continue;
    }
    // Inside nested {[(.
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
    } else if (c === '{' || c === '[' || c === '(') {
      depth++;
    } else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) {
        // After closing nested value, expect comma or end → ready for next key.
        atKeyStart = true;
        buf = '';
      }
    }
    i++;
  }
  return keys;
}

/** Given the source and the position right after `step.run('id'`, find the
 *  callback body text (between the `=>` arrow and the matching close brace).
 *  Returns null when the structure doesn't match expectations. */
function extractStepCallbackBody(source: string, after: number): string | null {
  // Skip optional whitespace + comma.
  let i = after;
  while (i < source.length && /[\s,]/.test(source[i])) i++;
  // Expect optional `async` + `(` … `)` + `=>` + `{`.
  const arrow = source.indexOf('=>', i);
  if (arrow < 0 || arrow > i + 80) return null;
  let j = arrow + 2;
  while (j < source.length && /\s/.test(source[j])) j++;
  if (source[j] !== '{') return null;
  // Walk to the matching brace.
  let depth = 1;
  let k = j + 1;
  while (k < source.length && depth > 0) {
    if (source[k] === '{') depth++;
    else if (source[k] === '}') depth--;
    k++;
  }
  if (depth !== 0) return null;
  return source.slice(j + 1, k - 1);
}
