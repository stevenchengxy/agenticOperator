import { NextResponse } from 'next/server';
import { AGENT_MAP } from '@/lib/agent-mapping';
import { displayKey } from '@/server/normalize/agents';
import { wsClient } from '@/server/clients/ws';
import { fetchLiveRegistry } from '@/lib/inngest-registry';
import type { AgentsResponse, AgentRow } from '@/lib/api/types';

export async function GET(_req: Request): Promise<Response> {
  const partial: ('ws' | 'em')[] = [];
  let activityByAgent: Record<string, any[]> = {};

  // P1: cross-cutting per-agent run aggregation requires WS run→step→nodeId joins
  // not exposed by the sidecar API. We surface basic activity counts and leave
  // p50/successRate/cost null until P3 (in-process Prisma joins).
  try {
    await wsClient.fetchRuns({
      limit: 1000,
      status: ['running', 'suspended', 'completed', 'failed'],
    });
  } catch {
    if (!partial.includes('ws')) partial.push('ws');
  }

  try {
    const feed = await wsClient.fetchActivityFeed({ limit: 1000 });
    activityByAgent = groupActivityByAgent(feed.items);
  } catch {
    if (!partial.includes('ws')) partial.push('ws');
  }

  const wsDown = partial.includes('ws');

  // Live Inngest registry — enriches each row with real-time realness/slug.
  // When Inngest is unreachable, registry returns AGENT_MAP entries as unbuilt;
  // we don't fail the request (UI shows pill in red, agents list still renders).
  const registry = await fetchLiveRegistry();
  const regByShort = new Map(registry.map((r) => [r.short, r]));

  const agents: AgentRow[] = AGENT_MAP.map((a) => {
    const live = regByShort.get(a.short);
    const acts = activityByAgent[a.short] ?? [];
    return {
      short: a.short,
      wsId: a.wsId,
      displayName: displayKey(a.short),
      inngestName: live?.inngestName ?? a.inngestName ?? a.short,
      stage: a.stage,
      kind: a.kind,
      ownerTeam: a.ownerTeam,
      version: a.version,
      status: null,
      p50Ms: wsDown ? null : null, // P3 will compute
      runs24h: 0,
      successRate: null,
      costYuan: 0,
      lastActivityAt: wsDown ? null : (acts[0]?.createdAt ?? null),
      spark: Array(16).fill(0),
      realness: live?.realness ?? 'unbuilt',
      slug: live?.slug ?? null,
      paused: live?.paused ?? false,
    };
  });

  // Surface live Inngest functions not in AGENT_MAP — lets a brand-new
  // agent appear in Fleet without an AGENT_MAP edit. Falls back to 'system'
  // stage and '—' owner team so the row still renders.
  const knownShorts = new Set(AGENT_MAP.map((a) => a.short));
  for (const r of registry) {
    if (knownShorts.has(r.short)) continue;
    agents.push({
      short: r.short,
      wsId: r.fnId ?? r.short,
      displayName: r.inngestName ?? r.short,
      inngestName: r.inngestName ?? r.short,
      stage: 'system',
      kind: 'auto',
      ownerTeam: '—',
      version: '—',
      status: null,
      p50Ms: null,
      runs24h: 0,
      successRate: null,
      costYuan: 0,
      lastActivityAt: null,
      spark: Array(16).fill(0),
      realness: r.realness,
      slug: r.slug,
      paused: r.paused,
    });
  }

  const body: AgentsResponse = {
    agents,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}

function groupActivityByAgent(items: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const it of items) {
    const k = (it.agentName as string) ?? 'unknown';
    (out[k] ||= []).push(it);
  }
  return out;
}
