// Technical execution and business outcome are deliberately separate axes.
//
// A MATCH_FAILED event can be the correct output of a perfectly healthy run,
// while a vendor timeout means the business decision was never produced even
// if some handler accidentally returned `{ ok:false }` instead of throwing.
// Monitor, Events and Flow tracking all use this module so the distinction is
// consistent everywhere.

export type TechnicalOutcome = 'healthy' | 'degraded' | 'failed' | 'running' | 'cancelled';
export type TechnicalCause =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'authentication'
  | 'timeout'
  | 'network'
  | 'upstream_server'
  | 'empty_response'
  | 'data_not_found'
  | 'missing_input'
  | 'invalid_response'
  | 'persistence'
  | 'configuration'
  | 'dependency_unavailable'
  | 'unknown';
export type RecoveryAction =
  | 'top_up_then_retry'
  | 'auto_retry'
  | 'fix_credentials'
  | 'fix_input'
  | 'inspect_response'
  | 'repair_persistence'
  | 'fix_configuration'
  | 'manual_review';
export type BusinessOutcome =
  | 'passed'
  | 'rejected'
  | 'mixed'
  | 'blocked'
  | 'pending'
  | 'not_applicable'
  | 'unknown';

export type OutcomeSummary = {
  technical: TechnicalOutcome;
  business: BusinessOutcome;
  reason: string | null;
  code: string | null;
  score: number | null;
  emittedEvent: string | null;
  technicalCause: TechnicalCause | null;
  provider: string | null;
  recoveryAction: RecoveryAction | null;
};

export type RunOutcomeInput = {
  status: string;
  functionSlug?: string | null;
  triggerEvent?: string | null;
  output?: unknown;
  dependencyFailure?: { reason?: string | null; detail?: string | null; provider?: string | null } | null;
};

export type TechnicalCauseInfo = {
  cause: TechnicalCause;
  provider: string | null;
  recoveryAction: RecoveryAction;
};

/**
 * Agent-agnostic technical-cause classifier. It prefers structured dependency
 * reasons, then falls back to codes and human-readable details, so newly added
 * agents get useful diagnosis without adding function-specific branches here.
 */
export function classifyTechnicalCause(input: {
  reason?: string | null;
  code?: string | null;
  provider?: string | null;
}): TechnicalCauseInfo {
  const text = [input.reason, input.code, input.provider].filter(Boolean).join(' ').toLowerCase();
  const provider = normalizeProvider(input.provider) ?? inferProvider(text);
  const match = (pattern: RegExp) => pattern.test(text);

  if (match(/\bquota\b|quota[_ -]?exhausted|insufficient[_ -]?(?:quota|funds)|billing|payment required|credit|balance|余额|额度|欠费|没钱/)) {
    return { cause: 'quota_exhausted', provider, recoveryAction: 'top_up_then_retry' };
  }
  if (match(/rate[_ -]?limit|too many requests|\b429\b|限流|频率限制/)) {
    return { cause: 'rate_limited', provider, recoveryAction: 'auto_retry' };
  }
  if (match(/timeout|timed out|etimedout|请求超时|超时/)) {
    return { cause: 'timeout', provider, recoveryAction: 'auto_retry' };
  }
  if (match(/network|econn|enotfound|dns|socket|connection (?:reset|refused)|fetch failed|unreachable|网络|连接失败/)) {
    return { cause: 'network', provider, recoveryAction: 'auto_retry' };
  }
  if (match(/\bauth\b|unauthorized|forbidden|invalid api key|credential|\b401\b|\b403\b|鉴权|凭证|密钥/)) {
    return { cause: 'authentication', provider, recoveryAction: 'fix_credentials' };
  }
  if (match(/\bserver\b|server error|internal server|bad gateway|service unavailable|\b5\d\d\b|上游服务|服务端错误/)) {
    return { cause: 'upstream_server', provider, recoveryAction: 'auto_retry' };
  }
  if (match(/\bempty\b|empty response|内容为空|空结果|空返回|返回200但|返回 200 但/)) {
    return { cause: 'empty_response', provider, recoveryAction: 'inspect_response' };
  }
  if (match(/\b(?:record|resource|entity|job|candidate|resume)?\s*not found\b|no such (?:record|resource|entity)|数据不存在|记录不存在|职位不存在|岗位不存在|job_requisition.{0,80}不存在/)) {
    return { cause: 'data_not_found', provider, recoveryAction: 'fix_input' };
  }
  if (match(/missing[_ -]?(?:input|payload|field)|\bmissing\b.{0,40}\b(?:input|payload|field|entity)\b|missing-.+|缺少|缺失|不能为空|cannot anchor/)) {
    return { cause: 'missing_input', provider, recoveryAction: 'fix_input' };
  }
  if (match(/invalid response|malformed|schema|json parse|parse error|unexpected response|格式错误|响应无效|解析失败/)) {
    return { cause: 'invalid_response', provider, recoveryAction: 'inspect_response' };
  }
  if (match(/persistence|persist|database|postgres|neo4j|allmeta|minio|write failed|save failed|写入失败|落库失败|保存失败|存储失败/)) {
    return { cause: 'persistence', provider, recoveryAction: 'repair_persistence' };
  }
  if (match(/not configured|configuration|config missing|环境变量|未配置|配置错误/)) {
    return { cause: 'configuration', provider, recoveryAction: 'fix_configuration' };
  }
  if (match(/dependency|unavailable|service down|依赖|不可用|故障/)) {
    return { cause: 'dependency_unavailable', provider, recoveryAction: 'auto_retry' };
  }
  return { cause: 'unknown', provider, recoveryAction: 'manual_review' };
}

function normalizeProvider(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (/robohire/i.test(normalized)) return 'RoboHire';
  if (/gohire/i.test(normalized)) return 'GoHire';
  if (/\bllm\b|ai gateway|大模型|模型网关/i.test(normalized)) return 'AI 网关';
  if (/allmeta|neo4j/i.test(normalized)) return 'Allmeta';
  if (/postgres|partner.?pg/i.test(normalized)) return 'Partner PG';
  if (/minio/i.test(normalized)) return 'MinIO';
  if (/inngest/i.test(normalized)) return 'Inngest';
  return normalized.slice(0, 48);
}

function inferProvider(text: string): string | null {
  if (/robohire/.test(text)) return 'RoboHire';
  if (/gohire/.test(text)) return 'GoHire';
  if (/\bllm\b|ai gateway|大模型|模型网关/.test(text)) return 'AI 网关';
  if (/allmeta|neo4j/.test(text)) return 'Allmeta';
  if (/postgres|partner.?pg/.test(text)) return 'Partner PG';
  if (/minio/.test(text)) return 'MinIO';
  if (/inngest/.test(text)) return 'Inngest';
  return null;
}

/**
 * Cached/LLM summaries are advisory. The structured outcome is authoritative,
 * so suppress a summary when it would send an operator in the opposite
 * direction (for example: score 25 + MATCH_FAILED described as "推进面试").
 */
export function summaryContradictsOutcome(
  text: string,
  outcome: OutcomeSummary | null | undefined,
): boolean {
  if (!outcome || !text.trim()) return false;

  const saysBusinessPass =
    /匹配达标|符合(?:业务|岗位|职位).*要求|(?:匹配|业务)(?:已)?通过|推进(?:至|到)?(?:后续|面试)|进入面试|建议.{0,12}(?:推进|面试)|business (?:passed|qualified)|qualified candidate|advance.{0,20}interview/i.test(text);
  const acknowledgesBusinessReject =
    /业务未通过|匹配未通过|未达标|不匹配|候选人被拒|(?:business|candidate).{0,12}(?:rejected|not qualified|disqualified)/i.test(text);
  if (outcome.business === 'rejected' && saysBusinessPass && !acknowledgesBusinessReject) {
    return true;
  }

  const promisesAutomaticRecovery =
    /临时波动|通常自愈|等待.{0,12}自动(?:重试|重放|续跑)|系统(?:会|将)?自动(?:重试|重放|恢复)|auto(?:matic)?(?:ally)?.{0,16}(?:retry|replay|recover|resume)/i.test(text);
  const acknowledgesRequiredFix =
    /补齐(?:输入|字段|数据)|修复(?:输入|凭证|配置|存储)|检查上游响应|充值|续费|余额|额度|top.?up|fix (?:input|credentials|configuration)|repair (?:storage|persistence)/i.test(text);
  if (
    outcome.recoveryAction &&
    outcome.recoveryAction !== 'auto_retry' &&
    promisesAutomaticRecovery &&
    !acknowledgesRequiredFix
  ) {
    return true;
  }
  if (
    outcome.recoveryAction === 'top_up_then_retry' &&
    promisesAutomaticRecovery &&
    !/(?:充值|续费|余额|额度|top.?up|billing|credit)/i.test(text)
  ) {
    return true;
  }

  const saysTechnicalHealthy =
    /未发现(?:任何)?异常|无(?:技术)?错误|全部成功|执行正常|运行正常|completed successfully|no (?:technical )?(?:error|issue)/i.test(text);
  const acknowledgesTechnicalBlock =
    /技术失败|技术异常|基础设施故障|业务未产出|依赖.{0,12}(?:失败|异常|不可用)|technical (?:failure|anomaly|block)|infrastructure (?:failure|issue)/i.test(text);
  return (
    (outcome.technical === 'failed' || outcome.technical === 'degraded' || outcome.business === 'blocked') &&
    saysTechnicalHealthy &&
    !acknowledgesTechnicalBlock
  );
}

const BUSINESS_REJECT_EVENTS = new Set([
  'MATCH_FAILED',
  'MATCH_RULE_CHECK_FAILED',
  'RULE_CHECK_FAILED',
  'CANDIDATE_REJECTED',
]);
const BUSINESS_PASS_EVENTS = new Set([
  'MATCH_PASSED_NEED_INTERVIEW',
  'MATCH_RULE_CHECK_PASSED',
  'INTERVIEW_INVITATION_SENT',
  'JD_GENERATED',
  'RESUME_PROCESSED',
]);
const TECHNICAL_ERROR_CODES = /ROBOHIRE|GOHIRE_API|QUOTA|RATE_LIMIT|NETWORK|SERVER|AUTH|EMPTY|PERSISTENCE|BACKFILL|MISSING_PAYLOAD/i;

export function deriveRunOutcome(input: RunOutcomeInput): OutcomeSummary {
  const status = input.status.toUpperCase();
  const facts = collectFacts(input.output);
  const emitted = facts.events[0] ?? null;
  const code = facts.codes[0] ?? null;
  const reason =
    input.dependencyFailure?.detail ??
    facts.errors[0] ??
    (input.dependencyFailure?.reason ? String(input.dependencyFailure.reason) : null);
  const causeInfo = classifyTechnicalCause({
    reason: [input.dependencyFailure?.reason, reason, ...facts.warnings].filter(Boolean).join(' · '),
    code,
    provider: input.dependencyFailure?.provider,
  });
  const finish = (
    technical: TechnicalOutcome,
    business: BusinessOutcome,
    finalReason = reason,
    finalCode = code,
    score = facts.score,
    finalEvent = emitted,
  ) => summary(technical, business, finalReason, finalCode, score, finalEvent, causeInfo);

  if (status === 'RUNNING' || status === 'SCHEDULED' || status === 'QUEUED') {
    return finish('running', 'pending');
  }
  if (status === 'FAILED') {
    return finish('failed', 'blocked');
  }
  if (status === 'CANCELLED' || status === 'CANCELED') {
    return finish('cancelled', 'blocked');
  }

  const eventBusiness = businessFromEvents(facts.events);
  const businessRejection =
    eventBusiness === 'rejected' ||
    code === 'GOHIRE_REJECTED' ||
    facts.overallStatuses.some((value) => /不匹配|未通过|拒绝|rejected|not.?match/i.test(value));
  const passed =
    eventBusiness === 'passed' ||
    facts.overallStatuses.some((value) => /(^|\b)匹配|通过|passed|matched/i.test(value));
  const mixed = eventBusiness === 'mixed';

  // Completed + ok:false is only healthy when it represents a deliberate
  // business rejection. Everything else is a blocked/degraded execution that
  // must remain visible instead of being painted green.
  if (facts.ok === false && !businessRejection) {
    return finish('degraded', 'blocked');
  }
  if (input.dependencyFailure) {
    return finish('degraded', businessRejection ? 'rejected' : 'blocked');
  }
  const completedTechnical: TechnicalOutcome = facts.warnings.length > 0 ? 'degraded' : 'healthy';
  const completedReason = facts.warnings[0] ?? reason;
  if (mixed) return finish(completedTechnical, 'mixed', completedReason);
  if (businessRejection) return finish(completedTechnical, 'rejected', completedReason);
  if (passed) return finish(completedTechnical, 'passed', completedReason);

  // Interview failures with a vendor/system code are technical blocks. A
  // GoHire rejection is handled above as a healthy execution + rejected
  // business outcome.
  if (code && TECHNICAL_ERROR_CODES.test(code)) {
    return finish('degraded', 'blocked');
  }

  return finish(completedTechnical, 'not_applicable', completedReason);
}

export function deriveEventOutcome(
  name: string,
  data: unknown,
  processing: OutcomeSummary[] = [],
): OutcomeSummary {
  const own = deriveRunOutcome({ status: 'Completed', triggerEvent: name, output: data });
  const normalizedName = name.toUpperCase();
  const facts = collectFacts(data);
  const code = facts.codes[0] ?? own.code;
  let eventBusiness = own.business;
  let eventTechnical = own.technical;

  if (normalizedName === 'INTERVIEW_INVITATION_FAILED') {
    if (code === 'GOHIRE_REJECTED') {
      eventBusiness = 'rejected';
      eventTechnical = 'healthy';
    } else {
      eventBusiness = 'blocked';
      eventTechnical = 'degraded';
    }
  } else if (BUSINESS_REJECT_EVENTS.has(normalizedName)) {
    // A technical MATCH_FAILED carries success:false/error_kind; a normal
    // low-score MATCH_FAILED carries success:true and is a business rejection.
    if (facts.ok === false && facts.errors.length > 0) {
      eventBusiness = 'blocked';
      eventTechnical = 'degraded';
    } else {
      eventBusiness = 'rejected';
      eventTechnical = 'healthy';
    }
  } else if (BUSINESS_PASS_EVENTS.has(normalizedName)) {
    eventBusiness = 'passed';
  }

  if (processing.length === 0) {
    const keepsCause = eventTechnical === 'failed' || eventTechnical === 'degraded';
    return {
      ...own,
      technical: eventTechnical,
      business: eventBusiness,
      code,
      technicalCause: keepsCause ? own.technicalCause ?? 'unknown' : null,
      provider: keepsCause ? own.provider : null,
      recoveryAction: keepsCause ? own.recoveryAction ?? 'manual_review' : null,
    };
  }

  const technical = worstTechnical([eventTechnical, ...processing.map((p) => p.technical)]);
  const business = combineBusiness([eventBusiness, ...processing.map((p) => p.business)]);
  const failure = processing.find((p) => p.technical === 'failed' || p.technical === 'degraded');
  return {
    technical,
    business,
    reason: failure?.reason ?? own.reason,
    code: failure?.code ?? code,
    score: own.score ?? processing.find((p) => p.score != null)?.score ?? null,
    emittedEvent: own.emittedEvent,
    technicalCause:
      technical === 'failed' || technical === 'degraded'
        ? failure?.technicalCause ?? own.technicalCause ?? 'unknown'
        : null,
    provider:
      technical === 'failed' || technical === 'degraded'
        ? failure?.provider ?? own.provider
        : null,
    recoveryAction:
      technical === 'failed' || technical === 'degraded'
        ? failure?.recoveryAction ?? own.recoveryAction ?? 'manual_review'
        : null,
  };
}

function summary(
  technical: TechnicalOutcome,
  business: BusinessOutcome,
  reason: string | null,
  code: string | null,
  score: number | null,
  emittedEvent: string | null,
  causeInfo: TechnicalCauseInfo,
): OutcomeSummary {
  const hasTechnicalIssue = technical === 'failed' || technical === 'degraded';
  return {
    technical,
    business,
    reason,
    code,
    score,
    emittedEvent,
    technicalCause: hasTechnicalIssue ? causeInfo.cause : null,
    provider: hasTechnicalIssue ? causeInfo.provider : null,
    recoveryAction: hasTechnicalIssue ? causeInfo.recoveryAction : null,
  };
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function collectFacts(value: unknown): {
  events: string[];
  codes: string[];
  errors: string[];
  overallStatuses: string[];
  warnings: string[];
  ok: boolean | null;
  score: number | null;
} {
  const events = new Set<string>();
  const codes = new Set<string>();
  const errors = new Set<string>();
  const overallStatuses = new Set<string>();
  const warnings = new Set<string>();
  let ok: boolean | null = null;
  let score: number | null = null;
  const seen = new Set<object>();

  const visit = (raw: unknown, depth: number) => {
    const current = parse(raw);
    if (depth > 5 || current == null || typeof current !== 'object') return;
    if (seen.has(current as object)) return;
    seen.add(current as object);
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 100)) visit(item, depth + 1);
      return;
    }
    for (const [key, rawValue] of Object.entries(current as Record<string, unknown>)) {
      const value = parse(rawValue);
      if ((key === 'ok' || key === 'success') && typeof value === 'boolean' && ok == null) ok = value;
      if (
        ['eventName', 'event_name', 'emittedEvent', 'emitted_event'].includes(key) &&
        typeof value === 'string' &&
        /^[A-Z][A-Z0-9_]+$/.test(value)
      ) events.add(value);
      if (['error_code', 'errorCode', 'code'].includes(key) && typeof value === 'string') codes.add(value);
      if (['error', 'error_message', 'errorMessage', 'detail', 'reason'].includes(key)) {
        if (typeof value === 'string' && value.trim()) errors.add(value.trim());
        else if (value && typeof value === 'object') {
          const message = (value as Record<string, unknown>).message;
          if (typeof message === 'string' && message.trim()) errors.add(message.trim());
        }
      }
      if (['overall_status', 'overallStatus', 'result', 'verdict'].includes(key) && typeof value === 'string') {
        overallStatuses.add(value);
      }
      if (['technical_warnings', 'technicalWarnings', 'warnings'].includes(key) && Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string' && item.trim()) warnings.add(item.trim());
      }
      if (
        score == null &&
        ['matching_score', 'matchScore', 'score', 'overall_match_score'].includes(key) &&
        typeof value === 'number' &&
        Number.isFinite(value)
      ) score = value;
      if (value && typeof value === 'object') visit(value, depth + 1);
    }
  };
  visit(value, 0);
  return {
    events: [...events],
    codes: [...codes],
    errors: [...errors],
    overallStatuses: [...overallStatuses],
    warnings: [...warnings],
    ok,
    score,
  };
}

function businessFromEvents(events: string[]): BusinessOutcome | null {
  const hasRejected = events.some((event) => BUSINESS_REJECT_EVENTS.has(event));
  const hasPassed = events.some((event) => BUSINESS_PASS_EVENTS.has(event));
  if (hasRejected && hasPassed) return 'mixed';
  if (hasRejected) return 'rejected';
  if (hasPassed) return 'passed';
  return null;
}

function worstTechnical(values: TechnicalOutcome[]): TechnicalOutcome {
  const rank: Record<TechnicalOutcome, number> = {
    healthy: 0,
    running: 1,
    degraded: 2,
    cancelled: 3,
    failed: 4,
  };
  return values.reduce((worst, value) => (rank[value] > rank[worst] ? value : worst), 'healthy');
}

function combineBusiness(values: BusinessOutcome[]): BusinessOutcome {
  const meaningful = values.filter((value) => !['not_applicable', 'unknown'].includes(value));
  if (meaningful.includes('blocked')) return 'blocked';
  if (meaningful.includes('pending')) return 'pending';
  if (meaningful.includes('mixed')) return 'mixed';
  const passed = meaningful.includes('passed');
  const rejected = meaningful.includes('rejected');
  if (passed && rejected) return 'mixed';
  if (rejected) return 'rejected';
  if (passed) return 'passed';
  return 'not_applicable';
}
