// lib/behavior/types.ts — shared types for the Behavior axis (Monitor Agent + Manager Agent + UI).

// ── Monitor Agent output ──────────────────────────────────────────────────

export type MonitorAlertData = {
  /** cuid matching BehaviorAlert.id */
  alertId: string;
  /** e.g. 'agent_error_rate.JDGenerator' */
  alertKey: string;
  /** 'warning' | 'error' */
  severity: string;
  /** which heuristic rule fired, e.g. 'agent_error_rate' */
  ruleId: string;
  /** human-readable description of the threshold crossed */
  details: string;
  /** ISO timestamp */
  detectedAt: string;
};

// ── Manager Agent output ──────────────────────────────────────────────────

export type ManagerDecision = {
  action: 'monitor' | 'escalate' | 'throttle' | 'auto_restart';
  reason: string;
};

export type ManagerActionData = MonitorAlertData & {
  decision: ManagerDecision;
};

// ── /api/behavior response ────────────────────────────────────────────────

export type BehaviorAlertRow = {
  id: string;
  alertKey: string;
  severity: string;
  ruleId: string;
  details: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  managerActionTaken: string | null;
  managerActionAt: string | null;
};

export type BehaviorKpi = {
  open: number;
  in24h: number;
  escalated: number;
  autoResolved: number;
};

export type BehaviorApiResponse = {
  kpi: BehaviorKpi;
  openAlerts: BehaviorAlertRow[];
  recentActions: BehaviorAlertRow[];
};
