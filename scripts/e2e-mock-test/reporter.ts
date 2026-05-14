// Reporter — 把 PipelineRunResult + ScenarioVerification 渲染成 markdown。
//
// 每个 scenario 一份 .md(完整细节),全跑完后一份 _summary.md。

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { PipelineRunResult } from './pipeline-driver';
import { formatTraceTimeline } from './trace-collector';
import type { ScenarioVerification } from './verifier';

export interface ReportArgs {
  output_dir: string;
  run_id: string;
}

export function ensureOutputDir(args: ReportArgs): string {
  const dir = join(args.output_dir, args.run_id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function renderScenarioReport(
  result: PipelineRunResult,
  v: ScenarioVerification,
): string {
  const { scenario, rule_check, match_resume_call, neo4j_written } = result;
  const lines: string[] = [];

  lines.push(`# ${scenario.id} ${v.overall_passed ? '✅' : '❌'}`);
  lines.push('');
  lines.push(`> scenario: candidate=\`${scenario.candidate_id}\` × jd=\`${scenario.jd_id}\``);
  lines.push(`> rationale: ${scenario.expected.rationale}`);
  lines.push('');

  // §1 期望 vs 实际
  lines.push('## 1. Verdict — 期望 vs 实际');
  lines.push('');
  lines.push('| | 期望 | 实际 |');
  lines.push('|---|---|---|');
  lines.push(
    `| binary decision | ${scenario.expected.decision} | ${rule_check.decision} ${rule_check.decision === scenario.expected.decision ? '✓' : '✗'} |`,
  );
  lines.push(
    `| llm_decision | ${scenario.expected.llm_decision} | ${rule_check.llm_decision} |`,
  );
  lines.push(
    `| must-fail rules | ${scenario.expected.must_fail_rule_ids.join(', ') || '(none)'} | ${rule_check.failure_reasons.join(', ') || '(none)'} |`,
  );
  lines.push(
    `| augmentation injected | ${scenario.expected.must_have_augmentation ? 'yes' : 'no'} | ${match_resume_call.invoked && (match_resume_call.body?.resume ?? '').startsWith('## Rule Check Annotations') ? 'yes' : 'no'} |`,
  );
  lines.push('');

  // §2 Assertions detail
  lines.push('## 2. Assertions');
  lines.push('');
  for (const a of v.assertions) {
    const icon = a.passed ? '✅' : '❌';
    lines.push(`- ${icon} **${a.name}**${a.detail ? ` — ${a.detail}` : ''}`);
  }
  lines.push('');

  // §3 Evidence verification(Kenny 核心 ask)
  lines.push('## 3. Evidence 真实性核查');
  lines.push('');
  lines.push(
    `LLM 输出的每条 \`rule_flags[i].evidence\` 是否能在原始 parsed_resume 里 grep 到原文片段。`,
  );
  lines.push(`**Verifiable rate: ${(v.evidence_verifiable_rate * 100).toFixed(0)}%** (≥ 80% required)`);
  lines.push('');
  if (v.evidence_checks.length === 0) {
    lines.push('> (无 applicable rule_flags,跳过 evidence 验证)');
  } else {
    lines.push('| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |');
    lines.push('|---|---|---|---|---|---|');
    for (const ec of v.evidence_checks) {
      const ev = ec.evidence_text.replace(/\|/g, '\\|').slice(0, 100);
      const snippets = ec.quoted_snippets.slice(0, 3).join(', ').slice(0, 80);
      const matched = ec.matched_snippets.slice(0, 2).join(', ').slice(0, 60);
      const unmatched = ec.unmatched_snippets.slice(0, 2).join(', ').slice(0, 60);
      lines.push(
        `| ${ec.rule_id} | ${ev}${ec.evidence_text.length > 100 ? '…' : ''} | ${snippets} | ${matched || '—'} | ${unmatched || '—'} | ${ec.verified ? '✓' : '✗'} |`,
      );
    }
  }
  lines.push('');

  // §4 LLM raw output
  lines.push('## 4. LLM 原始输出(full JSON)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(rule_check.llm_output, null, 2));
  lines.push('```');
  lines.push('');

  // §5 augmentation injection 抓拍
  if (match_resume_call.invoked) {
    lines.push('## 5. matchResume 调用 — body.resume(注入 augmentation 后)');
    lines.push('');
    lines.push('```');
    lines.push((match_resume_call.body?.resume ?? '').slice(0, 2000));
    if ((match_resume_call.body?.resume ?? '').length > 2000) lines.push('...(truncated)');
    lines.push('```');
    lines.push('');
    lines.push(`**Robohire mock 回应 matchScore**: ${(match_resume_call.response as { matchScore?: number })?.matchScore ?? 'n/a'}`);
    lines.push('');
  } else {
    lines.push('## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)');
    lines.push('');
  }

  // §6 Neo4j 写入快照
  lines.push('## 6. Neo4j 实例数据写入');
  lines.push('');
  if (neo4j_written) {
    lines.push(`- **RuleCheckAudit** \`${neo4j_written.audit.audit_id}\``);
    lines.push(`  - run_id: \`${neo4j_written.audit.run_id}\``);
    lines.push(`  - decision: ${neo4j_written.audit.decision} / ${neo4j_written.audit.llm_decision}`);
    lines.push(`  - dims: client=\`${neo4j_written.audit.client_name}\` BG=\`${neo4j_written.audit.business_group ?? '(none)'}\``);
    lines.push(`  - LLM: model=\`${neo4j_written.audit.llm_model}\` duration=${neo4j_written.audit.llm_duration_ms} ms tokens=${neo4j_written.audit.llm_prompt_tokens ?? '?'}/${neo4j_written.audit.llm_completion_tokens ?? '?'}`);
    lines.push(`  - rules_evaluated: ${neo4j_written.audit.rules_evaluated} / ${neo4j_written.audit.rules_total_in_ontology}`);
    lines.push(`  - rule_source: \`${neo4j_written.audit.rule_source ?? 'unknown'}\``);
    lines.push(`  - partial_resume_fields: \`[${(neo4j_written.audit.partial_resume_fields ?? []).join(', ')}]\``);
    lines.push('');
    lines.push(`- **RuleCheckFlag** × ${neo4j_written.flags.length} (applicable=true 的全部):`);
    for (const f of neo4j_written.flags.slice(0, 30)) {
      lines.push(
        `  - \`${f.rule_id}\` [${f.severity}] result=${f.result} next=${f.next_action || '—'}`,
      );
    }
    if (neo4j_written.flags.length > 30) {
      lines.push(`  - ...(${neo4j_written.flags.length - 30} more)`);
    }
  } else {
    lines.push('> (rule check 未启用,跳过 Neo4j 写入)');
  }
  lines.push('');

  // §7 Timings
  lines.push('## 7. Timings');
  lines.push('');
  lines.push('| Step | Duration |');
  lines.push('|---|---|');
  lines.push(`| saveCandidate | ${fmtDuration(result.durations_ms.save_candidate)} |`);
  lines.push(`| fetch requirement | ${fmtDuration(result.durations_ms.fetch_requirement)} |`);
  lines.push(`| rule check (LLM) | ${fmtDuration(result.durations_ms.rule_check)} |`);
  lines.push(`| matchResume | ${fmtDuration(result.durations_ms.match_resume)} |`);
  lines.push(`| saveMatchResults | ${fmtDuration(result.durations_ms.save_match_results)} |`);
  lines.push(`| Neo4j write | ${fmtDuration(result.durations_ms.neo4j_write)} |`);
  lines.push(`| **total** | **${fmtDuration(result.durations_ms.total)}** |`);
  lines.push('');

  // §8 End-to-end Trace timeline
  lines.push('## 8. End-to-End Trace');
  lines.push('');
  lines.push(`**trace_id**: \`${result.trace_id}\` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop`);
  lines.push('');
  lines.push(formatTraceTimeline(result.trace_events));
  lines.push('');

  // §9 Error(if any)
  if (result.error) {
    lines.push('## 9. ERROR');
    lines.push('');
    lines.push('```');
    lines.push(result.error);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

export function renderSummary(
  results: Array<{ result: PipelineRunResult; verification: ScenarioVerification }>,
  run_id: string,
): string {
  const lines: string[] = [];
  lines.push(`# E2E Mock Test Run — ${run_id}`);
  lines.push('');
  const passed = results.filter((r) => r.verification.overall_passed).length;
  const total = results.length;
  lines.push(`**Result: ${passed}/${total} scenarios passed**`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| # | Scenario | Decision | Evidence rate | Status |');
  lines.push('|---|---|---|---|---|');
  results.forEach(({ result, verification }, i) => {
    const dec = `${result.rule_check.decision} (${result.rule_check.llm_decision})`;
    const ev = `${(verification.evidence_verifiable_rate * 100).toFixed(0)}%`;
    const passedCount = verification.assertions.filter((a) => a.passed).length;
    const totalCount = verification.assertions.length;
    const status = verification.overall_passed
      ? '✅ PASS'
      : `❌ FAIL (${passedCount}/${totalCount} assertions)`;
    lines.push(`| ${i + 1} | [${result.scenario.id}](${result.scenario.id}.md) | ${dec} | ${ev} | ${status} |`);
  });
  lines.push('');

  // Failed scenarios — list failed assertions
  const failed = results.filter((r) => !r.verification.overall_passed);
  if (failed.length > 0) {
    lines.push('## Failed assertions (details)');
    lines.push('');
    for (const { result, verification } of failed) {
      lines.push(`### ${result.scenario.id}`);
      lines.push('');
      for (const a of verification.assertions.filter((x) => !x.passed)) {
        lines.push(`- ❌ **${a.name}**${a.detail ? ` — ${a.detail}` : ''}`);
      }
      lines.push('');
    }
  }

  // Evidence aggregate
  lines.push('## Evidence verifiability');
  lines.push('');
  const totalEvidence = results.reduce(
    (sum, r) => sum + r.verification.evidence_checks.length,
    0,
  );
  const verifiedEvidence = results.reduce(
    (sum, r) => sum + r.verification.evidence_checks.filter((e) => e.verified).length,
    0,
  );
  const overallRate = totalEvidence === 0 ? 1 : verifiedEvidence / totalEvidence;
  lines.push(
    `**Aggregate verifiability: ${verifiedEvidence}/${totalEvidence} (${(overallRate * 100).toFixed(0)}%)**`,
  );
  lines.push('');
  lines.push(
    '说明:每条 LLM 输出的 `evidence` 字段抽取看起来像引用的片段,在原始 parsed_resume JSON 里 grep。`未提供 / 缺失` 这种 NOT_APPLICABLE 说明的也视为 verified-by-design。',
  );
  lines.push('');

  return lines.join('\n');
}

export function writeScenarioReport(args: {
  result: PipelineRunResult;
  verification: ScenarioVerification;
  output_dir: string;
}): string {
  const md = renderScenarioReport(args.result, args.verification);
  const file = join(args.output_dir, `${args.result.scenario.id}.md`);
  writeFileSync(file, md);
  return file;
}

export function writeSummaryReport(args: {
  results: Array<{ result: PipelineRunResult; verification: ScenarioVerification }>;
  output_dir: string;
  run_id: string;
}): string {
  const md = renderSummary(args.results, args.run_id);
  const file = join(args.output_dir, `_summary.md`);
  writeFileSync(file, md);
  return file;
}
