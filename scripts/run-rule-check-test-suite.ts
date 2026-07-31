/**
 * Run the 14 rule-check test scenarios + produce a markdown report.
 *
 * Usage:
 *   npx tsx scripts/run-rule-check-test-suite.ts
 *   npx tsx scripts/run-rule-check-test-suite.ts --only S05,S12
 *   npx tsx scripts/run-rule-check-test-suite.ts --no-report
 *
 * Requires seed-rule-check-fixtures.ts to have been run first; otherwise
 * the candidates won't exist in neo4j and every scenario will fail with
 * a "candidate not found" pattern.
 *
 * Reads .env.local for LLM gateway + Ontology API config.
 * See docs/ontology/action_object_prompt/match-resume-data-preparation-design.md
 * for scenario definitions and expected outcomes.
 */

import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildRuleCheckInput, runRuleCheck } from "../lib/rule-check";
import type {
  MatchResumeCheckResult,
  RuleResult,
} from "../lib/rule-check";
import { chatComplete } from "../server/llm/gateway";
import {
  SCENARIOS,
  type ExpectedRuleStatus,
  type ScenarioFixture,
} from "./rule-check-test-suite/fixtures";

config({ path: path.resolve(process.cwd(), ".env.local"), override: true });
config({ path: path.resolve(process.cwd(), ".env"), override: false });

// ============================================================================
// CLI options
// ============================================================================

const argv = process.argv.slice(2);

/** --only S05,S12  → run a specific subset by scenario ID. */
const ONLY = (() => {
  const idx = argv.indexOf("--only");
  if (idx < 0) return null;
  const list = argv[idx + 1];
  if (!list) return null;
  return new Set(list.split(",").map((s) => s.trim()));
})();

/** --first N  → take the first N scenarios in declaration order.
 *  Composes with --only (filter first, then take first N). */
const FIRST_N: number | null = (() => {
  const idx = argv.indexOf("--first");
  if (idx < 0) return null;
  const v = argv[idx + 1];
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const NO_REPORT = argv.includes("--no-report");
const REPORT_PATH = "data/rule-check-test-report.md";

// ============================================================================
// Comparison logic
// ============================================================================

type CaseStatus = "pass" | "fail" | "error";

interface CaseResult {
  scenario: ScenarioFixture;
  status: CaseStatus;
  /** Description of the discrepancy when status !== 'pass'. */
  diff: string[];
  /** The actual result from runRuleCheck (null when the run errored out). */
  actual: MatchResumeCheckResult | null;
  /** Error string when status === 'error'. */
  error?: string;
  /** Wall-clock duration ms. */
  durationMs: number;
}

function findRuleResult(
  rule_results: RuleResult[],
  rule_id: string,
): RuleResult | undefined {
  return rule_results.find((r) => r.rule_id === rule_id);
}

function compare(
  sc: ScenarioFixture,
  actual: MatchResumeCheckResult,
): string[] {
  const diff: string[] = [];

  // 1. Decision
  if (actual.decision !== sc.expected.decision) {
    diff.push(
      `decision mismatch — expected ${sc.expected.decision}, got ${actual.decision}`,
    );
  }

  // 2. Per-rule expectations
  for (const [rule_id, expectedStatus] of Object.entries(sc.expected.rule_status)) {
    const got = findRuleResult(actual.rule_results, rule_id);
    if (!got) {
      diff.push(
        `rule ${rule_id} missing from rule_results — expected status='${expectedStatus}'`,
      );
      continue;
    }
    if (got.status !== expectedStatus) {
      diff.push(
        `rule ${rule_id}: expected '${expectedStatus}', got '${got.status}'${got.reason ? ` (reason: ${got.reason.slice(0, 100)})` : ""}`,
      );
    }
  }

  // 3. Short-circuit semantics
  if (sc.expected.short_circuit_after_rule) {
    const pivotRuleId = sc.expected.short_circuit_after_rule;
    const pivotIdx = actual.rule_results.findIndex(
      (r) => r.rule_id === pivotRuleId,
    );
    if (pivotIdx < 0) {
      diff.push(
        `short-circuit pivot rule ${pivotRuleId} not in rule_results — can't verify downstream not_executed`,
      );
    } else {
      // All rules after the pivot should be not_executed.
      const downstream = actual.rule_results.slice(pivotIdx + 1);
      const bad = downstream.filter((r) => r.status !== "not_executed");
      if (bad.length > 0) {
        diff.push(
          `short-circuit not honored — ${bad.length}/${downstream.length} downstream rules have status !== 'not_executed' ` +
            `(first violator: ${bad[0].rule_id}=${bad[0].status})`,
        );
      }
    }
  }

  return diff;
}

// ============================================================================
// Runner
// ============================================================================

async function runOne(sc: ScenarioFixture): Promise<CaseResult> {
  const started = Date.now();
  try {
    const input = buildRuleCheckInput({
      runtime_context: {
        upload_id: `upload-${sc.id}`,
        candidate_id: sc.candidate_id,
        resume_id: sc.resume_id,
        employee_id: "EMP_TEST",
        trace_id: `trace-${sc.id}`,
      },
      parsed_resume: null, // library now pulls resume from neo4j via candidate_id
      job_requisition: {
        job_requisition_id: sc.job_requisition_id,
        // The job_requisition object also lives in the prompt as §2.2 Inputs.
        // The library doesn't fetch JD by id from graph other than via
        // graph.job_requisition (Job_Requisition instance node), so passing
        // the id is enough; further structured fields can be added if
        // helpful for the LLM's reasoning (they're shown in the prompt).
      },
    });
    const actual = await runRuleCheck(input);
    const diff = compare(sc, actual);
    const durationMs = Date.now() - started;
    return {
      scenario: sc,
      status: diff.length === 0 ? "pass" : "fail",
      diff,
      actual,
      durationMs,
    };
  } catch (err) {
    return {
      scenario: sc,
      status: "error",
      diff: [`runRuleCheck threw: ${(err as Error).message.slice(0, 200)}`],
      actual: null,
      error: (err as Error).message,
      durationMs: Date.now() - started,
    };
  }
}

function statusBadge(s: CaseStatus): string {
  if (s === "pass") return "✓";
  if (s === "fail") return "✗";
  return "⚠";
}

function summarizeRuleStatuses(actual: MatchResumeCheckResult | null): string {
  if (!actual) return "—";
  const s = actual.stats;
  return `pass=${s.pass} fail=${s.fail} pending=${s.pending} info=${s.insufficient_info} nt=${s.not_triggered} ne=${s.not_executed}`;
}

function buildReport(results: CaseResult[], startedAt: Date): string {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errored = results.filter((r) => r.status === "error").length;

  const lines: string[] = [];
  lines.push(`# Rule Check Test Suite — Report`);
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Started:   ${startedAt.toISOString()}`);
  lines.push(`- Total:     ${results.length}`);
  lines.push(`- Passed:    ${passed}`);
  lines.push(`- Failed:    ${failed}`);
  lines.push(`- Errored:   ${errored}`);
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| # | Scenario | Expected | Got | Stats | Time | Result |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of results) {
    const expected = `${r.scenario.expected.decision}`;
    const got = r.actual?.decision ?? "—";
    const stats = summarizeRuleStatuses(r.actual);
    const time = `${r.durationMs}ms`;
    lines.push(
      `| ${r.scenario.id} | ${r.scenario.name} | ${expected} | ${got} | ${stats} | ${time} | ${statusBadge(r.status)} |`,
    );
  }
  lines.push("");

  // Per-scenario detail for any non-pass.
  const nonPass = results.filter((r) => r.status !== "pass");
  if (nonPass.length > 0) {
    lines.push("## Failures and errors");
    lines.push("");
    for (const r of nonPass) {
      lines.push(`### ${r.scenario.id} — ${r.scenario.name} ${statusBadge(r.status)}`);
      lines.push("");
      lines.push(`- **Expected decision:** ${r.scenario.expected.decision}`);
      if (Object.keys(r.scenario.expected.rule_status).length > 0) {
        lines.push(
          `- **Expected rule statuses:** ${Object.entries(r.scenario.expected.rule_status)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`,
        );
      }
      if (r.scenario.expected.short_circuit_after_rule) {
        lines.push(
          `- **Expected short-circuit after:** ${r.scenario.expected.short_circuit_after_rule}`,
        );
      }
      if (r.actual) {
        lines.push(`- **Got decision:** ${r.actual.decision}`);
        lines.push(`- **Got stats:** ${summarizeRuleStatuses(r.actual)}`);
        if (r.actual.audit.fail_reason) {
          lines.push(`- **Audit fail_reason:** ${r.actual.audit.fail_reason}`);
        }
      } else if (r.error) {
        lines.push(`- **Error:** ${r.error.slice(0, 400)}`);
      }
      lines.push("");
      lines.push(`- **Differences:**`);
      for (const d of r.diff) lines.push(`  - ${d}`);
      lines.push("");

      // If parse-error, surface the raw LLM text — the actual debug payload.
      if (r.actual?.audit.fail_reason === "parse-error" && r.actual.audit.raw_llm_text) {
        lines.push(`- **Raw LLM output (truncated to 2000 chars):**`);
        lines.push("");
        lines.push("  ```");
        for (const line of r.actual.audit.raw_llm_text.split("\n")) {
          lines.push(`  ${line}`);
        }
        lines.push("  ```");
        lines.push("");
      }

      // For failures with actual results, dump the rule_results table.
      if (r.actual) {
        lines.push(`- **Full rule_results:**`);
        lines.push("");
        lines.push(`  | rule_id | status | reason |`);
        lines.push(`  |---|---|---|`);
        for (const rr of r.actual.rule_results) {
          const reason = (rr.reason ?? "")
            .replace(/\|/g, "\\|")
            .replace(/\n/g, " ");
          lines.push(`  | ${rr.rule_id} | ${rr.status} | ${reason.slice(0, 200)} |`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n") + "\n";
}

// ============================================================================
// main
// ============================================================================

function checkEnv(): void {
  console.log("→ Environment check:");
  const has = (name: string): string =>
    process.env[name] ? "set" : "MISSING";
  console.log(`    ONTOLOGY_API_BASE   = ${has("ONTOLOGY_API_BASE")}`);
  console.log(`    ONTOLOGY_API_TOKEN  = ${has("ONTOLOGY_API_TOKEN")}`);
  console.log(`    AI_BASE_URL         = ${has("AI_BASE_URL")}`);
  console.log(`    AI_API_KEY          = ${has("AI_API_KEY")}`);
  console.log(`    AI_MODEL            = ${process.env.AI_MODEL ?? "(default: google/gemini-3-flash-preview)"}`);
  console.log(`    OPENAI_API_KEY      = ${has("OPENAI_API_KEY")}`);
  const ontologyOk = !!process.env.ONTOLOGY_API_BASE && !!process.env.ONTOLOGY_API_TOKEN;
  const llmOk =
    (!!process.env.AI_BASE_URL && !!process.env.AI_API_KEY) ||
    !!process.env.OPENAI_API_KEY;
  if (!ontologyOk) {
    console.warn(
      "  ⚠ ONTOLOGY_API_BASE / ONTOLOGY_API_TOKEN missing — every scenario will fail-safe with 'ontology-graph-unavailable'.",
    );
  }
  if (!llmOk) {
    console.warn(
      "  ⚠ No LLM gateway configured — every scenario will fail-safe with 'llm-call-error'.\n" +
        "    Set either AI_BASE_URL+AI_API_KEY OR OPENAI_API_KEY in .env.local.",
    );
  }
  console.log("");
}

async function probeLLM(): Promise<boolean> {
  console.log("→ LLM probe (one ping call to confirm gateway works):");

  // 1. Plain call — confirms basic connectivity + auth + model name.
  try {
    const t0 = Date.now();
    const res = await chatComplete({
      system: "You answer in one word only.",
      user: "Reply with exactly: OK",
      maxTokens: 10,
      // temperature + Kimi thinking-disable are picked automatically by the
      // gateway based on AI_MODEL — no per-model overrides needed here.
    });
    console.log(
      `    ✓ plain call: model=${res.modelUsed} ${Date.now() - t0}ms → "${res.text.slice(0, 40)}"`,
    );
  } catch (err) {
    console.error(`    ✗ plain call FAILED: ${(err as Error).message}`);
    console.error(
      "      → fix AI_BASE_URL / AI_API_KEY / AI_MODEL in .env.local before running scenarios.",
    );
    return false;
  }

  // 2. Tool-use call — runRuleCheck always sends tools. Some gateways accept
  //    plain chat but reject tools. This probe surfaces that.
  try {
    const t0 = Date.now();
    const res = await chatComplete({
      system: "You answer briefly.",
      user: "What is 2+2? Use the add tool.",
      maxTokens: 200,
      tools: {
        schema: [
          {
            type: "function",
            function: {
              name: "add",
              description: "Add two integers and return the sum.",
              parameters: {
                type: "object",
                properties: {
                  a: { type: "integer" },
                  b: { type: "integer" },
                },
                required: ["a", "b"],
              },
            },
          },
        ],
        onToolCall: async (_name, args) => {
          const { a, b } = args as { a: number; b: number };
          return { result: (a ?? 0) + (b ?? 0) };
        },
        maxIterations: 3,
      },
    });
    console.log(
      `    ✓ tool-use call: model=${res.modelUsed} rounds=${res.toolUseIterations} ${Date.now() - t0}ms → "${res.text.slice(0, 40)}"`,
    );
  } catch (err) {
    console.error(`    ✗ tool-use call FAILED: ${(err as Error).message}`);
    console.error(
      "      → gateway accepted plain chat but rejected tools. Either:\n" +
        "        - switch AI_MODEL to one that supports tool calling, or\n" +
        "        - use a gateway/proxy that translates tools (one-api, litellm).",
    );
    return false;
  }

  console.log("");
  return true;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  checkEnv();

  const llmOk = await probeLLM();
  if (!llmOk) {
    console.error("\n✗ aborting before scenarios — LLM probe failed.");
    process.exit(1);
  }

  // Apply --only first (filter by ID), then --first N (take leading slice).
  let selected: ScenarioFixture[] = ONLY
    ? SCENARIOS.filter((s) => ONLY!.has(s.id))
    : SCENARIOS;
  if (FIRST_N !== null) {
    selected = selected.slice(0, FIRST_N);
  }

  if (selected.length === 0) {
    console.error(
      `✗ no scenarios match the given filters; available IDs: ${SCENARIOS.map((s) => s.id).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`→ running ${selected.length} scenario(s)`);
  if (ONLY) console.log(`   filtered to IDs: ${[...ONLY].join(", ")}`);
  if (FIRST_N !== null) console.log(`   limited to first ${FIRST_N}`);
  console.log("");

  const results: CaseResult[] = [];
  for (const sc of selected) {
    process.stdout.write(`  ${sc.id} ${sc.name} ... `);
    const r = await runOne(sc);
    results.push(r);

    // Audit ribbon: makes it obvious whether the LLM + graph were actually called.
    const a = r.actual?.audit;
    const ribbon = a
      ? ` [graph=${a.graph_calls} llm_rounds=${a.llm_round_trips} llm_ms=${a.llm_duration_ms}` +
        (a.llm_completion_tokens !== undefined
          ? ` out=${a.llm_completion_tokens}t`
          : "") +
        (a.llm_finish_reason ? ` finish=${a.llm_finish_reason}` : "") +
        (a.fail_reason ? ` fail_reason=${a.fail_reason}` : "") +
        "]"
      : "";

    if (r.status === "pass") {
      console.log(`✓ (${r.durationMs}ms)${ribbon}`);
    } else if (r.status === "fail") {
      console.log(
        `✗ (${r.durationMs}ms)${ribbon} — ${r.diff[0]}${r.diff.length > 1 ? ` [+${r.diff.length - 1} more]` : ""}`,
      );
      // For parse-error, dump head + tail of the raw LLM text. Tail is the
      // key diagnostic — if the response ends mid-token like `"reason":` it's
      // a truncation; if it ends with a clean `}` but fewer rules than
      // expected, the model emitted incomplete data on purpose.
      if (
        r.actual?.audit.fail_reason === "parse-error" &&
        r.actual.audit.raw_llm_text
      ) {
        const raw = r.actual.audit.raw_llm_text;
        const totalLen = raw.length;
        console.log(`     raw LLM output (${totalLen} chars total):`);
        const HEAD = 600;
        const TAIL = 1000;
        if (totalLen <= HEAD + TAIL) {
          for (const line of raw.split("\n")) console.log(`       ${line}`);
        } else {
          for (const line of raw.slice(0, HEAD).split("\n"))
            console.log(`       ${line}`);
          console.log(`       …[${totalLen - HEAD - TAIL} chars elided]…`);
          for (const line of raw.slice(-TAIL).split("\n"))
            console.log(`       ${line}`);
        }
      }
    } else {
      console.log(`⚠ ERROR (${r.durationMs}ms) — ${r.error?.slice(0, 100)}`);
    }
  }

  // Summary
  console.log("");
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errored = results.filter((r) => r.status === "error").length;
  console.log(
    `── Summary: ${passed}/${results.length} passed · ${failed} failed · ${errored} errored ──`,
  );

  // Write report
  if (!NO_REPORT) {
    const report = buildReport(results, startedAt);
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, report, "utf8");
    console.log(`\n✓ report → ${REPORT_PATH}`);
  }

  // Exit non-zero if any case didn't pass (handy for CI usage later).
  if (passed !== results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("✗ test suite crashed:", err);
  process.exit(1);
});
