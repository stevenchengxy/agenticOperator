// Evidence trail UI — renders the AgentStepEvidence rows for one run.
//
// Each row shows:
//   - step name + kind icon
//   - external call (RAAS / Allmeta endpoint)
//   - input JSON (collapsible, default closed)
//   - output JSON (collapsible, default open)
//   - Allmeta-specific: PK value + Cypher hint (if step_kind=allmeta_write)
//   - error message (red box, if step failed)

'use client';

import { useEffect, useState } from 'react';
import { useApp } from '@/lib/i18n';

export type EvidenceRow = {
  id: string;
  run_id: string;
  flow_id: string;
  function_slug: string;
  step_name: string;
  step_kind: string;
  external_call?: string | null;
  input?: unknown;
  output?: unknown;
  error_message?: string | null;
  duration_ms?: number | null;
  allmeta_label?: string | null;
  allmeta_pk_value?: string | null;
  allmeta_neo4j?: string | null;
  created_at: string;
};

const KIND_META: Record<string, { icon: string; labelKey: string; color: string }> = {
  guard: { icon: '🔒', labelKey: 'mox_ev_kind_guard', color: 'text-ink-3' },
  fetch: { icon: '↓', labelKey: 'mox_ev_kind_fetch', color: 'text-accent' },
  compute: { icon: '⚙', labelKey: 'mox_ev_kind_compute', color: 'text-ink-2' },
  persist: { icon: '💾', labelKey: 'mox_ev_kind_persist', color: 'text-ok' },
  audit: { icon: '📋', labelKey: 'mox_ev_kind_audit', color: 'text-ink-3' },
  subsystem: { icon: '⚡', labelKey: 'mox_ev_kind_subsystem', color: 'text-warn' },
  emit: { icon: '→', labelKey: 'mox_ev_kind_emit', color: 'text-ink-2' },
  allmeta_write: { icon: '🗄', labelKey: 'mox_ev_kind_allmeta_write', color: 'text-accent' },
};

export function EvidenceTrail({ runId }: { runId: string }) {
  const { t } = useApp();
  const [rows, setRows] = useState<EvidenceRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/inngest-admin/runs/${runId}/evidence`);
        const b = await r.json();
        if (!cancelled) {
          setRows(b.evidence ?? []);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (loading) return <div className="text-[11px] text-ink-3">{t('mox_ev_loading')}</div>;
  if (!rows || rows.length === 0) {
    return (
      <div className="text-[11px] text-ink-4 px-2 py-2 border border-dashed border-line rounded">
        {t('mox_ev_empty')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase text-ink-4 tracking-wide mb-1">
        {t('mox_ev_trail_count').replace('{n}', String(rows.length))}
      </div>
      {rows.map((r) => (
        <EvidenceCard key={r.id} row={r} />
      ))}
    </div>
  );
}

function EvidenceCard({ row }: { row: EvidenceRow }) {
  const { t } = useApp();
  const meta = KIND_META[row.step_kind] ?? { icon: '·', labelKey: null, color: 'text-ink-2' };
  const metaLabel = meta.labelKey ? t(meta.labelKey) : row.step_kind;
  const [inputOpen, setInputOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(true);
  const isError = !!row.error_message;
  const isAllmeta = row.step_kind === 'allmeta_write';
  const isRuleCheck = row.step_kind === 'subsystem' && row.step_name.startsWith('rule-check-');

  return (
    <div
      className={`border rounded-md ${
        isError ? 'border-err bg-err-bg/30' : isAllmeta ? 'border-accent bg-accent-bg/20' : 'border-line bg-surface'
      } p-3`}
    >
      {/* Header */}
      <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
        <span className="text-[14px] shrink-0">{meta.icon}</span>
        <span className="text-[12px] font-semibold text-ink-1">{row.step_name}</span>
        <span className={`text-[10px] mono uppercase tracking-wide ${meta.color}`}>
          {metaLabel}
        </span>
        {row.duration_ms != null && (
          <span className="text-[10px] mono text-ink-4">{row.duration_ms}ms</span>
        )}
        {isError && (
          <span className="text-[10px] mono font-bold text-err">✗ FAILED</span>
        )}
        <span className="ml-auto text-[10px] mono text-ink-4">
          {new Date(row.created_at).toLocaleString('zh-CN', { hour12: false })}
        </span>
      </div>

      {/* External call */}
      {row.external_call && (
        <div className="text-[11px] mb-2 flex items-baseline gap-2">
          <span className="text-ink-4 uppercase text-[10px]">{t('mox_ev_external_call')}</span>
          <span className="mono text-accent">{row.external_call}</span>
        </div>
      )}

      {/* Rule-check rich render */}
      {isRuleCheck && <RuleCheckPanel row={row} />}

      {/* Allmeta-specific extra */}
      {isAllmeta && row.allmeta_label && (
        <div className="text-[11px] mb-2 space-y-0.5 bg-panel border border-line rounded px-2 py-1.5">
          <div className="flex items-baseline gap-2">
            <span className="text-ink-4 uppercase text-[10px]">{t('mox_ev_write_dataobject')}</span>
            <span className="mono font-medium text-accent">:{row.allmeta_label}</span>
            {row.allmeta_pk_value && (
              <span className="mono text-ink-3">PK = {row.allmeta_pk_value}</span>
            )}
          </div>
          {/* Cypher snippet kept for dev verification of written instances.
              Per 2026-05-25 user clarification: hide direct-entry jumps
              into the graph engine, but the Cypher itself stays so devs
              can copy + paste to verify writes outside the UI. */}
          {row.allmeta_neo4j && (
            <div>
              <div className="text-ink-4 uppercase text-[10px] mb-0.5">{t('mox_ev_write_cypher')}</div>
              <pre className="mono text-[10.5px] text-ink-2 whitespace-pre-wrap break-words bg-bg/40 border border-line rounded px-2 py-1 select-all">{row.allmeta_neo4j}</pre>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="text-[11px] mono text-err bg-err-bg/40 px-2 py-1 rounded mb-2">
          ✗ {row.error_message}
        </div>
      )}

      {/* Input (collapsible) — hidden for rule-check rows; RuleCheckPanel
          already renders the rule-evaluation specifics + prompt-level
          collapsibles in a structured way, so the raw JSON dump would be
          redundant duplicate noise. */}
      {!isRuleCheck && row.input !== null && row.input !== undefined && (
        <details open={inputOpen} onToggle={(e) => setInputOpen((e.target as HTMLDetailsElement).open)} className="mb-1.5">
          <summary className="cursor-pointer text-[10.5px] uppercase text-ink-4 tracking-wide select-none">
            ▸ {t('mox_ev_input_summary')}
          </summary>
          <pre className="mt-1.5 text-[10.5px] mono bg-panel border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
            {JSON.stringify(row.input, null, 2)}
          </pre>
        </details>
      )}

      {/* Output (default open for visibility) — same: skip for rule-check */}
      {!isRuleCheck && row.output !== null && row.output !== undefined && (
        <details open={outputOpen} onToggle={(e) => setOutputOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer text-[10.5px] uppercase text-ink-4 tracking-wide select-none">
            ▸ {t('mox_ev_output_summary')}
          </summary>
          <pre className="mt-1.5 text-[10.5px] mono bg-panel border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
            {JSON.stringify(row.output, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Specialised render for rule-check step (Match Resume Agent's gate).
// Shows: overall decision badge · per-rule flags table (with severity,
// applicable_client, result tone, evidence) · failure_reasons · resume
// augmentation markdown · raw LLM text · collapsible system + user
// prompt for debugging.
// ─────────────────────────────────────────────────────────────

type RuleFlagOut = {
  rule_id: string;
  rule_name: string;
  severity?: string;
  applicable?: boolean;
  applicable_client?: string;
  result: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'REVIEW';
  evidence?: string;
  next_action?: string;
};

type RuleCheckOutput = {
  decision?: 'PASS' | 'FAIL';
  llm_decision?: string;
  counts?: {
    total: number;
    pass: number;
    fail: number;
    not_applicable: number;
    missing_info_reclassified: number;
  };
  failure_reasons?: string[];
  rule_flags?: RuleFlagOut[];
  resume_augmentation?: string;
  llm?: {
    model?: string;
    duration_ms?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    raw_text?: string;
    parse_error?: string;
  };
};

type RuleCheckInput = {
  job_requisition_id?: string;
  candidate_id?: string;
  rule_source?: string;
  rules_evaluated?: number;
  rules_total_in_ontology?: number;
  partial_resume_fields?: string[] | null;
  filtered_out_rules?: Array<{
    rule_id: string;
    rule_name: string;
    applicable_client?: string;
    reason?: string;
  }>;
  system_prompt?: string;
  user_prompt?: string;
  dims?: Record<string, unknown>;
};

function resultBadgeClass(r: string): string {
  switch (r) {
    case 'PASS':
      return 'bg-ok-bg text-ok border-ok';
    case 'FAIL':
      return 'bg-err-bg text-err border-err';
    case 'NOT_APPLICABLE':
      return 'bg-ink-4/10 text-ink-3 border-line';
    case 'REVIEW':
      return 'bg-warn-bg text-warn border-warn';
    default:
      return 'bg-surface text-ink-3 border-line';
  }
}

function coerceObj<T>(v: unknown): T {
  // Defensive: if a captured payload exceeded MAX_JSON_CHARS in an older
  // build, the API returns the truncated raw string instead of an object.
  // Try to recover by parsing, else return an empty object so the panel
  // degrades gracefully instead of showing dashes everywhere.
  if (!v) return {} as T;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return {} as T;
    }
  }
  return v as T;
}

function RuleCheckPanel({ row }: { row: EvidenceRow }) {
  const { t } = useApp();
  const out = coerceObj<RuleCheckOutput>(row.output);
  const inp = coerceObj<RuleCheckInput>(row.input);
  const rawWasString = typeof row.output === 'string';
  const flags = out.rule_flags ?? [];
  const counts = out.counts;
  const failedFlags = flags.filter((f) => f.result === 'FAIL');
  const passedFlags = flags.filter((f) => f.result === 'PASS');
  const naFlags = flags.filter((f) => f.result === 'NOT_APPLICABLE');

  return (
    <div className="space-y-2 mb-2">
      {rawWasString && out.decision == null && (
        <div className="text-[10.5px] bg-warn-bg/30 border border-warn/40 rounded px-2 py-1.5 text-warn">
          ⚠ {t('mox_ev_truncated_pre')} <span className="mono">↺</span> {t('mox_ev_truncated_post')}
        </div>
      )}
      {/* Decision banner */}
      <div className="flex items-baseline gap-2 flex-wrap text-[11px] bg-panel border border-line rounded px-2 py-1.5">
        <span className="text-ink-4 uppercase text-[10px]">{t('mox_ev_decision')}</span>
        <span
          className={`mono font-bold px-1.5 py-0.5 rounded text-[11px] ${
            out.decision === 'PASS' ? 'text-ok' : 'text-err'
          }`}
        >
          {out.decision ?? '—'}
        </span>
        <span className="text-ink-4">·</span>
        <span className="text-ink-3">{t('mox_ev_llm_raw')}</span>
        <span className="mono text-ink-2">{out.llm_decision ?? '—'}</span>
        {counts && (
          <>
            <span className="text-ink-4">·</span>
            <span className="text-ink-3">
              {t('mox_ev_rules')} <span className="mono text-ok">{counts.pass} ✓</span>{' '}
              <span className="mono text-err">{counts.fail} ✗</span>{' '}
              <span className="mono text-ink-3">{counts.not_applicable} —</span>{' '}
              <span className="text-ink-4">{t('mox_ev_rules_total').replace('{n}', String(counts.total))}</span>
            </span>
            {counts.missing_info_reclassified > 0 && (
              <span className="text-warn mono">
                · {t('mox_ev_auto_pass').replace('{n}', String(counts.missing_info_reclassified))}
              </span>
            )}
          </>
        )}
        {out.llm?.model && (
          <span className="ml-auto text-[10px] mono text-ink-4">
            {out.llm.model} · {out.llm.duration_ms}ms
            {out.llm.prompt_tokens != null &&
              ` · ${out.llm.prompt_tokens}+${out.llm.completion_tokens ?? '?'}tok`}
          </span>
        )}
      </div>

      {/* Failure reasons banner (if any) */}
      {out.failure_reasons && out.failure_reasons.length > 0 && (
        <div className="text-[11px] bg-err-bg/30 border border-err/40 rounded px-2 py-1.5">
          <div className="text-err uppercase text-[10px] mb-0.5">{t('mox_ev_failure_reasons')}</div>
          <ul className="list-disc list-inside text-ink-2 space-y-0.5">
            {out.failure_reasons.map((r, i) => (
              <li key={i} className="mono text-[10.5px] break-words">
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Rule flags table */}
      {flags.length > 0 && (
        <details open className="text-[11px] bg-panel border border-line rounded">
          <summary className="cursor-pointer px-2 py-1.5 text-ink-3 uppercase text-[10px] tracking-wide select-none">
            ▸ {t('mox_ev_rule_detail_summary')
              .replace('{total}', String(flags.length))
              .replace('{pass}', String(passedFlags.length))
              .replace('{fail}', String(failedFlags.length))
              .replace('{na}', String(naFlags.length))}
          </summary>
          <div className="overflow-x-auto">
            <table className="w-full text-[10.5px] mono">
              <thead className="bg-bg/40 text-ink-4 uppercase text-[9.5px]">
                <tr>
                  <th className="text-left px-2 py-1 border-b border-line">Rule ID</th>
                  <th className="text-left px-2 py-1 border-b border-line">{t('mox_ev_col_rule_name')}</th>
                  <th className="text-left px-2 py-1 border-b border-line">{t('mox_ev_col_severity')}</th>
                  <th className="text-left px-2 py-1 border-b border-line">{t('mox_ev_col_client')}</th>
                  <th className="text-left px-2 py-1 border-b border-line">{t('mox_ev_col_result')}</th>
                  <th className="text-left px-2 py-1 border-b border-line">{t('mox_ev_col_reason')}</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((f, i) => (
                  <tr key={i} className="border-b border-line/50 align-top">
                    <td className="px-2 py-1 text-ink-2">{f.rule_id}</td>
                    <td className="px-2 py-1 text-ink-2">{f.rule_name}</td>
                    <td className="px-2 py-1 text-ink-3">{f.severity ?? '—'}</td>
                    <td className="px-2 py-1 text-ink-3">{f.applicable_client ?? '—'}</td>
                    <td className="px-2 py-1">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${resultBadgeClass(f.result)}`}
                      >
                        {f.result}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-ink-2 whitespace-pre-wrap break-words max-w-[480px]">
                      {f.evidence ?? '—'}
                      {f.next_action && (
                        <div className="text-ink-4 text-[10px] mt-0.5">→ {f.next_action}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Resume augmentation (LLM 加给 RoboHire 的注解) */}
      {out.resume_augmentation && out.resume_augmentation.trim().length > 0 && (
        <details className="text-[11px] bg-accent-bg/10 border border-accent/30 rounded">
          <summary className="cursor-pointer px-2 py-1.5 text-accent uppercase text-[10px] tracking-wide select-none">
            ▸ {t('mox_ev_resume_aug').replace('{n}', String(out.resume_augmentation.length))}
          </summary>
          <pre className="px-2 py-1.5 text-[10.5px] mono text-ink-2 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
            {out.resume_augmentation}
          </pre>
        </details>
      )}

      {/* Filtered-out rules (上游已经过滤掉的,根本没进 prompt) */}
      {inp.filtered_out_rules && inp.filtered_out_rules.length > 0 && (
        <details className="text-[11px] bg-bg/40 border border-line rounded">
          <summary className="cursor-pointer px-2 py-1.5 text-ink-4 uppercase text-[10px] tracking-wide select-none">
            ▸ {t('mox_ev_filtered_rules').replace('{n}', String(inp.filtered_out_rules.length))}
          </summary>
          <ul className="px-2 py-1.5 space-y-0.5">
            {inp.filtered_out_rules.map((r, i) => (
              <li key={i} className="mono text-[10.5px] text-ink-3">
                {r.rule_id} · {r.rule_name} <span className="text-ink-4">— {r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* LLM raw text (debug) */}
      {out.llm?.raw_text && (
        <details className="text-[11px] bg-bg/40 border border-line rounded">
          <summary className="cursor-pointer px-2 py-1.5 text-ink-4 uppercase text-[10px] tracking-wide select-none">
            ▸ {t('mox_ev_llm_raw_return').replace('{n}', String(out.llm.raw_text.length))}
          </summary>
          <pre className="px-2 py-1.5 text-[10.5px] mono text-ink-2 whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
            {out.llm.raw_text}
          </pre>
        </details>
      )}

      {/* System + user prompt (for full reproducibility) */}
      {inp.user_prompt && (
        <details className="text-[11px] bg-bg/40 border border-line rounded">
          <summary className="cursor-pointer px-2 py-1.5 text-ink-4 uppercase text-[10px] tracking-wide select-none">
            ▸ {t('mox_ev_user_prompt').replace('{n}', String(inp.user_prompt.length))}
          </summary>
          <pre className="px-2 py-1.5 text-[10.5px] mono text-ink-2 whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
            {inp.user_prompt}
          </pre>
        </details>
      )}
      {inp.system_prompt && (
        <details className="text-[11px] bg-bg/40 border border-line rounded">
          <summary className="cursor-pointer px-2 py-1.5 text-ink-4 uppercase text-[10px] tracking-wide select-none">
            ▸ {t('mox_ev_system_prompt').replace('{n}', String(inp.system_prompt.length))}
          </summary>
          <pre className="px-2 py-1.5 text-[10.5px] mono text-ink-2 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
            {inp.system_prompt}
          </pre>
        </details>
      )}
    </div>
  );
}
