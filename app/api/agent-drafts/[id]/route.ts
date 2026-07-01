// PATCH  /api/agent-drafts/[id]  — RENAME a factory-generated draft (display name)
// DELETE /api/agent-drafts/[id]  — SOFT delete → recycle bin
//
// DELETE sets status='archived' + archivedAt (NOT a hard delete) so the agent
// can be restored from the recycle bin. Works for ontology-generated shells AND
// for real-agent lifecycle overrides (capturedFrom='real-agent') — never for a
// real production config snapshot. For ontology agents that self-gate on
// AgentVersion.status, an archived row reads as not-active → dormant, so this is
// safe; the registered Inngest function itself is never unregistered.
//
// PATCH renames only the DISPLAY name (configJson.nameZh + specJson.nameZh) of an
// ontology-generated shell — the slug / Inngest fn id never changes, so a rename
// can't break a deployed function. Real production agents carry their name in
// code (AGENT_MAP), not in a row, so they are not renamable here.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import {
  MANAGED_SOURCES,
  ONTOLOGY_GEN_SOURCE,
  REAL_AGENT_SOURCE,
  parseRealAgentId,
  realOverrideLabel,
  rowToDraftRow,
  type ShellVersionRow,
} from "@/lib/ontology-generator/draft-store";
import { AGENT_MAP } from "@/lib/agent-mapping";
import { resyncDomainApp } from "@/server/inngest/domain-app";

export const dynamic = "force-dynamic";

const MAX_NAME_LEN = 40;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let nameZh: unknown;
  try {
    ({ nameZh } = (await req.json()) as { nameZh?: unknown });
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_BODY" }, { status: 400 });
  }
  const name = typeof nameZh === "string" ? nameZh.trim() : "";
  if (!name) return NextResponse.json({ ok: false, error: "EMPTY_NAME" }, { status: 400 });
  if (name.length > MAX_NAME_LEN) return NextResponse.json({ ok: false, error: "NAME_TOO_LONG" }, { status: 400 });

  // Real production agent → store the new display name on its lifecycle override
  // row (configJson.nameZh). The agent's code/registration is untouched; only its
  // managed display name changes. /api/agents prefers this override name.
  const real = parseRealAgentId(id);
  if (real) {
    const meta = AGENT_MAP.find((a) => a.short === real.short && a.domain === real.domain);
    const label = realOverrideLabel(real.domain);
    const prior = await prisma.agentVersion.findUnique({
      where: { short_versionLabel: { short: real.short, versionLabel: label } },
      select: { configJson: true },
    });
    let cfg: Record<string, unknown> = {};
    if (prior?.configJson) { try { cfg = JSON.parse(prior.configJson) as Record<string, unknown>; } catch { cfg = {}; } }
    cfg.nameZh = name;
    const row = (await prisma.agentVersion.upsert({
      where: { short_versionLabel: { short: real.short, versionLabel: label } },
      create: {
        short: real.short,
        slug: meta?.inngestName ?? real.short,
        versionLabel: label,
        domain: real.domain,
        status: "active", // neutral: no lifecycle change, just a name override
        capturedFrom: REAL_AGENT_SOURCE,
        generatedBy: "fleet-manage",
        configJson: JSON.stringify({ nameZh: name }),
        notes: `real-agent display-name override (${real.short})`,
      },
      update: { configJson: JSON.stringify(cfg) }, // preserve lifecycle status
      select: { id: true, short: true, slug: true, domain: true, versionLabel: true, status: true, configJson: true, createdAt: true },
    })) as ShellVersionRow;
    return NextResponse.json({ ok: true, row: rowToDraftRow(row) });
  }

  const existing = await prisma.agentVersion.findUnique({
    where: { id },
    select: { id: true, capturedFrom: true, configJson: true, specJson: true },
  });
  if (!existing) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  // Only factory-generated shells are renamable (display-name lives in configJson).
  if (existing.capturedFrom !== ONTOLOGY_GEN_SOURCE) {
    return NextResponse.json({ ok: false, error: "NOT_RENAMABLE" }, { status: 403 });
  }

  // Patch the display name in configJson (drives the card) + specJson (so a later
  // deploy/run carries the renamed agent). Both are best-effort JSON merges.
  const patchField = (json: string | null, key: "nameZh"): string | null => {
    if (!json) return json;
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      obj[key] = name;
      return JSON.stringify(obj);
    } catch {
      return json;
    }
  };

  const row = (await prisma.agentVersion.update({
    where: { id },
    data: {
      configJson: patchField(existing.configJson, "nameZh"),
      specJson: patchField(existing.specJson, "nameZh"),
    },
    select: { id: true, short: true, slug: true, domain: true, versionLabel: true, status: true, configJson: true, createdAt: true },
  })) as ShellVersionRow;

  return NextResponse.json({ ok: true, row: rowToDraftRow(row) });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Real agent → upsert its lifecycle override as archived (recycle bin).
  const real = parseRealAgentId(id);
  if (real) {
    const meta = AGENT_MAP.find((a) => a.short === real.short && a.domain === real.domain);
    const created = await prisma.agentVersion.upsert({
      where: { short_versionLabel: { short: real.short, versionLabel: realOverrideLabel(real.domain) } },
      create: {
        short: real.short,
        slug: meta?.inngestName ?? real.short,
        versionLabel: realOverrideLabel(real.domain),
        domain: real.domain,
        status: "archived",
        capturedFrom: REAL_AGENT_SOURCE,
        generatedBy: "fleet-manage",
        archivedAt: new Date(),
        notes: `real-agent lifecycle override (${real.short})`,
      },
      update: { status: "archived", archivedAt: new Date() },
      select: { id: true, domain: true },
    });
    if (created.domain) await resyncDomainApp(created.domain).catch(() => {});
    return NextResponse.json({ ok: true, id: created.id, status: "archived" });
  }

  const existing = await prisma.agentVersion.findUnique({
    where: { id },
    select: { id: true, capturedFrom: true, status: true, domain: true },
  });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }
  // Only manageable agents (ontology shells + real-agent overrides) — never a
  // real production config snapshot.
  if (!MANAGED_SOURCES.includes(existing.capturedFrom ?? "")) {
    return NextResponse.json({ ok: false, error: "NOT_MANAGEABLE" }, { status: 403 });
  }

  const row = await prisma.agentVersion.update({
    where: { id },
    data: { status: "archived", archivedAt: new Date() },
    select: { id: true, domain: true },
  });

  // A previously-active shell leaving the live set → re-sync the domain app.
  if (row.domain) {
    await resyncDomainApp(row.domain).catch(() => {});
  }

  return NextResponse.json({ ok: true, id, status: "archived" });
}
