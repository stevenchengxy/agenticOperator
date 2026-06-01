// Domain detail routes (Phase 0).
//
//   PATCH  /api/domains/[id]   — rename / recolor. System domains can be renamed.
//   DELETE /api/domains/[id]   — soft-archive. 403 system; 422 has_agents.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { countAgentsInDomain, type DomainRow } from "@/app/api/domains/route";

export const dynamic = "force-dynamic";

export type DomainPatchResponse =
  | { ok: true; domain: DomainRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_body"; error: string }
  | { ok: false; reason: "error"; error?: string };

export type DomainDeleteResponse =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "is_system" }
  | { ok: false; reason: "has_agents"; count: number }
  | { ok: false; reason: "error"; error?: string };

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

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      color?: unknown;
    };
    const data: { name?: string; color?: string } = {};
    if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      if (!trimmed) {
        return NextResponse.json<DomainPatchResponse>({
          ok: false,
          reason: "invalid_body",
          error: "name cannot be empty",
        });
      }
      data.name = trimmed;
    }
    if (typeof body.color === "string" && body.color.trim()) {
      data.color = body.color.trim();
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json<DomainPatchResponse>({
        ok: false,
        reason: "invalid_body",
        error: "no patch fields provided (name or color required)",
      });
    }
    const existing = await prisma.domain.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json<DomainPatchResponse>({
        ok: false,
        reason: "not_found",
      });
    }
    const updated = await prisma.domain.update({
      where: { id },
      data,
    });
    return NextResponse.json<DomainPatchResponse>({
      ok: true,
      domain: toRow(updated),
    });
  } catch (e) {
    return NextResponse.json<DomainPatchResponse>({
      ok: false,
      reason: "error",
      error: (e as Error).message.slice(0, 300),
    });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const existing = await prisma.domain.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json<DomainDeleteResponse>({
        ok: false,
        reason: "not_found",
      });
    }
    if (existing.is_system) {
      return NextResponse.json<DomainDeleteResponse>({
        ok: false,
        reason: "is_system",
      });
    }
    const agentCount = countAgentsInDomain(id);
    if (agentCount > 0) {
      return NextResponse.json<DomainDeleteResponse>({
        ok: false,
        reason: "has_agents",
        count: agentCount,
      });
    }
    await prisma.domain.update({
      where: { id },
      data: { archived_at: new Date() },
    });
    return NextResponse.json<DomainDeleteResponse>({ ok: true });
  } catch (e) {
    return NextResponse.json<DomainDeleteResponse>({
      ok: false,
      reason: "error",
      error: (e as Error).message.slice(0, 300),
    });
  }
}
