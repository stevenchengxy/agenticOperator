// Technical execution and business outcome are deliberately separate axes.
//
// A MATCH_FAILED event can be the correct output of a perfectly healthy run,
// while a vendor timeout means the business decision was never produced even
// if some handler accidentally returned `{ ok:false }` instead of throwing.
// Monitor, Events and Flow tracking all use this module so the distinction is
// consistent everywhere.

export type TechnicalOutcome = 'healthy' | 'degraded' | 'failed' | 'running' | 'cancelled';
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
};

export type RunOutcomeInput = {
  status: string;
  functionSlug?: string | null;
  triggerEvent?: string | null;
  output?: unknown;
  dependencyFailure?: { reason?: string | null; detail?: string | null; provider?: string | null } | null;
};

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

  if (status === 'RUNNING' || status === 'SCHEDULED' || status === 'QUEUED') {
    return summary('running', 'pending', reason, code, facts.score, emitted);
  }
  if (status === 'FAILED') {
    return summary('failed', 'blocked', reason, code, facts.score, emitted);
  }
  if (status === 'CANCELLED' || status === 'CANCELED') {
    return summary('cancelled', 'blocked', reason, code, facts.score, emitted);
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
    return summary('degraded', 'blocked', reason, code, facts.score, emitted);
  }
  if (input.dependencyFailure) {
    return summary('degraded', businessRejection ? 'rejected' : 'blocked', reason, code, facts.score, emitted);
  }
  const completedTechnical: TechnicalOutcome = facts.warnings.length > 0 ? 'degraded' : 'healthy';
  const completedReason = facts.warnings[0] ?? reason;
  if (mixed) return summary(completedTechnical, 'mixed', completedReason, code, facts.score, emitted);
  if (businessRejection) return summary(completedTechnical, 'rejected', completedReason, code, facts.score, emitted);
  if (passed) return summary(completedTechnical, 'passed', completedReason, code, facts.score, emitted);

  // Interview failures with a vendor/system code are technical blocks. A
  // GoHire rejection is handled above as a healthy execution + rejected
  // business outcome.
  if (code && TECHNICAL_ERROR_CODES.test(code)) {
    return summary('degraded', 'blocked', reason, code, facts.score, emitted);
  }

  return summary(completedTechnical, 'not_applicable', completedReason, code, facts.score, emitted);
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
    return { ...own, technical: eventTechnical, business: eventBusiness, code };
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
  };
}

function summary(
  technical: TechnicalOutcome,
  business: BusinessOutcome,
  reason: string | null,
  code: string | null,
  score: number | null,
  emittedEvent: string | null,
): OutcomeSummary {
  return { technical, business, reason, code, score, emittedEvent };
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
