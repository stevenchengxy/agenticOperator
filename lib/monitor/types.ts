// Types shared between /api/monitor/* routes and components/monitor/*.
// Kept in lib/ (not server/) so client components can import safely.

export type MonitorFilter = {
  sinceMs: number;            // window length in ms; client passes via ?windowMs=
  since: string;              // resolved ISO timestamp (server computes from sinceMs)
  client?: string;
  triggerEvent?: string;
  status?: string;
};

export type NodeStatus = 'healthy' | 'degraded' | 'failing' | 'idle';

export type MonitorNodeAgg = {
  name: string;                                            // node id from workflow-graph-meta
  running: number;
  completedInWindow: number;
  failedInWindow: number;
  hitlPending: number;
  successRate1h: number;                                   // 0..1
  queueDepth: number;
  tokensInWindow: { prompt: number; completion: number; total: number };
  avgDurationMs: number;
  status: NodeStatus;
  pulse: boolean;
};

export type MonitorEdgeAgg = {
  from: string;
  to: string;
  eventName: string;
  countInWindow: number;
  lastEventAt: string | null;
};

export type MonitorKpi = {
  activeRuns: number;
  pendingHitl: number;
  failuresInWindow: number;
  tokensInWindow: number;
  queueDepth: number;
  queueLagP50Ms: number;
  queueLagP95Ms: number;
};

export type MonitorFailureRow = {
  runId: string;
  agent: string;
  eventName: string | null;
  narrative: string;
  severity: 'anomaly' | 'error';
  at: string;
  metadata?: Record<string, unknown>;
};

export type MonitorHitlRow = {
  taskId: string;
  runId: string;
  nodeId: string;
  title: string;
  createdAt: string;
  deadline: string | null;
};

export type MonitorRunRow = {
  id: string;
  triggerEvent: string;
  status: 'running' | 'completed' | 'failed' | 'suspended' | 'paused';
  startedAt: string;
  lastActivityAt: string;
  clientLabel: string | null;
};

export type MonitorOverviewResponse = {
  filter: MonitorFilter;
  kpi: MonitorKpi;
  nodes: MonitorNodeAgg[];
  edges: MonitorEdgeAgg[];
  failures: MonitorFailureRow[];
  hitl: MonitorHitlRow[];
  recentRuns: MonitorRunRow[];
};

export type RunTrailStep = {
  nodeId: string;
  enteredAt: string;
  leftAt: string | null;
  result: 'success' | 'failure' | 'pending' | 'skipped';
  durationMs: number | null;
  stepCount: number;
  tokensUsed: number;
  relatedEpisodeId: string | null;
};

export type MonitorRunDetail = {
  run: {
    id: string;
    triggerEvent: string;
    triggerData: Record<string, unknown>;
    status: 'running' | 'completed' | 'failed' | 'suspended' | 'paused';
    startedAt: string;
    completedAt: string | null;
    lastActivityAt: string;
  };
  trail: RunTrailStep[];
  events: Array<{ name: string; ts: string; source: 'inbound' | 'outbound'; eventInstanceId: string | null }>;
  activity: Array<{ ts: string; agent: string; type: string; narrative: string; metadata?: Record<string, unknown> }>;
  tokensByAgent: Record<string, { prompt: number; completion: number; total: number; model: string | null }>;
  hitl: Array<{ taskId: string; status: string; title: string; createdAt: string; completedAt: string | null }>;
};
