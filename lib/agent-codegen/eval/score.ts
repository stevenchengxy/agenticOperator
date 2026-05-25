// Pure scoring functions for codegen output ↔ production code comparison.
//
// Extracts shallow structural features via regex (no full TS parsing —
// fine for MVP; AST-based scoring is Phase 3+). Each scorer is pure and
// independently testable.
//
// Outputs are 0-1 ratios; the harness's composite score is a weighted mean.

export type StructuralFeatures = {
  importedNames: Set<string>;
  importPaths: Set<string>;
  stepIds: Set<string>;
  toolReferences: Set<string>; // intersection of imported names actually used in body
  hasNonRetriable: boolean;
  tryCatchCount: number;
  loggerCallCount: number;
  loc: number;
};

const IMPORT_RE = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm;
const STEP_RUN_RE = /step\.run\(\s*['"`]([^'"`]+?)['"`]/g;
const STEP_SEND_RE = /step\.sendEvent\(\s*['"`]([^'"`]+?)['"`]/g;
const LOGGER_RE = /\blogger\.(info|warn|error|event|apiCall)\(/g;
const NON_RETRIABLE_RE = /\bNonRetriableError\b/;
const TRY_RE = /\btry\s*\{/g;

export function extractFeatures(source: string): StructuralFeatures {
  const importedNames = new Set<string>();
  const importPaths = new Set<string>();
  for (const m of source.matchAll(IMPORT_RE)) {
    importPaths.add(m[2]);
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) importedNames.add(name);
    }
  }

  const stepIds = new Set<string>();
  for (const m of source.matchAll(STEP_RUN_RE)) stepIds.add(stripExprSuffix(m[1]));
  for (const m of source.matchAll(STEP_SEND_RE)) stepIds.add(stripExprSuffix(m[1]));

  const toolReferences = new Set<string>();
  for (const name of importedNames) {
    // Crude usage check: does the name appear elsewhere in the body?
    const usageRe = new RegExp(`\\b${escapeRegex(name)}\\b`, 'g');
    const hits = (source.match(usageRe) ?? []).length;
    if (hits > 1) toolReferences.add(name); // 1 hit = the import line itself
  }

  const hasNonRetriable = NON_RETRIABLE_RE.test(source);
  const tryCatchCount = (source.match(TRY_RE) ?? []).length;
  const loggerCallCount = (source.match(LOGGER_RE) ?? []).length;

  const loc = source
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//');
    }).length;

  return {
    importedNames,
    importPaths,
    stepIds,
    toolReferences,
    hasNonRetriable,
    tryCatchCount,
    loggerCallCount,
    loc,
  };
}

/** Strip template-literal interpolation suffixes from step IDs for fair compare.
 *  e.g. `'fetch-requirement-${sanitize(id)}'` → `'fetch-requirement'` */
function stripExprSuffix(id: string): string {
  return id.replace(/-?\$\{.*?\}.*$/, '').replace(/\s+$/, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ────────────────────────────────────────────────────────────────────────
// Score dimensions — each is a 0..1 ratio
// ────────────────────────────────────────────────────────────────────────

/** Of the production imports, what fraction does the candidate also import? */
export function scoreImportOverlap(prod: StructuralFeatures, cand: StructuralFeatures): number {
  if (prod.importedNames.size === 0) return 1;
  let hits = 0;
  for (const name of prod.importedNames) if (cand.importedNames.has(name)) hits++;
  return hits / prod.importedNames.size;
}

/** Of production step IDs, what fraction appear in candidate? */
export function scoreStepOverlap(prod: StructuralFeatures, cand: StructuralFeatures): number {
  if (prod.stepIds.size === 0) return 1;
  let hits = 0;
  for (const id of prod.stepIds) if (cand.stepIds.has(id)) hits++;
  return hits / prod.stepIds.size;
}

/** Of production tool references (imported & used names), what fraction appear in candidate? */
export function scoreToolOverlap(prod: StructuralFeatures, cand: StructuralFeatures): number {
  if (prod.toolReferences.size === 0) return 1;
  let hits = 0;
  for (const t of prod.toolReferences) if (cand.toolReferences.has(t)) hits++;
  return hits / prod.toolReferences.size;
}

/** 1 if candidate uses NonRetriableError + try-catch + logger; partial credit otherwise. */
export function scorePatternAdherence(prod: StructuralFeatures, cand: StructuralFeatures): number {
  let score = 0;
  let weight = 0;
  if (prod.hasNonRetriable) {
    weight += 1;
    if (cand.hasNonRetriable) score += 1;
  }
  if (prod.tryCatchCount > 0) {
    weight += 1;
    if (cand.tryCatchCount > 0) score += 1;
  }
  if (prod.loggerCallCount > 0) {
    weight += 1;
    // Partial credit for at least half the call density
    const ratio = Math.min(cand.loggerCallCount, prod.loggerCallCount) / prod.loggerCallCount;
    score += ratio;
  }
  return weight === 0 ? 1 : score / weight;
}

/** 1 if candidate LOC ≤ 1.5x production; 0 if > 4x. Linear in between. */
export function scoreLocRatio(prod: StructuralFeatures, cand: StructuralFeatures): number {
  if (prod.loc === 0) return cand.loc === 0 ? 1 : 0;
  const ratio = cand.loc / prod.loc;
  if (ratio <= 1.5) return 1;
  if (ratio >= 4) return 0;
  return 1 - (ratio - 1.5) / 2.5;
}

// ────────────────────────────────────────────────────────────────────────
// Composite
// ────────────────────────────────────────────────────────────────────────

export type ScoreWeights = {
  imports: number;
  steps: number;
  tools: number;
  patterns: number;
  loc: number;
};

export const DEFAULT_WEIGHTS: ScoreWeights = {
  imports: 0.2,
  steps: 0.2,
  tools: 0.25,
  patterns: 0.25,
  loc: 0.1,
};

export type ScoreBreakdown = {
  imports: number;
  steps: number;
  tools: number;
  patterns: number;
  loc: number;
  composite: number;
  details: {
    prodImports: string[];
    candImports: string[];
    missingImports: string[];
    extraImports: string[];
    prodSteps: string[];
    candSteps: string[];
    missingSteps: string[];
    extraSteps: string[];
  };
};

export function scoreCandidate(
  productionSource: string,
  candidateSource: string,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreBreakdown {
  const prod = extractFeatures(productionSource);
  const cand = extractFeatures(candidateSource);

  const dims = {
    imports: scoreImportOverlap(prod, cand),
    steps: scoreStepOverlap(prod, cand),
    tools: scoreToolOverlap(prod, cand),
    patterns: scorePatternAdherence(prod, cand),
    loc: scoreLocRatio(prod, cand),
  };

  const composite =
    dims.imports * weights.imports +
    dims.steps * weights.steps +
    dims.tools * weights.tools +
    dims.patterns * weights.patterns +
    dims.loc * weights.loc;

  const missingImports = [...prod.importedNames].filter((n) => !cand.importedNames.has(n));
  const extraImports = [...cand.importedNames].filter((n) => !prod.importedNames.has(n));
  const missingSteps = [...prod.stepIds].filter((s) => !cand.stepIds.has(s));
  const extraSteps = [...cand.stepIds].filter((s) => !prod.stepIds.has(s));

  return {
    ...dims,
    composite,
    details: {
      prodImports: [...prod.importedNames].sort(),
      candImports: [...cand.importedNames].sort(),
      missingImports,
      extraImports,
      prodSteps: [...prod.stepIds].sort(),
      candSteps: [...cand.stepIds].sort(),
      missingSteps,
      extraSteps,
    },
  };
}
