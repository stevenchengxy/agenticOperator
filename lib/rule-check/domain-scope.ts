// Rule-check audit data is recorded only for the recruitment domain today —
// the recruitment ruleCheckAgent is the only agent that runs rule checks and
// writes RuleCheckAudit rows. The RuleCheckAudit table has no domain column, so
// scoping by business domain is: recruitment → its real audits; any other
// domain → an empty/zeroed result (honest "本领域暂无规则校验运行" state) rather
// than leaking recruitment audits into another domain's view.
//
// When other domains start producing rule-check audits (e.g. a per-domain
// rule-check agent + a domain column on RuleCheckAudit), broaden this predicate.

import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';

/** True when the given business domain has its own recorded rule-check audits. */
export function isRuleCheckDomain(domain: string | null | undefined): boolean {
  const d = (domain ?? '').trim();
  // Empty = the page's default (recruitment). Accept the recruitment id + its
  // historical aliases.
  return d === '' || d === RECRUITMENT_DOMAIN_ID || d === 'RAAS-v1' || d === 'raas';
}
