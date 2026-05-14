// Trace collector — 端到端事件时间线收集器。
//
// 用户需求:"能看到端到端的所有 log 信息"。
//
// 设计:每个 scenario 一个 trace_id,每个关键 hop(发事件 / 调 RAAS / 调 LLM /
// 写 Neo4j)都把一条 trace event 放进 buffer。最终 reporter 输出时间线,
// 让用户一眼看清"trace_id=xxx 这次跑经过了什么"。

export type TraceHop =
  | 'event-emit' // AO emit Inngest event
  | 'event-receive' // AO 收到 event (envelope unwrap 后)
  | 'raas-api-call' // AO 调 RAAS API
  | 'raas-api-resp' // RAAS API 返回(mock server 看到的)
  | 'llm-call' // AO 调 LLM gateway
  | 'llm-response' // LLM 返回
  | 'neo4j-write' // AO 写 Neo4j
  | 'rule-fetch' // AO 抓 ontology rules
  | 'verdict' // AO 出 binary 决策
  | 'augment' // AO 注入 augmentation 到 Robohire resume
  | 'note'; // 其他说明性日志

export interface TraceEvent {
  ts: number;
  hop: TraceHop;
  trace_id: string;
  scenario_id?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const __traceBuffer: TraceEvent[] = [];

export function recordTrace(ev: Omit<TraceEvent, 'ts'>): void {
  __traceBuffer.push({ ts: Date.now(), ...ev });
}

export function getTraces(): TraceEvent[] {
  return [...__traceBuffer];
}

export function getTracesByTraceId(trace_id: string): TraceEvent[] {
  return __traceBuffer.filter((e) => e.trace_id === trace_id);
}

export function getTracesByScenario(scenario_id: string): TraceEvent[] {
  return __traceBuffer.filter((e) => e.scenario_id === scenario_id);
}

export function clearTraces(): void {
  __traceBuffer.length = 0;
}

/** Format trace timeline as markdown table. */
export function formatTraceTimeline(events: TraceEvent[]): string {
  if (events.length === 0) return '_(no trace events recorded)_\n';
  const t0 = events[0]!.ts;
  const lines = [
    '| Δt | hop | message |',
    '|---|---|---|',
  ];
  for (const e of events) {
    const dt = `+${e.ts - t0}ms`;
    const msg = (e.message ?? '').replace(/\|/g, '\\|').slice(0, 140);
    lines.push(`| ${dt} | \`${e.hop}\` | ${msg} |`);
  }
  return lines.join('\n');
}
