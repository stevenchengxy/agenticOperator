// rule-check-candidate-ownership — candidate ownership / 归属 RULE-CHECK agent
// ("这个人归谁"). It is a rule-check agent like ruleCheckAgent, just for ownership.
//
// Triggered by RESUME_PROCESSED. Loads the ownership rules from data (rules.json:
// 锁定归属 + 腾讯客户关系归属保护), reads the candidate's lock snapshot, and decides
// proceed vs ownership-conflict (lock-only). The 腾讯 customer-relationship rule
// overrides the standard lock gate. Writes one OntologyRuleCheck audit (agentSlug
// 'rule-check-candidate-ownership'); a conflict is decision VIOLATED + redline. Soft-fails.
//
// Registered + enabled by default (audit-only, no pipeline gating). Opt out with
// CANDIDATE_OWNERSHIP_ENABLED=0. The default ownership context comes from the
// CandidateLock mirror (populated by the candidate-lock RMHR flow); no lock row →
// nothing to decide → skip.

import { inngest } from '@/server/inngest/client';
import { prisma } from '@/server/db';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import { loadCandidateMatchRules } from '@/lib/rule-check/candidate-match/rules-data';
import { decideOwnership, type OwnershipContext } from '@/lib/rule-check/candidate-match/ownership-engine';
import { ownershipToCheck } from '@/lib/rule-check/candidate-match/to-ontology-check';
import { persistCandidateRuleCheck, type PersistCandidateCheckArgs } from '@/lib/rule-check/candidate-match/persist';

const AGENT_ID = 'rule-check-candidate-ownership-agent';
const AGENT_NAME = '候选人归属核验';
const STAGE = '候选人认领';

export interface OwnershipHandlerDeps {
  loadContext: (ev: Record<string, any>) => Promise<OwnershipContext | null>;
  persist: (a: PersistCandidateCheckArgs) => Promise<{ id: string }>;
  enabled: boolean;
}

/** Default ownership context — read the CandidateLock mirror for this candidate.
 *  Returns null when there's no lock data (nothing to decide). 腾讯 relationship has
 *  no first-class source yet → false until the partner contract lands. */
async function defaultLoadContext(ev: Record<string, any>): Promise<OwnershipContext | null> {
  const candidateId = (ev.candidate_id as string) ?? null;
  const uploadId = (ev.upload_id as string) ?? null;
  if (!candidateId && !uploadId) return null;
  const row = candidateId
    ? await prisma.candidateLock.findFirst({ where: { candidateId } })
    : await prisma.candidateLock.findFirst({ where: { uploadId } });
  if (!row) return null;
  return {
    lockState: row.lockState ?? 1,
    blacklisted: row.blacklisted,
    lockByEmail: row.lockByEmail,
    claimantEmail: row.requestedByEmail ?? (ev.claimer_email as string) ?? '',
    client: (ev.client_id as string) ?? row.clientId ?? null,
    tencentRelationship: false,
  };
}

function defaultDeps(): OwnershipHandlerDeps {
  return {
    loadContext: defaultLoadContext,
    persist: persistCandidateRuleCheck,
    // Audit-only (no gating) → enabled by default; opt out with CANDIDATE_OWNERSHIP_ENABLED=0.
    enabled: process.env.CANDIDATE_OWNERSHIP_ENABLED !== '0',
  };
}

interface HandlerCtx {
  event: { data?: Record<string, unknown> } | Record<string, unknown>;
  step: { run: (id: string, fn: () => unknown) => Promise<unknown> };
  runId?: string;
}

export async function candidateOwnershipHandler(ctx: HandlerCtx, depsOverride: Partial<OwnershipHandlerDeps> = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  if (!deps.enabled) return { skipped: 'disabled' as const };

  const ev = ((ctx.event as { data?: Record<string, unknown> }).data ?? ctx.event) as Record<string, any>;
  const caseId = ctx.runId ?? (ev.upload_id as string) ?? (ev.candidate_id as string) ?? 'unknown';
  const ruleset = loadCandidateMatchRules();

  // 统一审计日志:handler 三相(运行轨迹进 LogEvent;决策审计仍在 OntologyRuleCheck)。
  const fileLogger = createAgentLogger({
    agent: 'candidateOwnership',
    runId: caseId,
    traceId: (ev.trace_id as string) ?? null,
    anchors: { candidate_id: (ev.candidate_id as string) ?? null, upload_id: (ev.upload_id as string) ?? null },
  });
  return runWithLogger(fileLogger, async () => {
  fileLogger.event('handler.start', { trigger: 'RESUME_PROCESSED' });
  try {
    // Memoize the lock-snapshot read so a retry replays it instead of re-querying.
    const octx = (await ctx.step.run('load-ownership-context', () => deps.loadContext(ev))) as
      | OwnershipContext
      | null;
    if (!octx) {
      fileLogger.event('handler.done', { skipped: 'no-context' });
      return { skipped: 'no-context' as const };
    }

    const decision = decideOwnership(octx, ruleset.ownershipRules);
    const check = ownershipToCheck(decision, ruleset.ownershipRules);
    // Be honest in the audit when the 腾讯 customer-relationship rule could not be
    // evaluated for lack of a relationship data source (it currently defaults false).
    const tencentNotEvaluable =
      (octx.client ?? '').trim() === '腾讯' && !octx.tencentRelationship;
    const { id } = (await ctx.step.run('persist-candidate-ownership', () =>
      deps.persist({
        agentSlug: 'rule-check-candidate-ownership',
        agentName: AGENT_NAME,
        stage: STAGE,
        caseId,
        traceId: (ev.trace_id as string) ?? null,
        ruleSource: ruleset.source,
        selectionNote: {
          decision: decision.decision,
          matchedRule: decision.matchedRuleId,
          tencentRelationship: octx.tencentRelationship ?? false,
          ...(tencentNotEvaluable
            ? { note: '腾讯客户关系数据暂缺,本次按无关系处理(OWN-TENCENT-1 未生效)' }
            : {}),
        },
        check,
      }),
    )) as { id: string };

    fileLogger.event('handler.done', {
      decision: decision.decision,
      matched_rule: decision.matchedRuleId,
      conflict: decision.conflict,
      audit_id: id,
    });
    return {
      skipped: false as const,
      decision: decision.decision,
      matchedRule: decision.matchedRuleId,
      conflict: decision.conflict,
      auditId: id,
    };
  } catch (e) {
    // handler.error → agent_error → 审计日志 + 消息通知(经 mirrorAgentFileLog)。
    fileLogger.event('handler.error', { error: (e as Error).message ?? String(e) });
    return { skipped: false as const, error: (e as Error).message ?? String(e) };
  }
  });
}

export const candidateOwnershipAgent = inngest.createFunction(
  { id: AGENT_ID, name: '候选人归属核验', retries: 1, triggers: [{ event: 'RESUME_PROCESSED' }] },
  async (ctx) => candidateOwnershipHandler(ctx as unknown as HandlerCtx),
);
