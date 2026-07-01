// Bridge generated specs into the runtime world:
//  - specToDerivedAgent: GeneratedAgentSpec -> DerivedAgent (the exact shape
//    makeOntologyAgent consumes), so a generated agent CAN be materialized as
//    a real Inngest function by the existing factory.
//  - persistSpecs: write draft AgentVersion rows (status='draft',
//    capturedFrom='ontology-gen') reusing the ontology-generator convention,
//    storing the full spec in specJson + the prompt in promptText.
//
// NOTE: actual Inngest hot-registration is intentionally NOT done here — Inngest
// has no runtime register; generated agents activate on next process start via
// the per-domain app (or stay drafts). This matches the repo's deferred Phase 5.

import type { DerivedAgent } from "@/lib/ontology-generator/analyze";
import { prisma } from "@/server/db";
import type { GeneratedAgentSpec } from "./types";

const deCamel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function contentHash(specs: GeneratedAgentSpec[]): string {
  return djb2(JSON.stringify(specs.map((s) => [s.slug, s.systemPrompt, s.tools, s.trigger, s.emit])));
}

/** Convert a factory spec to the runtime DerivedAgent shape (20 required fields). */
export function specToDerivedAgent(s: GeneratedAgentSpec): DerivedAgent {
  // `|| actionName` (not ??) so an empty/whitespace first prompt line still falls back
  const firstLine = s.systemPrompt.split("\n")[0]?.trim() || s.actionName;
  const descZh = firstLine.slice(0, 80);
  const rationaleZh =
    `${(s.trigger[0] ?? "—")} → ${s.actionName} → ${s.emit.join("/") || "—"};` +
    `工具:${s.tools.join(", ") || "（无）"};retries=${s.retries}`;
  return {
    key: s.key,
    actionName: s.actionName,
    slug: s.slug,
    short: s.short,
    nameZh: s.nameZh,
    nameEn: deCamel(s.actionName),
    descZh,
    descEn: descZh, // no English source yet — reuse zh rather than leak a camelCase id

    kind: s.kind,
    triggerEvents: [...s.trigger],
    emitEvents: [...s.emit],
    tools: [...s.tools],
    objects: [...s.objects],
    systemPrompt: s.systemPrompt,
    userPrompt: s.userPrompt,
    rationaleZh,
    rationaleEn: `${s.trigger[0] ?? "-"} -> ${s.actionName} -> ${s.emit.join("/") || "-"}`,
    confidence: s.confidence,
  };
}

export interface PersistResult {
  persisted: string[]; // slugs written
  skipped: string[]; // slugs that collided (already present this version) or failed
  errors: Array<{ slug: string; error: string }>;
  versionLabel: string;
}

export interface PersistOptions {
  /** version label; defaults to a factory timestamp. */
  versionLabel?: string;
  /** Override the AgentVersion.domain column (the DEPLOY target / which Inngest
   *  app serves it) independently of spec.domainId (which still drives the tool
   *  registry + dry-run at runtime). Used to deploy a sandbox copy to a dedicated
   *  `sandbox-<domain>` app without touching the real domain's app. Defaults to
   *  spec.domainId. */
  deployDomain?: string;
}

/** Write each generated spec as a draft AgentVersion row. Idempotent: versionLabel
 *  defaults to a content hash of the specs, so the SAME generation collides on the
 *  real `@@unique([short, versionLabel])` constraint (P2002 → skipped) while a CHANGED
 *  generation gets a fresh version. P2002 = dedup skip; other errors → `errors`
 *  (disjoint from `skipped`) and the caller should treat them as a real failure. */
export async function persistSpecs(
  specs: GeneratedAgentSpec[],
  opts: PersistOptions = {},
): Promise<PersistResult> {
  const versionLabel = opts.versionLabel ?? `factory-${contentHash(specs)}`;
  const persisted: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ slug: string; error: string }> = [];

  for (const s of specs) {
    const card = {
      nameZh: s.nameZh,
      kind: s.kind,
      triggerEvent: s.trigger[0] ?? "",
      emitEvent: s.emit[0] ?? "",
      tools: s.tools,
      objects: s.objects,
      retries: s.retries,
      promptSource: s.promptSource,
      confidence: s.confidence,
    };
    try {
      await prisma.agentVersion.create({
        data: {
          short: s.short,
          slug: s.slug,
          versionLabel,
          status: "draft",
          domain: opts.deployDomain ?? s.domainId,
          capturedFrom: "ontology-gen",
          generatedBy: "agent-factory-gen",
          configJson: JSON.stringify(card),
          configHash: djb2(JSON.stringify(s)),
          specJson: JSON.stringify(s),
          promptText: s.systemPrompt,
          notes: `factory-generated draft from ${s.domainId} ontology — ${s.trigger[0] ?? "?"} → ${s.emit.join("/") || "?"}`,
        },
      });
      persisted.push(s.slug);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "P2002") {
        skipped.push(s.slug); // already written (dedup) — idempotent, not fatal
      } else {
        // real failure — keep disjoint from `skipped` so the caller can detect it
        errors.push({ slug: s.slug, error: String((e as Error).message ?? e) });
      }
    }
  }

  return { persisted, skipped, errors, versionLabel };
}

/** Persist the current generation as the domain's DRAFT set and refresh it:
 *  write the specs as draft rows (idempotent on content hash) and drop stale
 *  ontology-gen drafts from earlier generations of the SAME domain, so the Fleet
 *  drafts list reflects exactly the current generated set instead of piling up.
 *  Called from the brain's generate step so generated agents land in the Fleet
 *  drafts immediately — before any deploy decision. */
export async function syncDomainDrafts(
  domain: string,
  specs: GeneratedAgentSpec[],
): Promise<PersistResult> {
  const res = await persistSpecs(specs);
  if (res.versionLabel) {
    await prisma.agentVersion.deleteMany({
      where: {
        domain,
        capturedFrom: "ontology-gen",
        status: "draft",
        versionLabel: { not: res.versionLabel },
      },
    });
  }
  return res;
}
