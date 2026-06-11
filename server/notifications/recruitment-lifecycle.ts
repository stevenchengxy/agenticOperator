// 把招聘 agent 的业务节点收成统一的「消息」通知。文案 / canonical short 映射 /
// 幂等都集中在这里，避免在 6 个 emit 点复制 recordNotification 块。
//
// 设计约束：固定 level:'info' → kind=message、不推红点；绝不传 eventName → 由
// anchors 驱动 candidate/job 分类；step.run 包裹 → Inngest 重试不会重复落消息行。

import { recordNotification } from './ingest';
import { displayNameFor } from '@/lib/agent-display-names';

export type RecruitmentSignal =
  | 'RESUME_PROCESSED'
  | 'MATCH_RULE_CHECK_PASSED'
  | 'MATCH_RULE_CHECK_FAILED'
  | 'MATCH_PASSED_NEED_INTERVIEW'
  | 'MATCH_FAILED'
  | 'JD_GENERATED'
  | 'INTERVIEW_INVITATION_SENT';

const COPY: Record<RecruitmentSignal, string> = {
  RESUME_PROCESSED: '简历解析完成',
  MATCH_RULE_CHECK_PASSED: '候选人已通过规则校验',
  MATCH_RULE_CHECK_FAILED: '候选人未通过规则校验',
  MATCH_PASSED_NEED_INTERVIEW: '候选人匹配通过，待安排面试',
  MATCH_FAILED: '候选人匹配未通过',
  JD_GENERATED: '职位描述已生成',
  INTERVIEW_INVITATION_SENT: '面试邀约已发送',
};

const AGENT_SHORT: Record<RecruitmentSignal, string> = {
  RESUME_PROCESSED: 'ResumeParser',
  MATCH_RULE_CHECK_PASSED: 'RuleCheck',
  MATCH_RULE_CHECK_FAILED: 'RuleCheck',
  MATCH_PASSED_NEED_INTERVIEW: 'Matcher',
  MATCH_FAILED: 'Matcher',
  JD_GENERATED: 'JDGenerator',
  INTERVIEW_INVITATION_SENT: 'InterviewInviter',
};

interface Ctx {
  anchors: Record<string, string | null | undefined>;
  runId?: string | null;
  traceId?: string | null;
}

type StepRun = { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> };

// 长 id 截短展示(候选人/岗位 id 是数据值,允许出现在 UI;>16 字符截 8 位)。
function shortId(v: string): string {
  return v.length > 16 ? `${v.slice(0, 8)}…` : v;
}

// 把主体(谁的简历/哪个岗位)拼进标题 — 不然 N 条"面试邀约已发送"在列表里
// 一模一样,无法区分(2026-06-11 审计)。优先人名,缺省回落 id。
export function subjectSuffix(anchors: Record<string, string | null | undefined>): string {
  const parts: string[] = [];
  const name = anchors.candidate_name;
  const cid = anchors.candidate_id;
  if (typeof name === 'string' && name.trim()) parts.push(name.trim());
  else if (typeof cid === 'string' && cid.trim()) parts.push(`候选人 ${shortId(cid)}`);
  const jr = anchors.job_requisition_id;
  if (typeof jr === 'string' && jr.trim()) parts.push(`岗位 ${shortId(jr)}`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

export async function notifyRecruitmentLifecycle(
  step: StepRun,
  signal: RecruitmentSignal,
  ctx: Ctx,
): Promise<void> {
  const short = AGENT_SHORT[signal];
  await step.run(`notify:${signal}`, async () => {
    try {
      await recordNotification({
        level: 'info',
        category: 'agent_lifecycle',
        source: displayNameFor(short, 'zh'),
        agent: short,
        message: `${COPY[signal]}${subjectSuffix(ctx.anchors)}`,
        runId: ctx.runId ?? null,
        traceId: ctx.traceId ?? null,
        anchors: ctx.anchors,
        signal, // 外部通道(企微)按信号白名单决定是否推送
      });
    } catch {
      /* fire-and-forget: a notification failure must never break the agent */
    }
    return null;
  });
}
