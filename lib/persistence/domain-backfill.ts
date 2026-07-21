// Materialized domain attribution for durable event/run tables.
//
// Older installations predate the `domain` columns. Numbered pagination must
// filter before `count`/`skip`, so deriving the domain after a page is loaded
// would produce empty pages and incorrect totals. These idempotent helpers
// lazily backfill legacy null rows before a domain-scoped read. New writers set
// the column directly, making this a one-time upgrade path in normal use.

import { prisma } from "../../server/db";
import { inferEventDomain, inferRunDomain } from "../events/domain-scope";

const BATCH_SIZE = 500;

let archiveEventsBackfill: Promise<void> | null = null;
let archiveRunsBackfill: Promise<void> | null = null;
let eventInstancesBackfill: Promise<void> | null = null;

function parseMaybeJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function updateGroups(
  groups: Map<string, string[]>,
  update: (domain: string, ids: string[]) => Promise<unknown>,
): Promise<void> {
  await Promise.all([...groups].map(([domain, ids]) => update(domain, ids)));
}

export function ensureArchivedEventDomains(): Promise<void> {
  if (!archiveEventsBackfill) {
    archiveEventsBackfill = (async () => {
      for (;;) {
        const rows = await prisma.inngestEventArchive.findMany({
          where: { OR: [{ domain: null }, { occurredAt: null }] },
          orderBy: [{ archivedAt: "asc" }, { id: "asc" }],
          take: BATCH_SIZE,
          select: {
            id: true,
            name: true,
            data: true,
            sourceApp: true,
            ts: true,
            receivedAt: true,
            occurredAt: true,
            archivedAt: true,
          },
        });
        if (rows.length === 0) {
          archiveEventsBackfill = null;
          return;
        }
        const groups = new Map<string, { domain: string; occurredAt: Date; ids: string[] }>();
        for (const row of rows) {
          const domain = inferEventDomain({
            name: row.name,
            data: parseMaybeJson(row.data),
            sourceApp: row.sourceApp,
          });
          const occurredAt = row.occurredAt ?? row.receivedAt ?? row.ts ?? row.archivedAt;
          const key = `${domain}\u0000${occurredAt.toISOString()}`;
          const group = groups.get(key) ?? { domain, occurredAt, ids: [] };
          group.ids.push(row.id);
          groups.set(key, group);
        }
        await Promise.all(
          [...groups.values()].map((group) =>
            prisma.inngestEventArchive.updateMany({
              where: { id: { in: group.ids } },
              data: { domain: group.domain, occurredAt: group.occurredAt },
            }),
          ),
        );
      }
    })().catch((error) => {
      archiveEventsBackfill = null;
      throw error;
    });
  }
  return archiveEventsBackfill;
}

export function ensureArchivedRunDomains(): Promise<void> {
  if (!archiveRunsBackfill) {
    archiveRunsBackfill = (async () => {
      const domainApps = await prisma.domainInngestApp.findMany({
        select: { appId: true, domain: true },
      }).catch(() => [] as Array<{ appId: string; domain: string }>);
      for (;;) {
        const rows = await prisma.inngestRunArchive.findMany({
          where: { domain: null },
          orderBy: [{ archivedAt: "asc" }, { runId: "asc" }],
          take: BATCH_SIZE,
          select: {
            runId: true,
            appId: true,
            functionSlug: true,
            eventName: true,
          },
        });
        if (rows.length === 0) {
          archiveRunsBackfill = null;
          return;
        }
        const groups = new Map<string, string[]>();
        for (const row of rows) {
          const domain = inferRunDomain({ ...row, domainApps });
          groups.set(domain, [...(groups.get(domain) ?? []), row.runId]);
        }
        await updateGroups(groups, (domain, ids) =>
          prisma.inngestRunArchive.updateMany({
            where: { runId: { in: ids }, domain: null },
            data: { domain },
          }),
        );
      }
    })().catch((error) => {
      archiveRunsBackfill = null;
      throw error;
    });
  }
  return archiveRunsBackfill;
}

export function ensureEventInstanceDomains(): Promise<void> {
  if (!eventInstancesBackfill) {
    eventInstancesBackfill = (async () => {
      for (;;) {
        const rows = await prisma.eventInstance.findMany({
          where: { domain: null },
          orderBy: [{ ts: "asc" }, { id: "asc" }],
          take: BATCH_SIZE,
          select: { id: true, name: true, payloadSummary: true },
        });
        if (rows.length === 0) {
          eventInstancesBackfill = null;
          return;
        }
        const groups = new Map<string, string[]>();
        for (const row of rows) {
          const domain = inferEventDomain({
            name: row.name,
            data: parseMaybeJson(row.payloadSummary),
          });
          groups.set(domain, [...(groups.get(domain) ?? []), row.id]);
        }
        await updateGroups(groups, (domain, ids) =>
          prisma.eventInstance.updateMany({
            where: { id: { in: ids }, domain: null },
            data: { domain },
          }),
        );
      }
    })().catch((error) => {
      eventInstancesBackfill = null;
      throw error;
    });
  }
  return eventInstancesBackfill;
}
