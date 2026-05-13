"use client";

import React from "react";
import { TopBar } from "./TopBar";
import { MetricsStrip } from "./MetricsStrip";
import { RuleConfusionStrip } from "./RuleConfusionStrip";
import { ScenarioMatrix } from "./ScenarioMatrix";
import { CaseDrawer } from "./CaseDrawer";
import { useRunStream, type ScenarioResultPayload } from "./use-run-stream";
import type { RuleStatus } from "@/lib/rule-check/types";

type Scenario = {
  id: string; name: string;
  candidate_id: string; resume_id: string; job_requisition_id: string;
  expected: { decision: string; rule_status: Record<string, string> };
};

type RunListItem = {
  id: string; startedAt: string; model: string; passCount: number; failCount: number; totalScenarios: number;
};

type StoredScenarioRow = {
  scenarioId: string; scenarioName: string;
  expectedDecision: string; expectedRules: string;
  actualDecision: string; actualStats: string; ruleResults: string;
  matchKind: string; failures: string | null;
  inferenceChain: string; graphContext: string;
  llmMs: number; llmModel: string;
  promptTokens: number | null; completionTokens: number | null;
  finishReason: string | null; graphCalls: number; rawLlmText: string | null;
};

export function RuleCheckContent() {
  const [scenarios, setScenarios] = React.useState<Scenario[]>([]);
  const [runs, setRuns] = React.useState<RunListItem[]>([]);
  const [currentRunId, setCurrentRunId] = React.useState<string | null>(null);
  const [compareRunId, setCompareRunId] = React.useState<string | null>(null);
  const [model, setModel] = React.useState('gemini-3-flash-preview');
  const [clientOverride, setClientOverride] = React.useState('');
  const [ruleFilter, setRuleFilter] = React.useState<string | null>(null);
  const [pastRunResults, setPastRunResults] = React.useState<ScenarioResultPayload[]>([]);
  const [compareResults, setCompareResults] = React.useState<ScenarioResultPayload[]>([]);

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = React.useState<string | null>(null);
  const [selectedRuleId, setSelectedRuleId] = React.useState<string | null>(null);
  const [neo4jBase, setNeo4jBase] = React.useState<string | undefined>(undefined);
  const [replayInFlight, setReplayInFlight] = React.useState(false);

  const { state, start } = useRunStream();

  // Hydrate scenarios + runs list + neo4j base on mount.
  React.useEffect(() => {
    void (async () => {
      const [scenRes, runsRes, cfg] = await Promise.all([
        fetch('/api/rule-check/scenarios').then((r) => r.json()) as Promise<{ scenarios: Scenario[] }>,
        fetch('/api/rule-check/runs').then((r) => r.json()) as Promise<{ runs: RunListItem[] }>,
        fetch('/api/rule-check/config').then((r) => r.json()) as Promise<{ neo4j_browser_base: string | null }>,
      ]);
      setScenarios(scenRes.scenarios);
      setRuns(runsRes.runs);
      setNeo4jBase(cfg.neo4j_browser_base ?? undefined);
      // Auto-load most recent run on first paint
      if (runsRes.runs.length > 0) {
        setCurrentRunId(runsRes.runs[0].id);
      }
    })();
  }, []);

  // Load selected past run.
  React.useEffect(() => {
    if (!currentRunId || state.phase === 'running') { return; }
    void (async () => {
      const res = await fetch(`/api/rule-check/runs/${currentRunId}`).then((r) => r.json()) as {
        run: { id: string } | null;
        scenarios: StoredScenarioRow[];
      };
      setPastRunResults(res.scenarios.map(rowToPayload));
    })();
  }, [currentRunId, state.phase]);

  // Load compare run.
  React.useEffect(() => {
    if (!compareRunId) { setCompareResults([]); return; }
    void (async () => {
      const res = await fetch(`/api/rule-check/runs/${compareRunId}`).then((r) => r.json()) as {
        scenarios: StoredScenarioRow[];
      };
      setCompareResults(res.scenarios.map(rowToPayload));
    })();
  }, [compareRunId]);

  // Decide which results to display.
  const liveResults = (state.phase === 'running' || state.phase === 'done' || state.phase === 'error') ? state.results : [];
  const showLive = state.phase === 'running' || (state.phase !== 'idle' && !currentRunId);
  const displayResults = showLive ? liveResults : pastRunResults;

  const expectedByScenario = React.useMemo(() => {
    const map: Record<string, Record<string, RuleStatus>> = {};
    for (const s of scenarios) map[s.id] = s.expected.rule_status as Record<string, RuleStatus>;
    return map;
  }, [scenarios]);

  const runningScenarioIds = React.useMemo(() => {
    if (state.phase !== 'running') return new Set<string>();
    const done = new Set(state.results.map((r) => r.scenario_id));
    return new Set(scenarios.filter((s) => !done.has(s.id)).map((s) => s.id));
  }, [state, scenarios]);

  const refreshRuns = async () => {
    const runsRes = await fetch('/api/rule-check/runs').then((r) => r.json()) as { runs: RunListItem[] };
    setRuns(runsRes.runs);
  };

  const onRunAll = async () => {
    setCurrentRunId(null);
    await start({ model, client_id_override: clientOverride || undefined });
    await refreshRuns();
  };

  const onReplayFailed = async () => {
    const failedIds = displayResults.filter((r) => r.match_kind !== 'pass').map((r) => r.scenario_id);
    if (failedIds.length === 0) return;
    setCurrentRunId(null);
    await start({ model, client_id_override: clientOverride || undefined, scenarios: failedIds });
    await refreshRuns();
  };

  const onExport = () => {
    const blob = new Blob([JSON.stringify({ results: displayResults }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `rule-check-export-${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const selectedResult = selectedScenarioId
    ? displayResults.find((r) => r.scenario_id === selectedScenarioId) ?? null
    : null;

  const onReplay = async () => {
    if (!selectedResult) return;
    const targetRunId = currentRunId ?? (state.phase !== 'idle' ? state.run_id : undefined);
    if (!targetRunId) return;
    setReplayInFlight(true);
    try {
      const res = await fetch(`/api/rule-check/runs/${targetRunId}/replay/${selectedResult.scenario_id}`, { method: 'POST' });
      if (!res.ok) return;
      const j = await res.json() as { scenario: StoredScenarioRow };
      const updated = rowToPayload(j.scenario);
      setPastRunResults((prev) => {
        const idx = prev.findIndex((p) => p.scenario_id === updated.scenario_id);
        if (idx === -1) return [...prev, updated];
        const next = [...prev]; next[idx] = updated; return next;
      });
      if (!currentRunId) setCurrentRunId(targetRunId);
      await refreshRuns();
    } finally {
      setReplayInFlight(false);
    }
  };

  return (
    <div className="flex flex-col">
      <TopBar
        model={model} setModel={setModel}
        clientOverride={clientOverride} setClientOverride={setClientOverride}
        runs={runs.map((r) => ({ id: r.id, startedAt: r.startedAt, model: r.model, passCount: r.passCount, totalScenarios: r.totalScenarios }))}
        currentRunId={currentRunId} setCurrentRunId={setCurrentRunId}
        compareRunId={compareRunId} setCompareRunId={setCompareRunId}
        isRunning={state.phase === 'running'}
        onRunAll={onRunAll} onReplayFailed={onReplayFailed} onExport={onExport}
      />
      <MetricsStrip results={displayResults} expectedTotal={scenarios.length} />
      <RuleConfusionStrip
        results={displayResults}
        expectedByScenario={expectedByScenario}
        ruleFilter={ruleFilter} setRuleFilter={setRuleFilter}
      />
      <ScenarioMatrix
        scenarios={scenarios}
        results={displayResults}
        ruleFilter={ruleFilter}
        runningScenarioIds={runningScenarioIds}
        onCellClick={(scenarioId, ruleId) => { setSelectedScenarioId(scenarioId); setSelectedRuleId(ruleId); setDrawerOpen(true); }}
        compareResults={compareResults.length ? compareResults : undefined}
        modelLabel={compareResults.length ? `Current · ${runs.find((r) => r.id === currentRunId)?.model ?? model}` : undefined}
      />
      {compareResults.length > 0 && (
        <ScenarioMatrix
          scenarios={scenarios}
          results={compareResults}
          ruleFilter={ruleFilter}
          runningScenarioIds={new Set()}
          onCellClick={(scenarioId, ruleId) => { setSelectedScenarioId(scenarioId); setSelectedRuleId(ruleId); setDrawerOpen(true); }}
          compareResults={displayResults}
          modelLabel={`Compare · ${runs.find((r) => r.id === compareRunId)?.model ?? '?'}`}
        />
      )}
      {state.phase === 'error' && (
        <div className="px-3 py-2 text-[color:var(--c-err)] text-[12px] border-t border-line bg-[color:var(--c-err-bg)]">
          Error: {state.message}
        </div>
      )}
      {displayResults.length === 0 && state.phase !== 'running' && (
        <div className="px-3 py-6 text-ink-3 text-[12px] border-t border-line text-center">
          No runs yet. Click ▶ Run All to start.
        </div>
      )}
      <CaseDrawer
        result={selectedResult}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        selectedRuleId={selectedRuleId}
        setSelectedRuleId={setSelectedRuleId}
        neo4jBrowserBase={neo4jBase}
        onReplay={onReplay}
        replayInFlight={replayInFlight}
      />
    </div>
  );
}

function rowToPayload(row: StoredScenarioRow): ScenarioResultPayload {
  return {
    scenario_id: row.scenarioId,
    scenario_name: row.scenarioName,
    expected: { decision: row.expectedDecision, rule_status: JSON.parse(row.expectedRules) },
    actual: { decision: row.actualDecision, stats: JSON.parse(row.actualStats) },
    rule_results: JSON.parse(row.ruleResults),
    match_kind: row.matchKind,
    failures: row.failures ? JSON.parse(row.failures) : [],
    inference_chain: JSON.parse(row.inferenceChain),
    graph_context: JSON.parse(row.graphContext),
    audit: {
      llm_ms: row.llmMs, llm_model: row.llmModel,
      prompt_tokens: row.promptTokens ?? undefined, completion_tokens: row.completionTokens ?? undefined,
      finish_reason: row.finishReason ?? undefined, graph_calls: row.graphCalls,
      raw_llm_text: row.rawLlmText ?? undefined,
    },
  };
}
