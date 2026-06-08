// Domain-agnostic rule-check engine — the reusable core behind every
// rule-check agent (recruitment matchResume, energy validateConstraints /
// triageScheme, and future domains/steps). The principle is always the same:
//
//   1. 筛查 (select)  — from the domain's full rule set, pick the rules that
//      apply to THIS step (by scenario stage / code prefix / explicit codes).
//   2. 二次验证 (verify) — confirm the selection is correct & complete: every
//      expected rule was grabbed (esp. the hard red-lines), none silently
//      dropped, each parsed cleanly. A bad selection HALTS rather than judging
//      against a half-grabbed rule set ("规则没抓全/抓错" 是事故,不能跳过).
//   3. 规则判断 (judge) — run each rule's evaluator against the run context.
//      The evaluators are domain-specific (numeric for energy, LLM for
//      recruitment); this module supplies the select+verify + the result types.

import type { Rule } from "./types";

/** A rule normalized for the engine: a parsed code + group on top of `Rule`. */
export type EngineRule = {
  id: string; // ontology id (numeric in snapshots, CR-* in neo4j)
  code: string; // parsed business code, e.g. CR-HYD-05; falls back to id
  name: string;
  stage: string;
  group: string; // 机组|水库水调|电网|安全|市场|分流|其他
  hardSoft: "hard" | "soft"; // failurePolicy=block → hard
  redline: boolean; // one of the four hard red-lines
  defaultAction: string; // from standardizedLogicRule prose (truncated)
  raw: Rule;
};

export type RuleResult = "PASS" | "FAIL" | "CLAMPED" | "NA";

export type RuleEval = {
  ruleId: string;
  code: string;
  name: string;
  group: string;
  hardSoft: "hard" | "soft";
  result: RuleResult;
  checkPoint?: string;
  beforeVal?: string;
  afterVal?: string;
  defaultAction?: string;
  riskType?: string; // T1..T8
  riskLevel?: string; // L1..L4
  evidence?: string;
};

export type SelectionVerification = {
  ok: boolean;
  selectedCodes: string[];
  missing: string[]; // expected but not grabbed
  extra: string[]; // grabbed but not expected
  parseIssues: string[]; // rule codes with empty name / logic
};

/** The four hard red-lines (用例 §2.6 / 分流条件4). */
export const HARD_REDLINES = ["CR-HYD-05", "CR-HYD-03", "CR-GRID-01", "CR-GRID-03"] as const;

const CODE_RE = /\b(CR-[A-Z]+-\d+|ROUTE-\d+|PIPE-\d+|QC-\d+)\b/;

const GROUP_BY_PREFIX: Record<string, string> = {
  "CR-UNIT": "机组",
  "CR-HYD": "水库水调",
  "CR-GRID": "电网",
  "CR-SAFE": "安全",
  "CR-MKT": "市场",
};

function parseCode(r: Rule): string {
  // Prefer a code embedded in the name (snapshots: id is numeric, code in name).
  const fromName = r.businessLogicRuleName.match(CODE_RE)?.[1];
  if (fromName) return fromName;
  const fromId = r.id.match(CODE_RE)?.[1];
  if (fromId) return fromId;
  return r.id;
}

function groupOf(code: string, stage: string): string {
  for (const [prefix, g] of Object.entries(GROUP_BY_PREFIX)) if (code.startsWith(prefix)) return g;
  if (stage.includes("分流")) return "分流";
  return "其他";
}

/** Normalize raw `Rule[]` → `EngineRule[]` (parse code, group, hard/soft). */
export function toEngineRules(rules: Rule[]): EngineRule[] {
  return rules.map((r) => {
    const code = parseCode(r);
    const hardSoft: "hard" | "soft" = r.failurePolicy === "block" ? "hard" : "soft";
    return {
      id: r.id,
      code,
      name: r.businessLogicRuleName,
      stage: r.specificScenarioStage,
      group: groupOf(code, r.specificScenarioStage),
      hardSoft,
      redline: (HARD_REDLINES as readonly string[]).includes(code),
      defaultAction: (r.standardizedLogicRule || "").slice(0, 120),
      raw: r,
    };
  });
}

export type SelectOpts = {
  stage?: string; // exact specificScenarioStage match
  codePrefixes?: string[]; // e.g. ["CR-"]
  codes?: string[]; // explicit code allow-list
  namePattern?: RegExp; // fallback match on rule name
};

/** 筛查:pick the rules that apply to this step. */
export function selectRules(rules: EngineRule[], opts: SelectOpts): EngineRule[] {
  return rules.filter((r) => {
    if (opts.stage && r.stage !== opts.stage) return false;
    if (opts.codes && !opts.codes.includes(r.code)) return false;
    if (opts.codePrefixes && !opts.codePrefixes.some((p) => r.code.startsWith(p))) return false;
    if (opts.namePattern && !opts.namePattern.test(r.name)) return false;
    return true;
  });
}

/** 二次验证:was the selection correct & complete vs the expected codes? */
export function verifySelection(selected: EngineRule[], expectedCodes: string[]): SelectionVerification {
  const selectedCodes = selected.map((r) => r.code);
  const set = new Set(selectedCodes);
  const expSet = new Set(expectedCodes);
  const missing = expectedCodes.filter((c) => !set.has(c));
  const extra = selectedCodes.filter((c) => !expSet.has(c));
  const parseIssues = selected.filter((r) => !r.name || !r.raw.standardizedLogicRule).map((r) => r.code);
  return { ok: missing.length === 0 && parseIssues.length === 0, selectedCodes, missing, extra, parseIssues };
}

/** 二次验证(by name coverage) — for rule sets without stable codes (e.g. the
 *  routing rules carry numeric ids): confirm every required concept matched a
 *  selected rule. */
export function verifyCoverage(
  selected: EngineRule[],
  required: { name: string; re: RegExp }[],
): SelectionVerification {
  const missing = required.filter((req) => !selected.some((r) => req.re.test(r.name))).map((req) => req.name);
  const parseIssues = selected.filter((r) => !r.name).map((r) => r.code);
  return { ok: missing.length === 0 && parseIssues.length === 0, selectedCodes: selected.map((r) => r.code), missing, extra: [], parseIssues };
}

/** Did any hard red-line rule fail? */
export function hasRedlineHit(evals: RuleEval[]): boolean {
  return evals.some((e) => e.hardSoft === "hard" && e.result === "FAIL");
}
