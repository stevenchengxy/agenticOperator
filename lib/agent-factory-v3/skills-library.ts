// The persistent SKILLS library.
//
// A SKILL is a reusable chunk of agent-design know-how the brain AUTHORS at
// runtime (a prompt fragment + recommended tools + a decision rule). Until now
// skills lived only in `ctx.createdSkills` — in-memory, lost when the run ended.
// This module persists each authored skill to disk so the NEXT run (in any
// domain) can discover it and choose to reuse it — the factory compounds its
// own know-how over time instead of re-deriving it every run.
//
// On-disk layout mirrors Claude Code's own skills (a folder per skill):
//
//   skills-library/
//     <skill-slug>/
//       SKILL.md     ← frontmatter (name/purpose/domain/tools/…) + the fragment
//
// Each sub-folder IS one skill. Human-inspectable, git-trackable, and the unit
// the brain loads + reuses. We deliberately keep it filesystem-based (not a DB
// table) so a skill reads like a document an engineer can open, edit, or delete.

import { promises as fs } from "node:fs";
import path from "node:path";

export type LibrarySkill = {
  name: string;
  slug: string;
  purpose: string;
  /** The guidance woven into a generated agent's system prompt. */
  promptFragment: string;
  /** Tools this skill recommends an agent bind. */
  tools: string[];
  /** A one-line decision rule the skill encodes. */
  decisionRule: string;
  /** Domain this skill was authored in. "*" = general (reusable anywhere). */
  domain: string;
  createdAt: string;
  /** How many times a later run has adopted this skill — a reuse signal. */
  useCount: number;
  /** SkillsBench-style EFFECTIVENESS signal: of the runs that used this skill and
   *  reached a sandbox verdict, how many actually passed. useCount alone can't tell
   *  a skill that's reused-but-useless from one that genuinely helps. */
  evalCount: number;
  successCount: number;
};

/** Laplace-smoothed success rate in [0,1]; 0 evals → 0.5 (neutral prior), so a
 *  1/1 skill doesn't outrank a proven 9/10 one. Used to rank skills for reuse. */
export function skillEffectiveness(s: { evalCount: number; successCount: number }): number {
  return (s.successCount + 1) / (s.evalCount + 2);
}

export type SkillInput = {
  name: string;
  purpose: string;
  promptFragment: string;
  tools?: string[];
  decisionRule?: string;
  /** "*" marks a general skill usable across domains. */
  general?: boolean;
};

const ROOT = path.join(process.cwd(), "skills-library");

export function skillsRoot(): string {
  return ROOT;
}

export function slugifySkill(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  );
}

function render(s: LibrarySkill): string {
  const oneLine = (v: string) => v.replace(/\r?\n/g, " ").trim();
  return (
    `---\n` +
    `name: ${oneLine(s.name)}\n` +
    `slug: ${s.slug}\n` +
    `purpose: ${oneLine(s.purpose)}\n` +
    `domain: ${s.domain}\n` +
    `tools: ${JSON.stringify(s.tools)}\n` +
    `decisionRule: ${oneLine(s.decisionRule)}\n` +
    `createdAt: ${s.createdAt}\n` +
    `useCount: ${s.useCount}\n` +
    `evalCount: ${s.evalCount}\n` +
    `successCount: ${s.successCount}\n` +
    `---\n\n${s.promptFragment.trim()}\n`
  );
}

function parse(md: string, slug: string): LibrarySkill | null {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  let tools: string[] = [];
  try {
    tools = JSON.parse(fm.tools || "[]");
  } catch {
    tools = [];
  }
  return {
    name: fm.name || slug,
    slug: fm.slug || slug,
    purpose: fm.purpose || "",
    promptFragment: (m[2] || "").trim(),
    tools,
    decisionRule: fm.decisionRule || "",
    domain: fm.domain || "*",
    createdAt: fm.createdAt || "",
    useCount: Number(fm.useCount || 0) || 0,
    evalCount: Number(fm.evalCount || 0) || 0,
    successCount: Number(fm.successCount || 0) || 0,
  };
}

/** Read one skill by slug (null if absent / unparseable). */
export async function readSkill(slug: string): Promise<LibrarySkill | null> {
  try {
    const md = await fs.readFile(path.join(ROOT, slug, "SKILL.md"), "utf8");
    return parse(md, slug);
  } catch {
    return null;
  }
}

/** Persist (create or update) a skill. Preserves an existing skill's createdAt +
 *  useCount when overwriting, so re-authoring doesn't reset its reuse history. */
export async function saveSkill(input: SkillInput, domain: string): Promise<LibrarySkill> {
  const slug = slugifySkill(input.name);
  const dir = path.join(ROOT, slug);
  const prior = await readSkill(slug);
  const skill: LibrarySkill = {
    name: input.name.trim(),
    slug,
    purpose: input.purpose,
    promptFragment: input.promptFragment,
    tools: input.tools ?? [],
    decisionRule: input.decisionRule ?? "",
    domain: input.general ? "*" : domain,
    createdAt: prior?.createdAt || new Date().toISOString(),
    useCount: prior?.useCount ?? 0,
    evalCount: prior?.evalCount ?? 0,
    successCount: prior?.successCount ?? 0,
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), render(skill), "utf8");
  return skill;
}

/** All skills relevant to a domain: that domain's own skills + general ("*")
 *  skills. Omit `domain` to list everything. Sorted most-reused first. */
export async function loadSkills(domain?: string): Promise<LibrarySkill[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(ROOT);
  } catch {
    return []; // library not created yet
  }
  const out: LibrarySkill[] = [];
  for (const slug of entries) {
    const s = await readSkill(slug);
    if (!s) continue;
    if (!domain || s.domain === "*" || s.domain === domain) out.push(s);
  }
  // Rank by EFFECTIVENESS first (does reuse actually help?), reuse count as the
  // tiebreak — so the brain is steered toward skills that proved out in sandbox,
  // not just ones that happen to get picked a lot (SkillsBench B).
  return out.sort((a, b) => skillEffectiveness(b) - skillEffectiveness(a) || b.useCount - a.useCount);
}

/** Increment a skill's reuse counter (best-effort). */
export async function bumpUseCount(slug: string): Promise<void> {
  const s = await readSkill(slug);
  if (!s) return;
  s.useCount += 1;
  try {
    await fs.writeFile(path.join(ROOT, slug, "SKILL.md"), render(s), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Record a sandbox outcome for a skill that a run USED — the effectiveness signal.
 *  Called after a sandbox run with ok = did the chain pass. Best-effort. */
export async function recordSkillEvaluation(slug: string, ok: boolean): Promise<void> {
  const s = await readSkill(slug);
  if (!s) return;
  s.evalCount += 1;
  if (ok) s.successCount += 1;
  try {
    await fs.writeFile(path.join(ROOT, slug, "SKILL.md"), render(s), "utf8");
  } catch {
    /* best-effort */
  }
}
