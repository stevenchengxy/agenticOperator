// lib/robohire/jd-prompt-blocks.ts
//
// Pure builders for the two prompt sections createJD gains (design 2026-07-21 §2):
//   1. company background block — industry / tech-stack / welfare, so the generated
//      JD's Benefits section stops being "TBD";
//   2. generation constraints block — the ontology createJD rules (4-2/4-3/4-4)
//      rendered as instructions, since Gohire has no rule-specific input channel.
// Plus `budgetPrompt`, which reserves space for these appended blocks so they are
// never lost to the 4000-char cap (the requirement body is truncated first).
//
// All builders return '' / the input unchanged when they have nothing to add, so a
// missing client row or an Allmeta outage degrades to exactly today's prompt.

import type { OntologyRuleLite } from '@/lib/ontology-rules';

function clean(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/** Anonymized company label safe to send to Gohire (rule 4-2 forbids the real name). */
export function deriveCompanyDescriptor(industry?: string | null): string {
  const s = clean(industry);
  if (!s) return '某知名企业';
  return s.endsWith('行业') ? `某${s}知名企业` : `某${s}行业知名企业`;
}

export type CompanyBackground = {
  descriptor?: string | null;
  technicalStackPreference?: string | null;
  welfarePolicy?: string | null;
};

export function buildCompanyBackgroundBlock(ctx: CompanyBackground): string {
  const lines: string[] = [];
  const d = clean(ctx.descriptor);
  const tech = clean(ctx.technicalStackPreference);
  const welfare = clean(ctx.welfarePolicy);
  if (d) lines.push(`公司背景: ${d}`);
  if (tech) lines.push(`技术栈偏好: ${tech}`);
  if (welfare) lines.push(`福利政策: ${welfare}`);
  return lines.join('\n');
}

export function buildGenerationConstraintsBlock(rules: OntologyRuleLite[]): string {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  const bullets = rules
    .map((r) => clean(r?.rule) || clean(r?.name))
    .filter((x): x is string => !!x)
    .map((x) => `- ${x}`);
  if (bullets.length === 0) return '';
  return `生成约束（必须遵守）:\n${bullets.join('\n')}`;
}

/**
 * Compose the requirement body with appended blocks under a hard length cap.
 * Blocks (constraints + company background) take priority — they are never
 * truncated away; the requirement body is truncated to whatever budget remains.
 * With no blocks this is exactly the old `body.slice(0, limit)`.
 */
export function budgetPrompt(body: string, blocks: string, limit = 4000): string {
  const b = typeof body === 'string' ? body : '';
  const appended = typeof blocks === 'string' ? blocks.trim() : '';
  if (!appended) return b.slice(0, limit);

  const sep = '\n\n';
  const cappedBlocks = appended.slice(0, limit);
  const bodyBudget = Math.max(0, limit - cappedBlocks.length - sep.length);
  const truncBody = b.slice(0, bodyBudget);
  const out = truncBody ? `${truncBody}${sep}${cappedBlocks}` : cappedBlocks;
  return out.slice(0, limit);
}
