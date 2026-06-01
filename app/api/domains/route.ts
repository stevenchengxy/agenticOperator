// Domain CRUD — Phase 0 (see docs/superpowers/specs/2026-06-01-domain-foundation-design.md).
//
//   GET  /api/domains       — list active domains. Lazily seeds raas + r7 on first call.
//   POST /api/domains       — create a new domain. `id` derived from `name`; 409 on collision.
//
// Detail routes (PATCH / DELETE) live in app/api/domains/[id]/route.ts.

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { AGENT_MAP } from "@/lib/agent-mapping";

export const dynamic = "force-dynamic";

export type DomainRow = {
  id: string;
  name: string;
  color: string;
  is_system: boolean;
  created_at: string;
  archived_at: string | null;
};

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

const SEED_DOMAINS: Array<Omit<DomainRow, "created_at" | "archived_at">> = [
  { id: "raas", name: "业务领域", color: "oklch(0.65 0.18 250)", is_system: true },
  { id: "r7", name: "R7 · ATS", color: "oklch(0.65 0.18 145)", is_system: true },
];

/** Idempotent: ensures raas + r7 exist as system domains. Cheap (two upserts). */
async function ensureSeed() {
  for (const d of SEED_DOMAINS) {
    await prisma.domain.upsert({
      where: { id: d.id },
      create: d,
      update: {}, // never overwrite existing rows on seed re-run
    });
  }
}

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

/** Slug from name: lowercase ASCII letters/digits/hyphens; collapses other chars. */
export function slugifyDomainName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  // CJK and other non-ASCII chars get stripped — caller will hit invalid_name if
  // nothing remains (which is acceptable for Phase 0: ASCII-pinyin only).
  const slug = trimmed
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
    await ensureSeed();
    const rows = await prisma.domain.findMany({
      where: { archived_at: null },
      orderBy: [{ is_system: "desc" }, { created_at: "asc" }],
    });
    return NextResponse.json<DomainListResponse>({
      ok: true,
      domains: rows.map(toRow),
    });
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
    await ensureSeed();
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
