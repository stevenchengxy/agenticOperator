import { NextResponse } from 'next/server';
import { AGENT_MAP } from '@/lib/agent-mapping';
import { displayKey } from '@/server/normalize/agents';
import { wsClient } from '@/server/clients/ws';
import { fetchLiveRegistry } from '@/lib/inngest-registry';
import { prisma } from '@/server/db';
import { ONTOLOGY_GEN_SOURCE, rowToDraftRow, type ShellVersionRow } from '@/lib/ontology-generator/draft-store';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
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
      domain: a.domain,
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

  // Ontology-generated agents (e.g. the energy pack) are registered as real
  // functions in the MAIN app, so they show up in the live registry — but they
  // belong to their own business domain and are surfaced below from
  // AgentVersion (with the right domain + shell management). Collect their slugs
  // so we DON'T also add them here under the default (recruitment) domain, which
  // would both mis-scope them and double-count them.
  let ontologyShellSlugs = new Set<string>();
  try {
    const shellSlugs = await prisma.agentVersion.findMany({
      where: { capturedFrom: ONTOLOGY_GEN_SOURCE, slug: { not: '' } },
      select: { slug: true },
    });
    ontologyShellSlugs = new Set(shellSlugs.map((s) => s.slug));
  } catch {
    /* best-effort — if this read fails, fall back to prior behavior */
  }

  // Surface live Inngest functions not in AGENT_MAP — lets a brand-new
  // agent appear in Fleet without an AGENT_MAP edit. Falls back to 'system'
  // stage and '—' owner team so the row still renders.
  const knownShorts = new Set(AGENT_MAP.map((a) => a.short));
  for (const r of registry) {
    if (knownShorts.has(r.short)) continue;
    // Skip ontology agents — they're surfaced from AgentVersion under their own
    // domain (and managed as shells), not here under the recruitment default.
    // The registry exposes the ontology function id as `short`/`fnId` (= the
    // AgentVersion.slug, e.g. "energy-forecast-output"), so match all of them.
    const candidateSlugs = [r.slug, r.short, (r as { fnId?: string }).fnId].filter(Boolean) as string[];
    if (candidateSlugs.some((s) => ontologyShellSlugs.has(s))) continue;
    agents.push({
      short: r.short,
      wsId: r.fnId ?? r.short,
      // Unknown-to-AGENT_MAP live functions: default to the recruitment domain
      // (AO's primary domain). R7 agents must be added to AGENT_MAP_R7.
      domain: RECRUITMENT_DOMAIN_ID,
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

  // Surface DEPLOYED ontology-generated shell agents (per business domain) so
  // they appear in the Fleet under their domain. Sourced from AgentVersion
  // (deploy state), independent of the main-app Inngest registry. status:
  // 'active' → online, 'offline' → paused.
  try {
    const shells = (await prisma.agentVersion.findMany({
      where: { capturedFrom: ONTOLOGY_GEN_SOURCE, status: { in: ['active', 'offline'] }, domain: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, short: true, slug: true, domain: true, versionLabel: true, status: true, configJson: true, createdAt: true },
    })) as ShellVersionRow[];
    // Dedupe by (domain, slug) — a domain may have re-deployed the same agent.
    const seen = new Set<string>();
    for (const s of shells) {
      const key = `${s.domain}::${s.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const card = rowToDraftRow(s);
      agents.push({
        short: card.short,
        wsId: card.slug,
        domain: card.domain,
        displayName: card.nameZh,
        inngestName: card.nameZh,
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
        realness: 'shell',
        slug: card.slug,
        paused: card.status === 'offline',
      });
    }
  } catch {
    // shells are additive — never fail the agents list on a DB hiccup
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
