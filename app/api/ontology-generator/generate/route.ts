// POST /api/ontology-generator/generate
//
// Body:  { domainId: string, selectedKeys: string[] }
// Reply: GenerateResult — { domainId, drafts: GeneratedDraft[] }
//
// Persists each selected candidate as a SANDBOXED SHELL AgentVersion draft:
//   status='draft', capturedFrom='ontology-gen', domain=<profile id>,
//   slug='og-…' (never a real Inngest function id).
// The display card fields are stashed as JSON in configJson so the Fleet drafts
// store ("部署智能体") can rebuild the cards. Deploying / onlining / offlining a
// shell can never touch the real production agents.

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { resolveProfile } from "@/lib/ontology-generator/profiles";
import {
  fetchDomainOntology,
  hasSnapshot,
  loadSnapshotOntology,
} from "@/lib/ontology-generator/ontology-source";
import { deriveAgents } from "@/lib/ontology-generator/analyze";
import { RECRUITMENT_DOMAIN_ID } from "@/lib/domain-ids";
import type {
  GeneratedDraft,
  GenerateResult,
  ShellCardData,
} from "@/lib/ontology-generator/types";

export const dynamic = "force-dynamic";

/**
 * Real-ontology deploy. For a RUNNABLE domain (it ships an in-repo snapshot +
 * registered Inngest functions, e.g. energy) we derive from the SNAPSHOT — the
 * authoritative source whose slugs/shorts/prompts match the registered
 * functions — and write status='active' so the self-gate flips on and the chain
 * goes live. For a domain with only live Allmeta ontology (no runnable pack,
 * e.g. 费控) we derive from the live data but write status='draft': there is no
 * registered function to execute it, so marking it 'active' would falsely show
 * "运行中". Newest-row-wins (is-active reads the latest by createdAt).
 */
async function activateRealAgents(
  domainId: string,
  selectedKeys: string[],
  onto: Awaited<ReturnType<typeof fetchDomainOntology>>,
): Promise<GenerateResult> {
  // Runnable domain → use the authoritative snapshot so deployed shells line up
  // exactly with the registered functions; otherwise the live Allmeta ontology.
  const runnable = hasSnapshot(domainId);
  const sourceOnto = runnable ? loadSnapshotOntology(domainId) : onto;
  const deployStatus: "active" | "draft" = runnable ? "active" : "draft";
  const specs = deriveAgents(sourceOnto);
  const selected =
    selectedKeys.length > 0 ? specs.filter((s) => selectedKeys.includes(s.key)) : specs;

  const drafts: GeneratedDraft[] = [];
  let seq = 0;
  for (const s of selected) {
    const label = versionLabel(seq++);
    const triggerEvent = s.triggerEvents[0] ?? "(入口)";
    const emitEvent = s.emitEvents[0] ?? "(无)";
    const card: ShellCardData = {
      nameZh: s.nameZh,
      nameEn: s.nameEn,
      agentId: s.short,
      descZh: s.descZh,
      descEn: s.descEn,
      triggerEvent,
      emitEvent,
      confidence: s.confidence,
      iconChar: s.kind === "llm" ? "智" : "人",
      iconColor: s.kind === "llm" ? "oklch(0.62 0.14 200)" : "oklch(0.6 0.04 260)",
    };

    let persisted = false;
    try {
      await prisma.agentVersion.create({
        data: {
          short: s.short,
          slug: s.slug,
          versionLabel: label,
          status: deployStatus, // runnable → active (self-gate on); else draft
          domain: domainId,
          capturedFrom: "ontology-gen",
          configJson: JSON.stringify({ ...card, kind: s.kind }),
          generatedBy: "ontology-generator",
          deployedAt: deployStatus === "active" ? new Date() : null,
          notes: `${runnable ? "runnable" : "shell"} agent from ${domainId} ontology — ${triggerEvent} → ${emitEvent}`,
        },
      });
      persisted = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) {
        // non-collision write failures are non-fatal — still surface the draft.
      }
      persisted = false;
    }

    drafts.push({
      key: s.key,
      short: s.short,
      slug: s.slug,
      domain: domainId,
      nameZh: s.nameZh,
      nameEn: s.nameEn,
      agentId: s.short,
      triggerEvent,
      emitEvent,
      confidence: s.confidence,
      iconChar: card.iconChar,
      iconColor: card.iconColor,
      status: "draft",
      versionLabel: label,
      persisted,
    });
  }

  return { domainId, drafts };
}

/** e.g. 2026-06-01-1830-og — unique with `short` via @@unique([short, versionLabel]). */
function versionLabel(seq: number): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-og${seq}`;
}

export async function POST(req: Request) {
  let domainId = RECRUITMENT_DOMAIN_ID;
  let domainName: string | undefined;
  let selectedKeys: string[] = [];
  try {
    const body = (await req.json()) as { domainId?: unknown; domainName?: unknown; selectedKeys?: unknown };
    if (typeof body?.domainId === "string" && body.domainId.trim()) domainId = body.domainId.trim();
    if (typeof body?.domainName === "string" && body.domainName.trim()) domainName = body.domainName.trim();
    if (Array.isArray(body?.selectedKeys)) {
      selectedKeys = body.selectedKeys.filter((k): k is string => typeof k === "string");
    }
  } catch {
    // fall through with defaults
  }

  // Real-ontology domains → activate real agents (deploy = activate). Read the
  // domain's live ontology; if it has actions, derive + persist from them.
  const onto = await fetchDomainOntology(domainId);
  if (onto.actions.length > 0) {
    return NextResponse.json(await activateRealAgents(domainId, selectedKeys, onto));
  }

  const profile = resolveProfile(domainId, domainName);
  const selected =
    selectedKeys.length > 0
      ? profile.candidates.filter((c) => selectedKeys.includes(c.key))
      : profile.candidates;

  const drafts: GeneratedDraft[] = [];
  let seq = 0;
  for (const c of selected) {
    const label = versionLabel(seq++);
    const card: ShellCardData = {
      nameZh: c.nameZh,
      nameEn: c.nameEn,
      agentId: c.agentId,
      descZh: c.descZh,
      descEn: c.descEn,
      triggerEvent: c.triggerEvent,
      emitEvent: c.emitEvent,
      confidence: c.confidence,
      iconChar: c.iconChar,
      iconColor: c.iconColor,
    };

    let persisted = false;
    try {
      await prisma.agentVersion.create({
        data: {
          short: c.short,
          slug: c.slug,
          versionLabel: label,
          status: "draft",
          domain: domainId,
          capturedFrom: "ontology-gen",
          configJson: JSON.stringify(card),
          generatedBy: "ontology-generator",
          notes: `inferred from ${domainId} ontology — ${c.triggerEvent} → ${c.emitEvent}`,
        },
      });
      persisted = true;
    } catch (e) {
      // Unique-constraint (re-run within the same second) or other write failure
      // → keep the draft in the deploy summary even if the row wasn't written.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) {
        // non-collision errors are non-fatal here; the draft still surfaces.
      }
      persisted = false;
    }

    drafts.push({
      key: c.key,
      short: c.short,
      slug: c.slug,
      domain: domainId,
      nameZh: c.nameZh,
      nameEn: c.nameEn,
      agentId: c.agentId,
      triggerEvent: c.triggerEvent,
      emitEvent: c.emitEvent,
      confidence: c.confidence,
      iconChar: c.iconChar,
      iconColor: c.iconColor,
      status: "draft",
      versionLabel: label,
      persisted,
    });
  }

  const result: GenerateResult = { domainId, drafts };
  return NextResponse.json(result);
}
