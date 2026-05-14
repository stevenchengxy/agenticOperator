// lib/manage/types.ts
// Request/response types for the 6 Manage axis write routes.

// ── Common ────────────────────────────────────────────────────────────────

export type ManageReasonBody = {
  reason?: string;
};

export type ManageOkResponse = {
  ok: true;
};

export type ManageErrorResponse = {
  error: string;
  message?: string;
};

// ── Restart ───────────────────────────────────────────────────────────────

export type RestartBody = ManageReasonBody;

export type RestartResponse =
  | { ok: true; restarted: string | null }
  | ManageErrorResponse;

// ── Cancel ────────────────────────────────────────────────────────────────

export type CancelBody = ManageReasonBody;
export type CancelResponse = ManageOkResponse | ManageErrorResponse;

// ── Pause ─────────────────────────────────────────────────────────────────

export type PauseBody = ManageReasonBody;
export type PauseResponse = ManageOkResponse | ManageErrorResponse;

// ── Resume ────────────────────────────────────────────────────────────────

export type ResumeBody = ManageReasonBody;
export type ResumeResponse = ManageOkResponse | ManageErrorResponse;

// ── Replay event ──────────────────────────────────────────────────────────

export type ReplayBody = ManageReasonBody;

export type ReplayResponse =
  | { ok: true; newEventId: string | null }
  | ManageErrorResponse;

// ── Agent config ──────────────────────────────────────────────────────────

export type AgentConfigBody = {
  temperature?: number;
  maxRetries?: number;
  tier?: string;
  maxOutputTokens?: number;
  promptAppend?: string;
  reason?: string;
};

export type AgentConfigResponse =
  | { ok: true; config: unknown }
  | ManageErrorResponse;
