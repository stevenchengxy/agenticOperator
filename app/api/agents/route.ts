import { NextResponse } from 'next/server';
import { AGENT_MAP } from '@/lib/agent-mapping';
import { displayKey } from '@/server/normalize/agents';
import { wsClient } from '@/server/clients/ws';
import { fetchLiveRegistry } from '@/lib/inngest-registry';
import { prisma } from '@/server/db';
import { ONTOLOGY_GEN_SOURCE, REAL_AGENT_SOURCE, realAgentId, rowToDraftRow, type ShellVersionRow } from '@/lib/ontology-generator/draft-store';
import { RECRUITMENT_DOMAIN_ID, ENERGY_DOMAIN_ID } from '@/lib/domain-ids';
import { deriveAgents } from '@/lib/ontology-generator/analyze';
import { loadSnapshotOntology, hasSnapshot } from '@/lib/ontology-generator/ontology-source';
import type { AgentsResponse, AgentRow } from '@/lib/api/types';

// Deterministic ontology-pack function slugs (from the in-repo snapshot, no DB).
// Used to skip ontology functions in the live-registry pass even if the DB read
// fails — so energy agents can never leak into the recruitment domain.
function knownOntologyPackSlugs(): string[] {
  try {
    return hasSnapshot(ENERGY_DOMAIN_ID)
      ? deriveAgents(loadSnapshotOntology(ENERGY_DOMAIN_ID)).map((s) => s.slug)
      : [];
  } catch {
    return [];
  }
}

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

  // Real-agent lifecycle overrides: an 'archived' override soft-deletes a real
  // agent into the recycle bin (hide it from the fleet); 'offline' shows it
  // paused. The override row also carries an operator-set display name
  // (configJson.nameZh) when the agent was renamed. Keyed by short (recruitment
  // shorts are unique).
  const realOverride = new Map<string, { status: string; customName: string | null }>();
  try {
    const ovs = await prisma.agentVersion.findMany({
      where: { capturedFrom: REAL_AGENT_SOURCE },
      orderBy: { createdAt: 'desc' },
      select: { short: true, status: true, configJson: true },
    });
    for (const o of ovs) {
      if (realOverride.has(o.short)) continue;
      let customName: string | null = null;
      if (o.configJson) {
        try {
          const c = JSON.parse(o.configJson) as { nameZh?: unknown };
          if (typeof c.nameZh === 'string' && c.nameZh.trim()) customName = c.nameZh.trim();
        } catch { /* keep null */ }
      }
      realOverride.set(o.short, { status: o.status, customName });
    }
  } catch {
    /* best-effort — no overrides → all real agents live */
  }

  const agents: AgentRow[] = AGENT_MAP
    .filter((a) => realOverride.get(a.short)?.status !== 'archived') // archived → recycle bin, hidden
    .map((a) => {
      const live = regByShort.get(a.short);
      const acts = activityByAgent[a.short] ?? [];
      const ov = realOverride.get(a.short);
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
        paused: ov?.status === 'offline' || ov?.status === 'draft' ? true : (live?.paused ?? false),
        customName: ov?.customName ?? null,
        manageId: realAgentId(a.domain, a.short),
      };
    });

  // Ontology-generated agents (e.g. the energy pack) are registered as real
  // functions in the MAIN app, so they show up in the live registry — but they
  // belong to their own business domain and are surfaced below from
  // AgentVersion. Fetch all ontology shells ONCE and reuse for BOTH the skip-set
  // (so we don't also add them here under the recruitment default) AND the
  // shell-display pass below — one query, one failure mode (never a leak in one
  // pass + a duplicate in the other). The skip-set is seeded with the pack's
  // deterministic snapshot slugs so the registered functions are skipped even if
  // the DB read fails.
  const ontologyShellSlugs = new Set<string>(knownOntologyPackSlugs());
  let allShells: ShellVersionRow[] = [];
  try {
    allShells = (await prisma.agentVersion.findMany({
      where: { capturedFrom: ONTOLOGY_GEN_SOURCE },
      orderBy: { createdAt: 'desc' },
      select: { id: true, short: true, slug: true, domain: true, versionLabel: true, status: true, configJson: true, createdAt: true },
    })) as ShellVersionRow[];
    for (const s of allShells) if (s.slug) ontologyShellSlugs.add(s.slug);
  } catch {
    /* best-effort — pack snapshot slugs still cover the registered functions */
  }

  // Surface live Inngest functions not in AGENT_MAP — lets a brand-new
  // agent appear in Fleet without an AGENT_MAP edit. Falls back to 'system'
  // stage and '—' owner team so the row still renders.
  const knownShorts = new Set(AGENT_MAP.map((a) => a.short));
  for (const r of registry) {
    if (knownShorts.has(r.short)) continue;
    // Skip ANY per-domain app function (`agentic-operator-<domainId>-…`, domain ≠
    // main): each business domain runs its own Inngest app (energy / 费控 / …),
    // and those agents are surfaced below from AgentVersion under their OWN
    // domain. Without this they'd leak into the recruitment default here —
    // especially since the monitor now lists all `agentic-operator-*` apps, so
    // the registry exposes domain-app functions whose CJK-prefixed slug (e.g.
    // `agentic-operator-能源调度-v1-energy-…`) never matched the bare ontology
    // slug set below.
    const slugStr = String(r.slug ?? r.short ?? '');
    if (slugStr.startsWith('agentic-operator-') && !slugStr.startsWith('agentic-operator-main-')) continue;
    // Belt-and-suspenders: also skip ontology agents matched by bare slug (covers
    // the legacy case where a pack was registered on the MAIN app, slug
    // `agentic-operator-main-energy-…` → short/fnId = bare `energy-forecast-output`).
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
      customName: null,
      manageId: null, // unmapped live fn — not lifecycle-manageable
    });
  }

  // Surface DEPLOYED ontology-generated shell agents (per business domain) so
  // they appear in the Fleet under their domain. Reuses the single `allShells`
  // read above (deploy state), independent of the main-app Inngest registry.
  // status: 'active' → online, 'offline' → paused.
  try {
    const shells = allShells.filter(
      (s) => (s.status === 'active' || s.status === 'offline') && s.domain,
    );
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
        customName: card.nameZh,
        manageId: card.id, // AgentVersion id — lifecycle/rename/delete target
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
