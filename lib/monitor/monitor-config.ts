// Per-domain monitor config resolution — merges a MonitorConfig row over coded
// defaults. Pure; the Postgres read lives in pg-eval-store.ts. Also the home of
// the judge prompt/rubric version constants (drift compares within a version).

import { DEFAULT_THRESHOLDS, type MonitorThresholds } from './monitor-types';

export const JUDGE_PROMPT_VERSION = 'gnd-v1';
export const RUBRIC_VERSION = 'rubric-v1';

const DEFAULT_SAMPLING_PCT = 10;

export interface MonitorConfigRow {
  domain: string;
  samplingPct: number;
  judgeFamily: string | null;
  autonomy: string;
  thresholdsJson: string | null;
  enabledMonitorsJson: string | null;
}

export type Autonomy = 'read_only' | 'notify' | 'act';

export interface ResolvedMonitorConfig {
  domain: string;
  samplingPct: number;
  judgeFamily: string | null;
  autonomy: Autonomy;
  thresholds: MonitorThresholds;
  enabledMonitors: string[] | null; // null = all monitors enabled
}

function safeJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function resolveMonitorConfig(
  row: MonitorConfigRow | null,
  domain: string,
): ResolvedMonitorConfig {
  const overrides = (safeJson(row?.thresholdsJson) as Partial<MonitorThresholds> | null) ?? {};
  const enabled = safeJson(row?.enabledMonitorsJson);
  const autonomyRaw = row?.autonomy ?? 'read_only';
  const autonomy: Autonomy = (['read_only', 'notify', 'act'] as const).includes(
    autonomyRaw as Autonomy,
  )
    ? (autonomyRaw as Autonomy)
    : 'read_only';

  return {
    domain,
    samplingPct: row?.samplingPct ?? DEFAULT_SAMPLING_PCT,
    judgeFamily: row?.judgeFamily ?? null,
    autonomy,
    thresholds: { ...DEFAULT_THRESHOLDS, ...overrides },
    enabledMonitors: Array.isArray(enabled) ? (enabled as string[]) : null,
  };
}
