"use client";

import React from "react";

export type ScenarioResultPayload = {
  scenario_id: string;
  scenario_name: string;
  expected: { decision: string; rule_status: Record<string, string> };
  actual: { decision: string; stats: Record<string, number> };
  rule_results: Array<{ rule_id: string; rule_name: string; step_id: string; status: string; reason?: string }>;
  match_kind: string;
  failures: string[];
  inference_chain: Array<{ rule_id: string; steps: Array<Record<string, unknown>>; highlight_nodes: string[] }>;
  graph_context: Record<string, unknown> | null | undefined;
  audit: {
    llm_ms: number; llm_model: string; prompt_tokens?: number;
    completion_tokens?: number; finish_reason?: string; graph_calls: number;
    raw_llm_text?: string;
  };
};

export type StreamState =
  | { phase: 'idle' }
  | { phase: 'running'; run_id: string; results: ScenarioResultPayload[] }
  | { phase: 'done'; run_id: string; results: ScenarioResultPayload[]; summary: { total: number; pass: number; fail: number; total_llm_ms: number } }
  | { phase: 'error'; run_id?: string; results: ScenarioResultPayload[]; message: string };

export function useRunStream() {
  const [state, setState] = React.useState<StreamState>({ phase: 'idle' });
  const abortRef = React.useRef<AbortController | null>(null);

  const start = React.useCallback(async (body: { model?: string; client_id_override?: string; scenarios?: string[] }) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setState({ phase: 'running', run_id: '', results: [] });
    let runId = '';
    const results: ScenarioResultPayload[] = [];

    try {
      const resp = await fetch('/api/rule-check/runs', {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok || !resp.body) throw new Error(`POST failed: ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventMatch = chunk.match(/^event:\s*(\w+)/m);
          const dataMatch = chunk.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const evType = eventMatch[1];
          const payload = JSON.parse(dataMatch[1]);

          if (evType === 'started') {
            runId = payload.run_id;
            setState({ phase: 'running', run_id: runId, results: [] });
          } else if (evType === 'result') {
            results.push(payload.scenario as ScenarioResultPayload);
            setState({ phase: 'running', run_id: runId, results: [...results] });
          } else if (evType === 'done') {
            setState({ phase: 'done', run_id: runId, results: [...results], summary: payload.summary });
          } else if (evType === 'error') {
            setState({ phase: 'error', run_id: runId, results: [...results], message: payload.message });
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState({ phase: 'error', run_id: runId, results, message: (err as Error).message });
    }
  }, []);

  const abort = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { state, start, abort };
}
