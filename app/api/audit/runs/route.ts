// GET /api/audit/runs
//
// 运行日志审计 — 扫 AO 自己的 agent file log (logs/<agent>-<date>.log),按 run_id
// 聚合成"一次运行 = 一行审计记录",返回完整列表 + 每条 run 的摘要。
//
// 这是审计页"运行完整日志"tab 的数据源。比 Inngest trace 全(不漏 step)、比
// AgentStepEvidence 全(三个 RAAS agent 没接入证据表)。drill-in 完整 log 走
// /api/inngest-admin/runs/[runId]/agent-log。
//
// Query params(全可选):
//   agent        — 按 agent 名过滤 (interviewInviter / resumeParser / ruleCheck …)
//   candidate_id — 按候选人过滤(匹配 anchors.candidate_id)
//   run_id       — 精确 run_id
//   days         — 扫最近 N 天 log 文件,默认 3
//   limit        — 返回条数上限,默认 200

import { NextResponse } from 'next/server';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

const LOG_DIR = process.env.AO_LOG_DIR?.trim() || join(process.cwd(), 'logs');

export type RunAuditSummary = {
  run_id: string;
  agent: string;
  trace_id: string | null;
  started_at: string;       // 该 run 第一条 log 的 ts
  ended_at: string;         // 该 run 最后一条 log 的 ts
  event_count: number;      // 这次 run 总 log 事件数
  kinds: string[];          // 出现过的 kind(去重)
  anchors: Record<string, string>;  // candidate_id / job_requisition_id / upload_id 等
  /** 是否含失败/错误事件(handler error / emit failed / save-candidate.failed). */
  has_error: boolean;
  /** 触发事件名(从 handler.start / raw_input 取). */
  event_name: string | null;
};

type RawLogLine = {
  ts: string;
  agent: string;
  run_id: string;
  trace_id: string | null;
  anchors?: Record<string, unknown>;
  kind: string;
  payload?: Record<string, unknown>;
};

export type RunAuditResponse = {
  rows: RunAuditSummary[];
  total: number;
  scanned_files: number;
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filterAgent = url.searchParams.get('agent')?.trim() || null;
  const filterCandidate = url.searchParams.get('candidate_id')?.trim() || null;
  const filterRunId = url.searchParams.get('run_id')?.trim() || null;
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days') ?? 3)));
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') ?? 200)));

  try {
    if (!existsSync(LOG_DIR)) {
      return NextResponse.json({ rows: [], total: 0, scanned_files: 0 } satisfies RunAuditResponse);
    }

    const stamps = recentDayStamps(days);
    const allFiles = await readdir(LOG_DIR);
    // 只扫 agent log(<agent>-YYYY-MM-DD.log),跳过 robohire-/allmeta-/partner-pg-
    // 这些外部调用 sink(它们没 run_id,聚合不出 run).
    const sinkPrefixes = ['robohire-', 'allmeta-', 'partner-pg-'];
    const logFiles = allFiles.filter(
      (f) =>
        f.endsWith('.log') &&
        stamps.some((d) => f.includes(d)) &&
        !sinkPrefixes.some((p) => f.startsWith(p)),
    );

    // run_id → 聚合
    const runs = new Map<string, RunAuditSummary>();

    for (const file of logFiles) {
      let content: string;
      try {
        content = await readFile(join(LOG_DIR, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        if (!line.startsWith('{') || !line.includes('"run_id"')) continue;
        let e: RawLogLine;
        try {
          e = JSON.parse(line) as RawLogLine;
        } catch {
          continue;
        }
        if (!e.run_id) continue;
        if (filterRunId && e.run_id !== filterRunId) continue;
        if (filterAgent && e.agent !== filterAgent) continue;

        let r = runs.get(e.run_id);
        if (!r) {
          r = {
            run_id: e.run_id,
            agent: e.agent,
            trace_id: e.trace_id ?? null,
            started_at: e.ts,
            ended_at: e.ts,
            event_count: 0,
            kinds: [],
            anchors: {},
            has_error: false,
            event_name: null,
          };
          runs.set(e.run_id, r);
        }
        r.event_count += 1;
        if (e.ts < r.started_at) r.started_at = e.ts;
        if (e.ts > r.ended_at) r.ended_at = e.ts;
        if (!r.kinds.includes(e.kind)) r.kinds.push(e.kind);
        // anchors 合并(后到的非空覆盖)
        if (e.anchors && typeof e.anchors === 'object') {
          for (const [k, v] of Object.entries(e.anchors)) {
            if (typeof v === 'string' && v) r.anchors[k] = v;
          }
        }
        // event_name 从 payload.event_name 取
        if (!r.event_name && e.payload && typeof e.payload.event_name === 'string') {
          r.event_name = e.payload.event_name;
        }
        // 错误信号
        if (
          e.kind.includes('error') ||
          e.kind.includes('failed') ||
          (e.kind.startsWith('emit') && e.kind.includes('failed'))
        ) {
          r.has_error = true;
        }
      }
    }

    let rows = Array.from(runs.values());

    // candidate_id 过滤(在 anchors 里)
    if (filterCandidate) {
      rows = rows.filter((r) => r.anchors.candidate_id === filterCandidate);
    }

    // 最近的 run 排前面
    rows.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));

    const total = rows.length;
    rows = rows.slice(0, limit);

    return NextResponse.json({
      rows,
      total,
      scanned_files: logFiles.length,
    } satisfies RunAuditResponse);
  } catch (e) {
    return NextResponse.json(
      { error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}

function recentDayStamps(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}
