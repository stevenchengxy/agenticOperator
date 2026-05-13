import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_32: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const jrId = (graph.job_requisition as Record<string, unknown> | null)?.job_requisition_id as string | undefined;
  const apps = (graph.applications ?? []) as Array<{ application_id: string; job_requisition_id: string; push_timestamp: string; status: string }>;
  const today = (runtime.received_at ?? '').slice(0, 10);

  const sameJobApps = jrId ? apps.filter((a) => a.job_requisition_id === jrId) : [];
  for (const a of sameJobApps) {
    steps.push({
      kind: 'graph_node', node: 'application', field: 'push_timestamp',
      value: `${a.application_id} · pushed ${a.push_timestamp} · status=${a.status}`,
    });
    const months = monthsDiffISO(a.push_timestamp, today);
    if (months !== null) {
      steps.push({ kind: 'computation', label: '距上次推送', value: `≈ ${months.toFixed(1)} months` });
    }
    highlight.push('application');
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};

function monthsDiffISO(a: string, b: string): number | null {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return (db - da) / (1000 * 60 * 60 * 24 * 30);
}
