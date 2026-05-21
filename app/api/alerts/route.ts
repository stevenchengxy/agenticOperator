import { NextResponse } from 'next/server';
import { wsClient } from '@/server/clients/ws';
import { emClient } from '@/server/clients/em';
import { prisma } from '@/server/db';
import type { AlertsResponse, Alert, ApiMeta } from '@/lib/api/types';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const categoryFilter = url.searchParams.get('category')?.split(',');
  const affectedFilter = url.searchParams.get('affected');

  const partial: ApiMeta['partial'] = [];
  const alerts: Alert[] = [];

  // SLA breach alerts: timed_out runs from WS sweeper.
  // Skip the round-trip when category filter explicitly excludes 'sla'.
  if (!categoryFilter || categoryFilter.includes('sla')) {
    try {
      const wsRes = await wsClient.fetchRuns({
        status: ['timed_out'],
        limit: 50,
      });
      for (const r of wsRes.runs as any[]) {
        alerts.push({
          id: `sla-${r.id}`,
          category: 'sla',
          severity: 'high',
          title: `Run ${r.id} timed out`,
          affected: r.triggerEvent,
          triggeredAt: r.lastActivityAt ?? r.startedAt,
          acked: false,
          ackedBy: null,
        });
      }
    } catch {
      partial.push('ws');
    }
  }

  // DLQ alerts from EM
  if (!categoryFilter || categoryFilter.includes('dlq')) {
    try {
      const emRes = await emClient.fetchDLQ({ limit: 50 });
      for (const d of emRes.items as any[]) {
        alerts.push({
          id: `dlq-${d.id}`,
          category: 'dlq',
          severity: 'medium',
          title: `${d.eventName} → DLQ`,
          affected: d.eventName,
          triggeredAt: d.createdAt ?? d.created_at ?? new Date().toISOString(),
          acked: false,
          ackedBy: null,
        });
      }
    } catch {
      partial.push('em');
    }
  }

  // EM degraded-mode alerts. EmSystemStatus is updated by server/em/* whenever
  // the library hits an error path (Neo4j unreachable, schema lookup fails,
  // etc.). Surfacing here so /alerts page becomes a single pane for system
  // health regardless of category, per spec v2 §12.3.
  if (!categoryFilter || categoryFilter.includes('infra')) {
    try {
      const status = await prisma.emSystemStatus.findUnique({
        where: { id: 'singleton' },
      });
      if (status) {
        // EM library itself in degraded state.
        if (status.state === 'degraded' || status.state === 'down') {
          alerts.push({
            id: `em-${status.state}`,
            category: 'infra',
            severity: status.state === 'down' ? 'critical' : 'high',
            title: status.state === 'down'
              ? 'Event Manager 不可用'
              : 'Event Manager 降级运行',
            affected: 'event-manager',
            triggeredAt:
              status.degradedSince?.toISOString() ??
              status.lastErrorAt?.toISOString() ??
              new Date().toISOString(),
            acked: false,
            ackedBy: null,
          });
        }
        // Neo4j sync failure surfaces independently — EM may still publish
        // OK while the schema cache is stale.
        if (status.neo4jLastError) {
          alerts.push({
            id: 'em-neo4j-sync',
            category: 'infra',
            severity: 'medium',
            title: `Neo4j 同步失败：${truncate(status.neo4jLastError, 80)}`,
            affected: 'neo4j-sync',
            triggeredAt:
              status.lastErrorAt?.toISOString() ?? new Date().toISOString(),
            acked: false,
            ackedBy: null,
          });
        }
      }
    } catch {
      // EmSystemStatus table missing or unreachable — silently skip rather
      // than blowing up the alerts feed.
    }
  }

  // Behavior axis: Monitor Agent's open BehaviorAlert rows. Each unresolved
  // row is one active alert (the agent dedups by alertKey). Categories map
  // to existing categories where possible; new behavior-only categories
  // fall under 'behavior'.
  if (!categoryFilter || categoryFilter.includes('behavior') || categoryFilter.includes('sla') || categoryFilter.includes('infra')) {
    try {
      const open = await prisma.behaviorAlert.findMany({
        where: { resolvedAt: null },
        orderBy: { lastSeenAt: 'desc' },
        take: 100,
      });
      for (const a of open) {
        let category: Alert['category'] = 'behavior';
        if (a.ruleId.startsWith('queue_backlog') || a.ruleId.startsWith('em_')) category = 'infra';
        else if (a.ruleId.startsWith('run_stalled') || a.ruleId.startsWith('hitl_stale')) category = 'sla';
        const skipForCategoryFilter = categoryFilter && !categoryFilter.includes(category);
        if (skipForCategoryFilter) continue;
        // Decode details: per-rule structured context (stringified JSON)
        let detailsObj: Record<string, unknown> = {};
        try { detailsObj = JSON.parse(a.details); } catch { /* ignore */ }
        const affected = (detailsObj.agentName as string | undefined)
          ?? (detailsObj.runId as string | undefined)
          ?? a.alertKey.split('.').slice(1).join('.')
          ?? a.ruleId;
        alerts.push({
          id: `behavior-${a.id}`,
          category,
          severity: a.severity === 'error' ? 'high' : 'medium',
          title: behaviorAlertTitle(a.ruleId, detailsObj),
          affected,
          triggeredAt: a.firstSeenAt.toISOString(),
          acked: false,
          ackedBy: null,
        });
      }
    } catch {
      partial.push('behavior');
    }
  }

  // Filter by affected (event name / agent / run id) on the synthesized list.
  const filtered = affectedFilter
    ? alerts.filter((a) => a.affected === affectedFilter)
    : alerts;

  const body: AlertsResponse = {
    alerts: filtered,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Human-readable title for a BehaviorAlert based on its ruleId + details. */
function behaviorAlertTitle(ruleId: string, details: Record<string, unknown>): string {
  const agent = (details.agentName as string | undefined) ?? '';
  const rate = typeof details.errorRate === 'number' ? `${Math.round((details.errorRate as number) * 100)}%` : '';
  const attempts = typeof details.attempts === 'number' ? `${details.attempts} 次` : '';
  if (ruleId.startsWith('agent_error_rate.')) {
    return `${agent} 错误率 ${rate}${attempts ? ` (${attempts})` : ''} — 超阈值`;
  }
  if (ruleId.startsWith('agent_error_rate_degraded.')) {
    return `${agent} 错误率上升 ${rate}${attempts ? ` (${attempts})` : ''}`;
  }
  if (ruleId.startsWith('queue_backlog.')) {
    return `Queue 积压 — ${details.count ?? '?'} 条 (15min)`;
  }
  if (ruleId.startsWith('hitl_stale.')) {
    return `HITL 任务等待超 30 分钟`;
  }
  if (ruleId.startsWith('run_stalled.')) {
    return `Run ${details.runId ?? ''} 停滞超 30 分钟`;
  }
  if (ruleId === 'em_degraded') {
    return `Event Manager 异常 — ${details.state ?? '?'}`;
  }
  return `Behavior 告警: ${ruleId}`;
}
