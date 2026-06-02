// Domain CRUD — Phase 0 (see docs/superpowers/specs/2026-06-01-domain-foundation-design.md).
//
//   GET  /api/domains       — list active domains. Lazily seeds raas + r7 on first call.
//   POST /api/domains       — create a new domain. `id` derived from `name`; 409 on collision.
//
// Detail routes (PATCH / DELETE) live in app/api/domains/[id]/route.ts.

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { pinyin } from "pinyin-pro";
import { prisma } from "@/server/db";
import { AGENT_MAP } from "@/lib/agent-mapping";
import { hasSnapshot } from "@/lib/ontology-generator/ontology-source";
import {
  RECRUITMENT_DOMAIN_ID,
  ENERGY_DOMAIN_ID,
  friendlyDomainName,
  colorForDomain,
} from "@/lib/domain-ids";

export const dynamic = "force-dynamic";

export type DomainRow = {
  id: string;
  name: string;
  color: string;
  is_system: boolean;
  created_at: string;
  archived_at: string | null;
  /** True when AO ships a runnable ontology-agent pack (snapshot) for this id. */
  runnable?: boolean;
};

// ── Domains follow the Neo4j / Allmeta domain ids (fully dynamic) ─────────────
//
// The switcher list IS the live Allmeta domain id list (GET <studio>/api/domains)
// — AO never invents domains and never hardcodes the id set. Display name + color
// are DERIVED from the id (friendlyDomainName / colorForDomain), so renaming a
// domain in Allmeta Studio flows through automatically. The local Domain table is
// only a per-id name/color/archived OVERRIDE (so 管理领域 still works). The last
// successful Allmeta read is cached so a transient Studio outage doesn't blank
// the switcher.

const ALLMETA_BASE = process.env.ALLMETA_BASE_URL ?? "";
const ALLMETA_KEY = process.env.ALLMETA_API_KEY ?? "";

type AllmetaDomain = { id: string; name?: string };

// Last good Allmeta read — survives a transient Studio outage. Seeded with the
// ids AO ships packs for so the very first render (Studio still booting) isn't
// empty; replaced by the live list on the first successful fetch.
let lastGoodAllmeta: AllmetaDomain[] = [
  { id: RECRUITMENT_DOMAIN_ID },
  { id: ENERGY_DOMAIN_ID },
];

async function fetchAllmetaDomains(): Promise<AllmetaDomain[]> {
  if (!ALLMETA_BASE) return lastGoodAllmeta;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${ALLMETA_BASE.replace(/\/+$/, "")}/api/domains`, {
      headers: ALLMETA_KEY ? { Authorization: `Bearer ${ALLMETA_KEY}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return lastGoodAllmeta;
    const body = (await res.json()) as { domains?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.domains) ? body.domains : [];
    const mapped = list
      .map((d) => ({ id: String(d.id ?? ""), name: typeof d.name === "string" ? d.name : undefined }))
      .filter((d) => d.id);
    if (mapped.length === 0) return lastGoodAllmeta;
    lastGoodAllmeta = mapped; // cache the live list
    return mapped;
  } catch {
    return lastGoodAllmeta;
  } finally {
    clearTimeout(timer);
  }
}

export type DomainListResponse =
  | { ok: true; domains: DomainRow[] }
  | { ok: false; reason: "error"; error?: string };

export type DomainCreateResponse =
  | { ok: true; domain: DomainRow }
  | { ok: false; reason: "slug_collision"; existing_id: string; existing_name: string }
  | { ok: false; reason: "invalid_name"; error: string }
  | { ok: false; reason: "error"; error?: string };

// 6-color rotation for new domains when caller doesn't pick one. Order tracks
// the spec's palette so newly-created domains visually diverge from raas/r7.
const COLOR_PALETTE = [
  "oklch(0.65 0.18 30)",   // amber
  "oklch(0.65 0.18 320)",  // magenta
  "oklch(0.65 0.18 195)",  // teal
  "oklch(0.55 0.16 285)",  // violet
  "oklch(0.65 0.18 250)",  // blue (= raas)
  "oklch(0.65 0.18 145)",  // green (= r7)
];

function toRow(d: {
  id: string;
  name: string;
  color: string;
  is_system: boolean;
  created_at: Date;
  archived_at: Date | null;
}): DomainRow {
  return {
    id: d.id,
    name: d.name,
    color: d.color,
    is_system: d.is_system,
    created_at: d.created_at.toISOString(),
    archived_at: d.archived_at ? d.archived_at.toISOString() : null,
  };
}

/** Slug from name: lowercase ASCII letters/digits/hyphens; collapses other chars.
 *  CJK is transliterated to pinyin first, so a pure-Chinese display name like
 *  「能源调度」 still yields a usable ASCII id (neng-yuan-diao-du). The Chinese
 *  name is preserved separately in `Domain.name` and is what the UI shows; this
 *  slug is only the internal primary key / URL segment. */
export function slugifyDomainName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  // Non-Chinese chars pass through unchanged (nonZh: consecutive); Chinese chars
  // become space-separated pinyin, which the regex below collapses into hyphens.
  const ascii = pinyin(trimmed, { toneType: "none", nonZh: "consecutive" });
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

async function pickColor(): Promise<string> {
  const count = await prisma.domain.count();
  return COLOR_PALETTE[count % COLOR_PALETTE.length]!;
}

// Data isolation: the switcher list is the UNION of
//   1. domains live in Allmeta/Neo4j now (synced in — additive),
//   2. domains that already hold agent data (AgentVersion rows),
//   3. the packs AO ships (recruitment + energy).
// Consequence: when Allmeta REMOVES a domain id, AO KEEPS it iff it has agent
// data (so agents are never orphaned); a removed domain with no data simply
// drops off (nothing to lose). AO never writes to / deletes from the Domain
// table here — that table is used ONLY as an optional per-id name/color/archived
// OVERRIDE (so 管理领域 renames survive). Nothing auto-deletes a business domain.
export async function GET() {
  try {
    const allmeta = await fetchAllmetaDomains();

    // Domains that already hold agent data must never disappear from the list.
    const agentDomains = await prisma.agentVersion
      .findMany({
        where: { domain: { not: null } },
        distinct: ["domain"],
        select: { domain: true },
      })
      .then((rows) => rows.map((r) => r.domain!).filter(Boolean))
      .catch(() => [] as string[]);

    // Optional name/color/archived overrides (never auto-written here).
    const overrides = await prisma.domain
      .findMany()
      .catch(
        () =>
          [] as Array<{
            id: string;
            name: string;
            color: string;
            is_system: boolean;
            created_at: Date;
            archived_at: Date | null;
          }>,
      );
    const ovById = new Map(overrides.map((o) => [o.id, o]));

    // Union of live Allmeta + agent-bearing + the shipped packs.
    const orderedIds: string[] = [];
    const pushUnique = (id: string) => {
      if (id && !orderedIds.includes(id)) orderedIds.push(id);
    };
    allmeta.forEach((d) => pushUnique(d.id));
    agentDomains.forEach(pushUnique);
    pushUnique(RECRUITMENT_DOMAIN_ID);
    pushUnique(ENERGY_DOMAIN_ID);

    const orderOf = (id: string) => (id === RECRUITMENT_DOMAIN_ID ? -1 : 0);
    const allmetaName = new Map(allmeta.map((d) => [d.id, d.name]));

    const domains: DomainRow[] = orderedIds
      .map((id, i) => {
        const ov = ovById.get(id);
        return {
          row: {
            id,
            name: ov?.name ?? (friendlyDomainName(id) || allmetaName.get(id) || id),
            color: ov?.color ?? colorForDomain(id),
            is_system: true, // synced/owned → not casually deletable from AO
            created_at: (ov?.created_at ?? new Date(0)).toISOString(),
            archived_at: ov?.archived_at ? ov.archived_at.toISOString() : null,
            runnable: hasSnapshot(id),
          } satisfies DomainRow,
          order: orderOf(id) * 1000 + i,
          archived: !!ov?.archived_at,
        };
      })
      .filter((x) => !x.archived)
      .sort((a, b) => a.order - b.order)
      .map((x) => x.row);

    return NextResponse.json<DomainListResponse>({ ok: true, domains });
  } catch (e) {
    return NextResponse.json<DomainListResponse>({
      ok: false,
      reason: "error",
      error: (e as Error).message.slice(0, 300),
    });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      color?: unknown;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json<DomainCreateResponse>({
        ok: false,
        reason: "invalid_name",
        error: "name is required",
      });
    }
    const id = slugifyDomainName(name);
    if (!id) {
      return NextResponse.json<DomainCreateResponse>({
        ok: false,
        reason: "invalid_name",
        error: "name produced an empty slug (use ASCII letters/digits)",
      });
    }
    // Slug collision — surface existing row so UI can prompt rename.
    const existing = await prisma.domain.findUnique({ where: { id } });
    if (existing) {
      // If archived, refuse rather than silently un-archiving — that's a separate
      // explicit action the user should take from 管理领域 modal.
      return NextResponse.json<DomainCreateResponse>({
        ok: false,
        reason: "slug_collision",
        existing_id: existing.id,
        existing_name: existing.name,
      });
    }
    const color =
      typeof body.color === "string" && body.color.trim()
        ? body.color.trim()
        : await pickColor();
    const created = await prisma.domain.create({
      data: { id, name, color, is_system: false },
    });
    return NextResponse.json<DomainCreateResponse>({
      ok: true,
      domain: toRow(created),
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Defense in depth — should have been caught by the findUnique above.
      return NextResponse.json<DomainCreateResponse>({
        ok: false,
        reason: "slug_collision",
        existing_id: "",
        existing_name: "",
      });
    }
    return NextResponse.json<DomainCreateResponse>({
      ok: false,
      reason: "error",
      error: (e as Error).message.slice(0, 300),
    });
  }
}

/** Exposed for the [id] route's DELETE handler — counts agents in `AGENT_MAP`
 *  attached to the given domain. Lifted here so the test suite can stub one
 *  thing instead of two. */
export function countAgentsInDomain(domainId: string): number {
  return AGENT_MAP.filter((a) => a.domain === domainId).length;
}
