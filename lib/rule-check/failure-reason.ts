export type RuleCheckFailureKind =
  | 'rule'
  | 'insufficient'
  | 'review'
  | 'infra'
  | 'parse'
  | 'unknown';

export type FailureFlagLike = {
  rule_id?: string | null;
  rule_name_snapshot?: string | null;
  result?: string | null;
  next_action?: string | null;
  evidence?: string | null;
  applicable?: boolean | null;
};

export type ParsedFailureReason = {
  raw: string;
  ruleId: string | null;
  ruleName: string | null;
  detail: string;
};

const INFO_GAP_RE =
  /信息不足|缺乏|缺少|为空|无法判断|无法检索|无法确认|需补充|补充.*信息|missing|insufficient|supplement/i;
const REVIEW_RE = /人工复核|待复核|需复核|HSM|review|pending/i;

export function parseFailureReason(raw: string): ParsedFailureReason {
  const text = (raw ?? '').trim();
  const match = text.match(/^\[([^\]]+)\]\s*([^:：]+)?(?:[:：]\s*)?(.*)$/);
  if (!match) {
    return { raw: text, ruleId: null, ruleName: null, detail: text };
  }
  const [, ruleId, namePart, detailPart] = match;
  const ruleName = (namePart ?? '').trim() || null;
  const detail = (detailPart ?? '').trim() || ruleName || text;
  return {
    raw: text,
    ruleId: ruleId.trim(),
    ruleName,
    detail,
  };
}

export function isBlockingFlag(flag: FailureFlagLike): boolean {
  const result = (flag.result ?? '').toUpperCase();
  const action = (flag.next_action ?? '').toLowerCase();
  return (
    result === 'FAIL' ||
    result === 'INSUFFICIENT_INFO' ||
    result === 'REVIEW' ||
    result === 'PENDING' ||
    action === 'block' ||
    action === 'supplement' ||
    action === 'review'
  );
}

export function classifyFailureKind(
  reason: string | null | undefined,
  flag?: FailureFlagLike | null,
): RuleCheckFailureKind {
  const result = (flag?.result ?? '').toUpperCase();
  const action = (flag?.next_action ?? '').toLowerCase();
  const text = reason ?? '';

  if (result === 'INSUFFICIENT_INFO' || action === 'supplement' || INFO_GAP_RE.test(text)) {
    return 'insufficient';
  }
  if (result === 'REVIEW' || result === 'PENDING' || action === 'review' || REVIEW_RE.test(text)) {
    return 'review';
  }
  if (result === 'FAIL' || action === 'block') {
    return 'rule';
  }
  return text ? 'rule' : 'unknown';
}
