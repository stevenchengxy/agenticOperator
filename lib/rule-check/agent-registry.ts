// Catalog of rule-check agents per business domain. This is the source of
// truth for the /rule-check page's "执行 agent" facet: within one domain there
// can be several rule-check agents running at different workflow positions
// (e.g. recruitment has 岗位合规校验 at 简历筛查, and the planned 候选人身份去重 /
// 候选人归属判定 at intake/claim). The recruitment RuleCheckAudit store has no
// agent column, so recruitment audits are stamped with the live compliance
// agent id (JR_COMPLIANCE_AGENT_ID); the generic OntologyRuleCheck store
// already carries agentSlug, so non-recruitment / future recruitment agents are
// data-driven and not listed here (facets there come from the data).

import { isRecruitmentDomain } from '@/lib/domain-ids';

export type RuleCheckAgentStatus = 'live' | 'planned';

export interface RuleCheckAgent {
  /** Stable facet id, matches the `agent` query param + the stamped audit value. */
  id: string;
  /** Localized agent name shown in the facet dropdown + the audit card badge. */
  label: { zh: string; en: string };
  /** Localized workflow position ("在流程哪个位置执行"). */
  stage: { zh: string; en: string };
  /** 'live' = already produces records; 'planned' = wired but not yet emitting. */
  status: RuleCheckAgentStatus;
}

/** Facet id of the existing recruitment compliance agent — used to stamp the
 *  recruitment RuleCheckAudit rows, which have no agent column of their own. */
export const JR_COMPLIANCE_AGENT_ID = 'jr-compliance';

const RECRUITMENT_AGENTS: ReadonlyArray<RuleCheckAgent> = [
  {
    id: JR_COMPLIANCE_AGENT_ID,
    label: { zh: '岗位合规校验', en: 'JD Compliance' },
    stage: { zh: '简历筛查', en: 'Resume Screening' },
    status: 'live',
  },
  {
    id: 'rule-check-candidate-identity',
    label: { zh: '候选人查重', en: 'Candidate Dedup' },
    stage: { zh: '候选人入库', en: 'Candidate Intake' },
    status: 'live',
  },
  {
    id: 'rule-check-candidate-ownership',
    label: { zh: '候选人归属核验', en: 'Candidate Ownership' },
    stage: { zh: '候选人认领', en: 'Candidate Claim' },
    status: 'live',
  },
];

/** Registered rule-check agents for a domain. Recruitment (incl. legacy ids and
 *  empty/undefined → the app default) returns the catalog above; every other
 *  domain returns [] because its facets are derived from OntologyRuleCheck data. */
export function agentsForDomain(domain: string | null | undefined): RuleCheckAgent[] {
  return isRecruitmentDomain(domain) ? [...RECRUITMENT_AGENTS] : [];
}

/** Find a registered agent by (domain, id). Undefined if not catalogued. */
export function lookupAgent(
  domain: string | null | undefined,
  id: string,
): RuleCheckAgent | undefined {
  return agentsForDomain(domain).find((a) => a.id === id);
}

/** Localized label for an agent id, falling back to the raw id (so data-driven
 *  agents not in the catalog still render a sensible badge). */
export function agentLabel(
  domain: string | null | undefined,
  id: string,
  lang: 'zh' | 'en',
): string {
  return lookupAgent(domain, id)?.label[lang] ?? id;
}
