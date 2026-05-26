// GET /api/inngest-admin/runs/[runId]/agent-log
//
// 读 AO 自己的 agent file log (logs/<agent>-<date>.log),按 run_id 过滤,返回
// 这次 run 的**完整**结构化事件流 —— 每一步的 in/out 全量数据。
//
// 为什么不用 Inngest trace:
//   - Inngest dev V2 trace.childrenSpans 会漏 step(后面的 step.run 不进 trace),
//     且 runTraceSpanOutputByID 只有 output 没有 input.
//   - AgentStepEvidence 证据表当前 RAAS 三个 agent 没接入.
//   - 我们的 file log 是 100% 完整源:每行带 run_id + kind + 完整 payload,
//     不受 Inngest trace 限制。这个 API 直接 surface 它。
//
// 实现:扫 logs/ 目录里所有 *.log 文件(只看最近几天,避免全量扫描),
// grep 出 run_id 匹配的行,parse 成 JSON,按时间排序返回。

import { NextResponse } from 'next/server';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

const LOG_DIR = process.env.AO_LOG_DIR?.trim() || join(process.cwd(), 'logs');

type AgentLogEvent = {
  ts: string;
  agent: string;
  run_id: string;
  trace_id: string | null;
  anchors?: Record<string, unknown>;
  kind: string;
  payload?: unknown;
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ error: 'missing runId' }, { status: 400 });
  }

  try {
    if (!existsSync(LOG_DIR)) {
      return NextResponse.json({ runId, events: [], note: 'log dir 不存在' });
    }

    // 只扫最近 3 天的 agent log 文件(命名 <agent>-YYYY-MM-DD.log).
    // robohire-/allmeta-/partner-pg- 这些外部调用 sink 也一起扫,
    // 它们没有 run_id 字段, 自然 filter 掉 — 但保留方便未来扩展.
    const recentStamps = recentDayStamps(3);
    const allFiles = await readdir(LOG_DIR);
    const logFiles = allFiles.filter(
      (f) => f.endsWith('.log') && recentStamps.some((d) => f.includes(d)),
    );

    const needle = `"run_id":"${runId}"`;
    const events: AgentLogEvent[] = [];

    for (const file of logFiles) {
      let content: string;
      try {
        content = await readFile(join(LOG_DIR, file), 'utf8');
      } catch {
        continue;
      }
      // 行级 grep — 只 parse 含 run_id 的行,省去全量 JSON.parse
      for (const line of content.split('\n')) {
        if (!line.includes(needle)) continue;
        try {
          const e = JSON.parse(line) as AgentLogEvent;
          if (e.run_id === runId) events.push(e);
        } catch {
          /* 跳过坏行 */
        }
      }
    }

    // 按时间排序(同一 run 跨多个 agent log 文件时也能正确合并排序)
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    return NextResponse.json({
      runId,
      agent: events[0]?.agent ?? null,
      count: events.length,
      events,
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}

/** 最近 N 天的 YYYY-MM-DD 字符串(本地 tz),用于挑 log 文件. */
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
