# 招聘 lifecycle → 通知中心「消息」接线 设计

> **日期**: 2026-06-04
> **状态**: 已批准设计，待写实现计划
> **覆盖范围**: 把招聘 agent 的业务节点（简历解析完成 / 规则校验通过·未通过 / 匹配 / JD 生成 / 面试邀约）接进消息通知中心的「消息」段，点亮 candidate / job 分类。纯加调用点，不改任何判定或业务逻辑。
> **前置**: [2026-06-01 通知中心 + 审计完整性设计](2026-06-01-notification-center-and-audit-completeness-design.md)（地基 spec：Notification 表、derive/ingest、UI、rule-check 止血均已落地）。

## 1. 背景与缺口

通知中心的**地基已全部就绪**：`Notification` 表、`server/notifications/derive.ts`（确定性派生）、`server/notifications/ingest.ts` 的 `recordNotification(input)`、`/api/notifications`（含域分区）、`components/notifications/` UI（5 类 chip：系统/智能体/事件/候选人/岗位）。

但**采集端只有 `agent_error` 一个业务调用点**（`server/log/log-event.ts:170`）。没有任何业务 lifecycle 信号带着 anchors 调进 `recordNotification` → **candidate / job 两个 chip 永远是空的**。（event chip 已由 energy/feikong 闸口 `server/inngest/domains/energy/make-agent.ts:168` 填充。）

本设计补的就是这根线：在招聘 agent 已有的 `step.sendEvent` 旁，把同样的业务节点收成一条「消息」通知。

## 2. 派生层的既有语义（设计约束，不改）

`server/notifications/derive.ts` 的两条规则决定了接线方式，**必须顺着它来，不修改 derive**：

- **kind 判定** (`deriveNotification:159`)：`isAlert = level ∈ {error, critical, warn}`。只有 `info / notice` 才走 message 分支（`shouldNotify=false`，不推红点）。
- **category 判定** (`categoryOf:96`)：优先级为 `system 源/类` → `event_publish 类或 eventName 存在` → `anchors.candidate_id` → `anchors.job_requisition_id` → `agent`。

**关键推论**：要让一条招聘 lifecycle 落到 **candidate / job** chip 且**不推红点**，调用必须满足：

1. `level: 'info'` → kind=message、`shouldNotify=false`；
2. **不传 `eventName`**（否则 `categoryOf` 第二条直接归 `event`，candidate/job 永远点不亮）；
3. 传 `anchors`：带 `candidate_id` → candidate chip；只带 `job_requisition_id` → job chip。

深链由 `resolveLink` 用现成的 `runId`/`traceId` 解析为 `run`/`trace` 单条过程页，无需额外字段。

## 3. 方案：单一收口 helper

新增 `server/notifications/recruitment-lifecycle.ts`，把**文案 + 分类规则 + 幂等**集中一处（而非 7 处复制 `recordNotification` 块）：

```ts
// 把招聘 agent 的业务节点收成统一的「消息」通知。所有文案/分类规则集中在这里。
// 固定 level:'info' → kind=message、不推红点；不传 eventName → 由 anchors 驱动
// candidate/job 分类；深链走 runId/traceId。

import type { Inngest } from 'inngest';
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

// 业务中文文案，无开发者术语（遵守 no-jargon 约定）。
const COPY: Record<RecruitmentSignal, string> = {
  RESUME_PROCESSED: '简历解析完成',
  MATCH_RULE_CHECK_PASSED: '候选人已通过规则校验',
  MATCH_RULE_CHECK_FAILED: '候选人未通过规则校验',
  MATCH_PASSED_NEED_INTERVIEW: '候选人匹配通过，待安排面试',
  MATCH_FAILED: '候选人匹配未通过',
  JD_GENERATED: '职位描述已生成',
  INTERVIEW_INVITATION_SENT: '面试邀约已发送',
};

interface Ctx {
  agent: string;                 // AGENT_NAME，用于解析双语短名 + 写 agent 字段
  anchors: Record<string, string | null | undefined>; // candidate_id / job_requisition_id / upload_id ...
  runId?: string | null;
  traceId?: string | null;
}

export async function notifyRecruitmentLifecycle(
  step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> },
  signal: RecruitmentSignal,
  ctx: Ctx,
): Promise<void> {
  // step.run 让 Inngest 记忆化 → 重试不会重复落消息行（message 的 dedupeKey=null，
  // 不包就会每次 handler 调用都插一行）。这是 energy make-agent.ts:168 已确立的模式。
  await step.run(`notify:${signal}`, async () => {
    await recordNotification({
      level: 'info',                         // → kind=message, shouldNotify=false（不推红点）
      category: 'agent_lifecycle',
      source: displayNameFor(ctx.agent, 'zh'), // 业务短名，不直出函数名
      agent: ctx.agent,
      message: COPY[signal],
      runId: ctx.runId ?? null,
      traceId: ctx.traceId ?? null,
      anchors: ctx.anchors,                   // 不传 eventName → anchors 驱动 candidate/job 分类
    });
    return null;
  });
}
```

`recordNotification` 本身 never-throws、fire-and-forget；helper 仍用 `step.run` 包一层只为幂等，不为错误传播。

## 4. 接线点（7 处，每处一行 helper 调用）

紧邻已有 `step.sendEvent`，anchors 均已确认本地可得：

| Agent 文件:行 | signal | 落到 chip | 本地 anchors |
|---|---|---|---|
| `resume-parser-agent.ts:391` | RESUME_PROCESSED | candidate | upload_id, candidate_id, resume_id, client_id |
| `rule-check-agent.ts:554` | MATCH_RULE_CHECK_PASSED | candidate | candidate_id, job_requisition_id, upload_id |
| `rule-check-agent.ts:621` | MATCH_RULE_CHECK_FAILED | candidate | candidate_id, job_requisition_id, upload_id |
| `create-jd-agent.ts:370` | JD_GENERATED | job | job_requisition_id, client_id |
| `match-resume-agent.ts:241` | MATCH_PASSED_NEED_INTERVIEW / MATCH_FAILED | candidate | candidate_id, job_requisition_id, upload_id |
| `interview-inviter-agent.ts:460` | INTERVIEW_INVITATION_SENT | candidate | candidate_id, job_requisition_id, application_id |

> 说明：`match-resume-agent.ts:241` 是 PASSED/FAILED 二选一分支，对应两个 `step.run` id（`notify:MATCH_PASSED_NEED_INTERVIEW` / `notify:MATCH_FAILED`），互不冲突。每个 signal 在各自函数内 id 唯一。

## 5. 已决定的设计点

- **"未通过"是静默消息**：`MATCH_RULE_CHECK_FAILED` / `MATCH_FAILED` 用 `level:'info'` → message、不推红点、落 candidate chip。与 2026-06-01 spec §9.1 + 验收 #7 立场一致——业务"未通过"是正常结果，不是预警。（用户已确认采用此方案，而非升级成 warning 预警。）
- **event chip 不靠招聘**：招聘 lifecycle 全部落 candidate/job；event chip 由 energy/feikong 闸口（已接）填充。系统级三 chip 因此都有内容。

## 6. 不做（YAGNI / 超范围）

- ❌ **不动 domain 传播**。招聘事件源自 RAAS，本地无 domain；`recordNotification` 不传 domain → 落 `domain=null`，已被 `app/api/notifications/route.ts` 的 `domainScopeWhere` 折进招聘默认域，chip 照常可见。（招聘 agent 报错/系统通知的 domain=null 归属问题是独立议题，不在本轮。）
- ❌ **不加 run 起止**（handler.start / handler.end）。那是 `agent` 类、需中央 wrapper，本轮不碰。
- ❌ **不改 rule-check 真实 FAIL 的 partner 写 / emit `MATCH_RULE_CHECK_FAILED`**。本设计只在其旁**加**一条 message，原路径零改动（2026-06-01 spec 验收 #7 零回归）。
- ❌ 不改 derive/ingest/route/UI/i18n（地基已支持 message 类 + candidate/job 分类）。

## 7. 测试

- **helper 单测** (`recruitment-lifecycle.test.ts`)：mock `step.run`（直接执行 fn）+ spy `recordNotification`。断言每个 signal →
  - `level:'info'`、`category:'agent_lifecycle'`、**不带 `eventName`**；
  - 文案为对应中文；`source` 为双语短名。
- **derive 回归测**（补 `derive.test.ts`）：`category:'agent_lifecycle'` + anchors-only（无 eventName）→ candidate（带 candidate_id）/ job（仅 job_requisition_id），kind=message、shouldNotify=false。
- **一个 agent 集成测**（resume-parser）：mock step，断言 emit RESUME_PROCESSED 后 `notifyRecruitmentLifecycle` 被调、anchors 带 candidate_id。沿用 rule-check-agent 既有测试的 step-mock 模式。

## 8. 验收标准

1. 跑通一条招聘流水后，通知中心**候选人 chip** 出现「简历解析完成 / 候选人已通过规则校验 / 候选人匹配通过…」等消息，**岗位 chip** 出现「职位描述已生成」。
2. 这些消息都在「消息」段、**不推红点**（不进「预警」段、不计入 needsHuman）。
3. 每条可点击跳到对应 `/monitor/runs/[id]`（或 trace）单条过程。
4. **零回归**：rule-check 真实 FAIL 的 partner 写 + emit 不变；run 重试不产生重复消息行（step.run 幂等）；`npm test` 全绿；`npm run build` 通过。

## 9. 改动文件清单

| 类型 | 文件 |
|---|---|
| 新增 | `server/notifications/recruitment-lifecycle.ts`、`server/notifications/recruitment-lifecycle.test.ts` |
| 改动 | `resume-parser-agent.ts` · `rule-check-agent.ts` · `create-jd-agent.ts` · `match-resume-agent.ts` · `interview-inviter-agent.ts`（各加 import + 1 行 helper 调用）· `server/notifications/derive.test.ts`（补回归用例） |

## 10. 未决问题

无——范围、机制、"未通过"静默策略均已与用户确认。实现细节（helper 的 step 类型签名精度、resume-parser 集成测的 mock 深度）在 writing-plans 阶段细化。
