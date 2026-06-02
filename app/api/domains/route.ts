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

// ── Domains follow the Neo4j / Allmeta domain ids ────────────────────────────
//
// The business-domain switcher is NOT hand-seeded anymore: its canonical list
// IS the Allmeta domain id list (GET <studio>/api/domains). AO maps each id to a
// friendly name + accent color (KNOWN_DOMAIN_META), and the local Domain table
// is used ONLY as a name/color/archived OVERRIDE for those ids (so 管理领域 still
// works). Switching the domain therefore selects a real Neo4j domain id, and the
// ontology generator + generated agents all scope by that same id.

const ALLMETA_BASE = process.env.ALLMETA_BASE_URL ?? "";
const ALLMETA_KEY = process.env.ALLMETA_API_KEY ?? "";

type KnownMeta = { name: string; color: string; is_system?: boolean; order: number };
const KNOWN_DOMAIN_META: Record<string, KnownMeta> = {
  "RAAS-v1": { name: "招聘", color: "oklch(0.65 0.18 250)", is_system: true, order: 0 },
  "R7-001": { name: "R7 · ATS", color: "oklch(0.65 0.18 145)", is_system: true, order: 1 },
  "baoxiao-v1": { name: "采购报销", color: "oklch(0.64 0.15 70)", order: 2 },
  "nengyuandiaodu-v1": { name: "能源调度", color: "oklch(0.62 0.14 200)", order: 3 },
};

/** Fallback domain ids when Allmeta Studio is unreachable — the four known ids. */
const FALLBACK_ALLMETA: Array<{ id: string; name?: string }> = [
  { id: "RAAS-v1" },
  { id: "R7-001" },
  { id: "baoxiao-v1" },
  { id: "nengyuandiaodu-v1" },
];

async function fetchAllmetaDomains(): Promise<Array<{ id: string; name?: string }>> {
  if (!ALLMETA_BASE) return FALLBACK_ALLMETA;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${ALLMETA_BASE.replace(/\/+$/, "")}/api/domains`, {
      headers: ALLMETA_KEY ? { Authorization: `Bearer ${ALLMETA_KEY}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return FALLBACK_ALLMETA;
    const body = (await res.json()) as { domains?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.domains) ? body.domains : [];
    if (list.length === 0) return FALLBACK_ALLMETA;
    return list
      .map((d) => ({ id: String(d.id ?? ""), name: typeof d.name === "string" ? d.name : undefined }))
      .filter((d) => d.id);
  } catch {
    return FALLBACK_ALLMETA;
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

export async function GET() {
  try {
    const [allmeta, overrides] = await Promise.all([
      fetchAllmetaDomains(),
      prisma.domain.findMany().catch(() => [] as Array<{
        id: string;
        name: string;
        color: string;
        is_system: boolean;
        created_at: Date;
        archived_at: Date | null;
      }>),
    ]);
    const ovById = new Map(overrides.map((o) => [o.id, o]));

    let fallbackOrder = 100;
    const domains: DomainRow[] = allmeta
      .map((d) => {
        const meta = KNOWN_DOMAIN_META[d.id];
        const ov = ovById.get(d.id);
        const order = meta?.order ?? fallbackOrder++;
        return {
          row: {
            id: d.id,
            name: ov?.name ?? meta?.name ?? d.name ?? d.id,
            color: ov?.color ?? meta?.color ?? COLOR_PALETTE[order % COLOR_PALETTE.length]!,
            is_system: ov?.is_system ?? meta?.is_system ?? false,
            created_at: (ov?.created_at ?? new Date(0)).toISOString(),
            archived_at: ov?.archived_at ? ov.archived_at.toISOString() : null,
            runnable: hasSnapshot(d.id),
          } satisfies DomainRow,
          order,
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
