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
        message: COPY[signal],
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
