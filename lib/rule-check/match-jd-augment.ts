// 把规则检查结论打包进发给简历评分服务(RoboHire)的 JD 文本(2026-06-12,领导要求)。
//
// 背景:RoboHire match-resume 只收 { resume, jd } 两段纯文本,没有第三个字段。
// 规则检查的本质是「这个岗位的用人约束」—— 语义上属于 JD 侧,所以把本次候选人的
// 预检结论(逐条规则:通过/不触发/信息不足 + 依据)作为明确标注的文本块追加在
// jd 末尾,深度匹配的模型把它当作岗位要求的一部分来比对。接口形状不变。
//
// 护栏:单条依据 ≤200 字、整块 ≤2000 字(超出截断 + 标注省略);空结论不追加;
// 块头标「系统注入·非岗位 JD 原文」防止被误读成岗位描述本身。

export interface JdRuleLine {
  rule_id: string;
  rule_name: string;
  status: string; // RuleStatus: pass / fail / not_triggered / pending / insufficient_info / unevaluated…
  reason?: string;
}

const STATUS_ZH: Record<string, string> = {
  pass: '通过',
  fail: '未通过',
  not_triggered: '不触发',
  pending: '待复核',
  insufficient_info: '信息不足',
  unevaluated: '未能评估',
};

const BLOCK_MAX = 2000;
const REASON_MAX = 200;

export function formatRuleCheckBlockForJd(rules: JdRuleLine[]): string {
  const header =
    '\n\n────────────────────────\n' +
    '【入岗前规则检查结论 · 系统注入,非岗位 JD 原文】\n' +
    `本候选人已通过该岗位的入岗前规则检查(共评估 ${rules.length} 条),逐条结论与依据如下,供深度匹配参考:\n`;
  const lines: string[] = [];
  let used = header.length + 40; // 预留尾部
  for (const r of rules) {
    const status = STATUS_ZH[r.status] ?? r.status;
    const reason = (r.reason ?? '').slice(0, REASON_MAX);
    const line = `- ${r.rule_id} ${r.rule_name}:${status}${reason ? ` — ${reason}` : ''}`;
    if (used + line.length + 1 > BLOCK_MAX) {
      lines.push(`-(其余 ${rules.length - lines.length} 条省略)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return (header + lines.join('\n') + '\n────────────────────────').slice(0, BLOCK_MAX + header.length);
}

/** JD 原文 + 规则检查块。无结论(空/缺)→ 原样返回。 */
export function appendRuleCheckToJd(jdText: string, rules: JdRuleLine[] | undefined | null): string {
  if (!rules || rules.length === 0) return jdText;
  return jdText + formatRuleCheckBlockForJd(rules);
}
