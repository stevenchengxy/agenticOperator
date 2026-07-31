// lib/robohire/verify-jd-compliance.ts
//
// Deterministic (zero-LLM) post-generation check for ontology rule 4-2:
// "JD 全文不得出现客户公司名称". Gohire writes the companyName we send into the JD
// body, and the model can echo a client name that leaked through the requirement
// text. This runs AFTER generate-jd and BEFORE persistence: if the client's real
// name appears in the produced JD, replace every occurrence with the anonymized
// company descriptor and report the fixes (for a monitor signal / audit).
//
// It never throws and is a no-op when there is no client name to scrub, so wiring
// it in is zero-regression.

export type JdComplianceInput = {
  /** The client's real name (from the partner `client` table) — the thing 4-2 forbids in the JD. */
  clientName?: string | null;
  /** Anonymized replacement, e.g. "某金融科技行业知名企业". Falls back to a generic label. */
  companyDescriptor?: string | null;
};

export type JdComplianceResult = {
  content: string;
  /** Human-readable notes on what was scrubbed; empty when nothing changed. */
  fixes: string[];
};

const GENERIC_DESCRIPTOR = '某知名企业';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function verifyJdCompliance(
  content: string,
  input: JdComplianceInput,
): JdComplianceResult {
  const text = typeof content === 'string' ? content : '';
  const name = typeof input.clientName === 'string' ? input.clientName.trim() : '';
  // A 1-char "name" is too ambiguous to safely scrub (would gut unrelated text).
  if (name.length < 2) return { content: text, fixes: [] };

  const descriptor =
    typeof input.companyDescriptor === 'string' && input.companyDescriptor.trim()
      ? input.companyDescriptor.trim()
      : GENERIC_DESCRIPTOR;

  const re = new RegExp(escapeRegExp(name), 'gi');
  const matches = text.match(re);
  if (!matches || matches.length === 0) return { content: text, fixes: [] };

  return {
    content: text.replace(re, descriptor),
    fixes: [
      `客户名称「${name}」在 JD 正文出现 ${matches.length} 处，已替换为「${descriptor}」(规则 4-2)`,
    ],
  };
}
