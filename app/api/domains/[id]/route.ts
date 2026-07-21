// Domain detail routes (Phase 0).
//
//   PATCH  /api/domains/[id]   — rename / recolor. System domains can be renamed.
//   DELETE /api/domains/[id]   — soft-archive. 403 system; 422 has_agents.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { countAgentsInDomain, type DomainRow } from "@/app/api/domains/route";
import { friendlyDomainName, colorForDomain } from "@/lib/domain-ids";

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
    // Upsert, not update: domains synced from Allmeta/Neo4j have no Domain row
    // (the switcher lists them from the live union, not the table). Renaming one
    // must CREATE its override row — otherwise rename fails with "not_found".
    const updated = await prisma.domain.upsert({
      where: { id },
      create: {
        id,
        name: data.name ?? (friendlyDomainName(id) || id),
        color: data.color ?? colorForDomain(id),
        is_system: true, // a synced/known domain being customized — keep protected
      },
      update: data,
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
    // Block archive while the domain still holds agents — both real (AGENT_MAP)
    // and ontology-generated shells (AgentVersion). Data isolation: a domain is
    // only removable once its agents are gone, so archiving never orphans data.
    const shellCount = await prisma.agentVersion
      .count({ where: { domain: id } })
      .catch(() => 0);
    const agentCount = countAgentsInDomain(id) + shellCount;
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
