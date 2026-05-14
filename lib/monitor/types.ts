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
  queueLagP50Ms: number | null;
  queueLagP95Ms: number | null;
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

export type MonitorAgentDetail = {
  name: string;
  title: string;
  config: {
    enabled: boolean;
    temperature: number | null;
    maxRetries: number | null;
    tier: string | null;
    maxOutputTokens: number | null;
    promptAppend: string | null;
  } | null;
  recentEpisodes: Array<{
    id: string;
    runId: string;
    clientId: string | null;
    durationMs: number;
    tokenUsage: { prompt: number; completion: number; total: number };
    modelUsed: string | null;
    judgeScore: number | null;
    createdAt: string;
  }>;
  tokenSpend: Array<{ bucket: string; prompt: number; completion: number; total: number }>;
  errorRate:  Array<{ bucket: string; total: number; failed: number }>;
  recentErrors: Array<{ runId: string; narrative: string; ts: string; metadata?: Record<string, unknown> }>;
};

export type MonitorFailureDetailResponse = {
  run: {
    id: string;
    triggerEvent: string;
    status: 'running' | 'completed' | 'failed' | 'suspended' | 'paused';
    startedAt: string;
    completedAt: string | null;
    lastActivityAt: string;
  };
  steps: Array<{
    id: string;
    runId: string;
    nodeId: string;
    stepName: string;
    status: string;
    error: string | null;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
  }>;
  retries: Array<{
    id: string;
    runId: string | null;
    agentName: string;
    type: string;
    narrative: string;
    metadata: string | null;
    createdAt: string;
  }>;
  events: Array<{
    id: string;
    name: string;
    source: string;
    status: string;
    ts: string;
  }>;
};

export type MonitorQueueEventRow = {
  id: string;
  name: string;
  source: string;
  status: string;
  ts: string;
  payloadDigest?: string;
  rejectionReason?: string;
  schemaErrors?: unknown;
};

export type MonitorQueueDlqRow = {
  id: string;
  eventName: string;
  reason: string;
  retries: number;
  createdAt: string;
  resolvedAt: string | null;
};

export type MonitorQueueResponse = {
  bucket: 'accepted' | 'pending' | 'rejected' | 'dlq';
  total: number;
  offset: number;
  limit: number;
  rows: Array<MonitorQueueEventRow | MonitorQueueDlqRow>;
};

export type InstanceCard = {
  runId: string;
  triggerEvent: string;
  status: 'running' | 'completed' | 'failed' | 'suspended' | 'paused';
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;

  // Entity refs parsed from triggerData JSON
  client: string | null;
  jdTitle: string | null;
  jdId: string | null;
  candidateName: string | null;
  candidateId: string | null;
  resumeId: string | null;

  // Progress
  currentAgent: string | null;
  currentStage: string | null;
  agentsTouched: number;

  // Flags
  pendingHitl: boolean;
  hasFailure: boolean;
};

export type MonitorInstancesResponse = {
  scope: 'live' | 'recent';
  total: number;
  items: InstanceCard[];
};

// ── System Status ──────────────────────────────────────────────────

export type SubsystemHealth = {
  id: 'em' | 'raas' | 'neo4j' | 'inngest';
  label: string;
  state: 'healthy' | 'degraded' | 'down' | 'unknown';
  lastUpdate: string | null;
  metrics: Array<{ label: string; value: string }>;
  detail: string | null;
};

export type MonitorSystemStatusResponse = {
  subsystems: SubsystemHealth[];
  fetchedAt: string;
};
