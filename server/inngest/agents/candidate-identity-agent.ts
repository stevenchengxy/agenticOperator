// rule-check-candidate-identity — candidate identity / dedup RULE-CHECK agent
// ("是不是同一个人"). It is a rule-check agent like ruleCheckAgent, just for identity.
//
// Triggered by RESUME_PROCESSED. Loads the 3 identity rules from data (rules.json,
// not hardcoded), fetches plausible existing duplicates, and applies the rules in
// priority order — exact for phone/email/gender, AI fuzzy-equivalence for
// name/school/major/degree. Writes one OntologyRuleCheck audit (agentSlug
// 'rule-check-candidate-identity') so the /rule-check facet page shows it; a weak rule-3 match
// is flagged for human review (decision VIOLATED). Soft-fails — never throws into the
// recruitment pipeline.
//
// Registered + enabled by default (audit-only, no pipeline gating). Opt out with
// CANDIDATE_IDENTITY_ENABLED=0 → the registered agent no-ops instantly.

import { inngest } from '@/server/inngest/client';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import {
  loadCandidateMatchRules,
  identityRulesByPriority,
} from '@/lib/rule-check/candidate-match/rules-data';
import { resolveIdentityMatch, type IdentityResolution } from '@/lib/rule-check/candidate-match/resolve-identity';
import { identityToCheck, type IdentityOntologyRule } from '@/lib/rule-check/candidate-match/to-ontology-check';
import { fetchActionRulesLive } from '@/lib/rule-check/api-rule-fetcher';
import { generateIdentityRationale } from '@/lib/rule-check/candidate-match/identity-rationale';
import { persistCandidateRuleCheck, type PersistCandidateCheckArgs } from '@/lib/rule-check/candidate-match/persist';
import {
  candidateFromResumeProcessed,
  partnerPgCandidateRepo,
  type CandidateRepo,
} from '@/lib/rule-check/candidate-match/candidate-repo';
import { makeAiFieldJudge } from '@/lib/rule-check/candidate-match/ai-equivalence';
import type { AiFieldJudge } from '@/lib/rule-check/candidate-match/field-equivalence';

const AGENT_ID = 'rule-check-candidate-identity-agent';
const AGENT_NAME = '候选人查重';
const STAGE = '候选人入库';

export interface IdentityHandlerDeps {
  repo: CandidateRepo;
  judge: AiFieldJudge;
  persist: (a: PersistCandidateCheckArgs) => Promise<{ id: string }>;
  enabled: boolean;
}

function defaultDeps(): IdentityHandlerDeps {
  return {
    repo: partnerPgCandidateRepo,
    judge: makeAiFieldJudge(),
    persist: persistCandidateRuleCheck,
    // Audit-only (no gating) → enabled by default; opt out with CANDIDATE_IDENTITY_ENABLED=0.
    enabled: process.env.CANDIDATE_IDENTITY_ENABLED !== '0',
  };
}

interface HandlerCtx {
  event: { data?: Record<string, unknown> } | Record<string, unknown>;
  step: { run: (id: string, fn: () => unknown) => Promise<unknown> };
  runId?: string;
}


export async function candidateIdentityHandler(ctx: HandlerCtx, depsOverride: Partial<IdentityHandlerDeps> = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  if (!deps.enabled) return { skipped: 'disabled' as const };

  const ev = ((ctx.event as { data?: Record<string, unknown> }).data ?? ctx.event) as Record<string, any>;
  const rec = candidateFromResumeProcessed(ev);
  const caseId = ctx.runId ?? (ev.upload_id as string) ?? rec.candidate_id;
  const ruleset = loadCandidateMatchRules();
  const rules = identityRulesByPriority(ruleset);

  // 统一审计日志:handler 三相 + 嵌套 partner-pg/LLM 调用经 ALS 归属到本 run。
  // 决策本体审计仍在 OntologyRuleCheck(persist);这里补的是运行轨迹可查。
  const fileLogger = createAgentLogger({
    agent: 'candidateIdentity',
    runId: caseId,
    traceId: (ev.trace_id as string) ?? null,
    anchors: { candidate_id: rec.candidate_id, upload_id: (ev.upload_id as string) ?? null },
  });
  return runWithLogger(fileLogger, async () => {
  fileLogger.event('handler.start', { trigger: 'RESUME_PROCESSED', candidate_id: rec.candidate_id });
  try {
    // Memoize the expensive/non-deterministic work (partner-pg query + LLM judge loop)
    // in its own step so an Inngest retry replays the cached result instead of
    // re-spending LLM calls.
    // Shared resolver (also used by resume-parser before save). It runs the three-tier
    // engine over the comparison pool and — crucially — captures WHICH existing candidate
    // matched (the engine itself drops that), the sole source of same_as_candidate_id.
    const computed = (await ctx.step.run('compute-identity-match', async () =>
      resolveIdentityMatch(rec, deps.repo, rules, deps.judge),
    )) as IdentityResolution;
    const result = computed.result;
    const dedupAction = computed.dedupAction;
    const sameAsCandidateId = computed.sameAsCandidateId;

    // 从 Neo4j/Allmeta 抓取本体原规则 9-15(provenance)。抓到 → 审计显示「9-15 同一候选人
    // 判定规则」(三级折进 checkPoint),ruleSource=ontology-api;抓不到(Allmeta 不可达)
    // → ontologyRule=null,回退展示打包 IDENTITY-1/2/3。引擎判定逻辑两路一致(不依赖它)。
    const ontologyRule = (await ctx.step.run('fetch-identity-ontology-rule', async () => {
      try {
        const byId = await fetchActionRulesLive('ruleCheckForCandidateIdentity');
        const r = byId.get('9-15');
        return r ? { id: r.id, name: r.businessLogicRuleName || '同一候选人判定规则' } : null;
      } catch {
        return null;
      }
    })) as IdentityOntologyRule | null;

    // 大模型生成「纳入依据」:把确定性判定(命中第几级、关联到谁、去重动作)交给 LLM 用
    // 一句业务中文复述。soft-fail → null,identityToCheck 回退机械文案。LLM 只复述、不改判。
    const llmRationale = (await ctx.step.run('generate-inclusion-rationale', async () => {
      if (!ontologyRule) return null;
      return generateIdentityRationale({
        result,
        candidateName: rec.name ?? null,
        matchedCandidateId: computed.matchedCandidateId,
        matchedCandidateName: computed.matchedCandidateName,
        dedupAction,
        ontologyRuleId: ontologyRule.id,
        ontologyRuleName: ontologyRule.name,
      });
    })) as string | null;

    const check = identityToCheck(
      result,
      rules.length,
      {
        matchedCandidateId: computed.matchedCandidateId,
        matchedCandidateName: computed.matchedCandidateName,
        dedupAction,
      },
      ontologyRule ?? undefined,
      llmRationale,
    );
    const { id } = (await ctx.step.run('persist-candidate-identity', () =>
      deps.persist({
        agentSlug: 'rule-check-candidate-identity',
        agentName: AGENT_NAME,
        stage: STAGE,
        caseId,
        traceId: (ev.trace_id as string) ?? null,
        // 抓到本体 9-15 → 标 ontology-api(来源是 Neo4j);否则回退本地 snapshot。
        ruleSource: ontologyRule ? 'ontology-api' : ruleset.source,
        selectionNote: {
          pool: computed.poolSize,
          ontologyRuleId: ontologyRule?.id ?? null,
          matchedRule: result.matchedRule?.ruleId ?? null,
          matchedCandidateId: computed.matchedCandidateId,
          matchedCandidateName: computed.matchedCandidateName,
          dedupAction,
          sameAsCandidateId,
        },
        check,
      }),
    )) as { id: string };

    fileLogger.event('handler.done', {
      same_person: result.samePerson,
      matched_rule: result.matchedRule?.ruleId ?? null,
      dedup_action: dedupAction,
      audit_id: id,
    });
    return {
      skipped: false as const,
      samePerson: result.samePerson,
      matchedRule: result.matchedRule?.ruleId ?? null,
      matchedCandidateId: computed.matchedCandidateId,
      sameAsCandidateId,
      dedupAction,
      needsHumanReview: result.needsHumanReview,
      auditId: id,
    };
  } catch (e) {
    // Soft-fail: identity dedup must never break the recruitment pipeline.
    // handler.error → agent_error → 审计日志 + 消息通知(经 mirrorAgentFileLog)。
    fileLogger.event('handler.error', { error: (e as Error).message ?? String(e) });
    return { skipped: false as const, error: (e as Error).message ?? String(e) };
  }
  });
}

export const candidateIdentityAgent = inngest.createFunction(
  { id: AGENT_ID, name: '候选人查重', retries: 1, triggers: [{ event: 'RESUME_PROCESSED' }] },
  async (ctx) => candidateIdentityHandler(ctx as unknown as HandlerCtx),
);
