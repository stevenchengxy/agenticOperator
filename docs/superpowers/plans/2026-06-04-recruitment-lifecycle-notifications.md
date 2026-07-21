# 招聘 lifecycle → 通知中心「消息」接线 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在招聘 6 个 agent emit 点旁记录一条 info 级「消息」通知，点亮通知中心的「候选人 / 岗位」分类 chip。

**Architecture:** 新增单一收口 helper `notifyRecruitmentLifecycle(step, signal, ctx)`，固定 `level:'info'`（→ kind=message、不推红点）、不传 `eventName`（→ 由 anchors 驱动 candidate/job 分类）、用 `step.run` 包裹保证 Inngest 重试幂等。文案 + agent 短名映射集中在 helper 内，6 个 agent emit 点各加一行调用。不改 derive/ingest/route/UI。

**Tech Stack:** TypeScript · Inngest（step.run 幂等）· Prisma（Notification 表，经 `recordNotification`）· vitest。

**前置 spec:** [docs/superpowers/specs/2026-06-04-recruitment-lifecycle-notifications-design.md](../specs/2026-06-04-recruitment-lifecycle-notifications-design.md)

**重要约定:**
- 全程在 `main` 上做，**不开 worktree**（见 [[feedback_no_ao_worktrees]]）。
- commit 用 pathspec 形式：`git commit -m "..." -- <files>`（pre-commit hook 会 re-stage 所有改动，见 [[feedback_commit_with_pathspec]]）。**选项必须在 `--` 之前**。
- 不要 push（见 [[feedback_push_kenny_steven_only]]）。

---

## 关键设计约束（实现前必读）

`server/notifications/derive.ts` 的两条既有规则**不改**，顺着它接线：

1. **kind**：`deriveNotification` 里 `isAlert = level ∈ {error,critical,warn}`；只有 `info/notice` 走 message 分支（`shouldNotify=false`）。→ 所以全部传 `level:'info'`。
2. **category**（`categoryOf`）：优先级 `system` → `event_publish 或 eventName 存在` → `anchors.candidate_id` → `anchors.job_requisition_id` → `agent`。→ 所以**绝不能传 `eventName`**，否则全归 `event`，candidate/job 永远点不亮。

`displayNameFor(idOrShort, lang)` 只认 **PascalCase canonical short**（`'RuleCheck'`）或 **inngest slug**（`'rule-check-agent'`）。agent 文件里用的 `'ruleCheck'`/`'resumeParser'` **两者都不匹配**，会原样返回。→ 所以 helper **由 signal 推导 canonical short**，不依赖 caller 传 agent。

---

## File Structure

| 类型 | 文件 | 职责 |
|---|---|---|
| 新增 | `server/notifications/recruitment-lifecycle.ts` | 收口 helper：signal→文案+canonical short 映射、固定 info+无 eventName、step.run 幂等 |
| 新增 | `server/notifications/recruitment-lifecycle.test.ts` | helper 单测 |
| 改动 | `server/notifications/derive.test.ts` | 补回归：agent_lifecycle + anchors-only → candidate/job |
| 改动 | `server/inngest/agents/resume-parser-agent.ts` | RESUME_PROCESSED emit 后加调用 |
| 改动 | `server/inngest/agents/rule-check-agent.ts` | PASSED + FAILED 两处 emit 后加调用 |
| 改动 | `server/inngest/agents/create-jd-agent.ts` | JD_GENERATED emit 后加调用 |
| 改动 | `server/inngest/agents/match-resume-agent.ts` | MATCH_PASSED_NEED_INTERVIEW / MATCH_FAILED emit 后加调用 |
| 改动 | `server/inngest/agents/interview-inviter-agent.ts` | INTERVIEW_INVITATION_SENT emit 后加调用 |
| 改动 | `server/inngest/agents/resume-parser-agent.test.ts` | 集成测：emit 后 helper 被调、anchors 带 candidate_id |

---

## Chunk 1: helper + 接线

### Task 1: 新建 helper（TDD）

**Files:**
- Create: `server/notifications/recruitment-lifecycle.ts`
- Test: `server/notifications/recruitment-lifecycle.test.ts`

- [ ] **Step 1: 写失败测试**

`server/notifications/recruitment-lifecycle.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 拦截 recordNotification，断言传入的 CaptureInput。
const recordNotification = vi.fn(async () => ({ id: 'n1' }));
vi.mock('./ingest', () => ({ recordNotification: (...a: unknown[]) => recordNotification(...a) }));

import { notifyRecruitmentLifecycle } from './recruitment-lifecycle';

// mock step.run：直接执行 fn（模拟 Inngest 记忆化的同步路径）。
function mockStep() {
  const ids: string[] = [];
  return {
    ids,
    run: async (id: string, fn: () => Promise<unknown>) => {
      ids.push(id);
      return await fn();
    },
  };
}

describe('notifyRecruitmentLifecycle', () => {
  beforeEach(() => recordNotification.mockClear());

  it('候选人类信号 → level info、agent_lifecycle、不带 eventName、中文文案、candidate anchors', async () => {
    const step = mockStep();
    await notifyRecruitmentLifecycle(step, 'RESUME_PROCESSED', {
      anchors: { candidate_id: 'c1', upload_id: 'u1' },
      runId: 'r1',
      traceId: 't1',
    });
    expect(step.ids).toEqual(['notify:RESUME_PROCESSED']);
    expect(recordNotification).toHaveBeenCalledTimes(1);
    const arg = recordNotification.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.level).toBe('info');
    expect(arg.category).toBe('agent_lifecycle');
    expect(arg.eventName).toBeUndefined();          // 关键：绝不传 eventName
    expect(arg.message).toBe('简历解析完成');
    expect(arg.source).toBe('简历解析');             // displayNameFor('ResumeParser','zh')
    expect(arg.agent).toBe('ResumeParser');
    expect(arg.anchors).toEqual({ candidate_id: 'c1', upload_id: 'u1' });
    expect(arg.runId).toBe('r1');
    expect(arg.traceId).toBe('t1');
  });

  it('JD_GENERATED → 岗位文案 + JDGenerator 短名', async () => {
    const step = mockStep();
    await notifyRecruitmentLifecycle(step, 'JD_GENERATED', {
      anchors: { job_requisition_id: 'jr1' },
    });
    const arg = recordNotification.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.message).toBe('职位描述已生成');
    expect(arg.agent).toBe('JDGenerator');
    expect(arg.source).toBe('JD 生成');
  });

  it('每个 signal 都有文案且 step id 唯一', async () => {
    const signals = [
      'RESUME_PROCESSED', 'MATCH_RULE_CHECK_PASSED', 'MATCH_RULE_CHECK_FAILED',
      'MATCH_PASSED_NEED_INTERVIEW', 'MATCH_FAILED', 'JD_GENERATED', 'INTERVIEW_INVITATION_SENT',
    ] as const;
    for (const s of signals) {
      recordNotification.mockClear();
      const step = mockStep();
      await notifyRecruitmentLifecycle(step, s, { anchors: { candidate_id: 'c' } });
      const arg = recordNotification.mock.calls[0][0] as Record<string, unknown>;
      expect(typeof arg.message).toBe('string');
      expect((arg.message as string).length).toBeGreaterThan(0);
      expect(step.ids[0]).toBe(`notify:${s}`);
    }
  });

  it('recordNotification 抛错不向上冒泡（fire-and-forget）', async () => {
    recordNotification.mockRejectedValueOnce(new Error('db down'));
    const step = mockStep();
    await expect(
      notifyRecruitmentLifecycle(step, 'MATCH_FAILED', { anchors: { candidate_id: 'c' } }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/notifications/recruitment-lifecycle.test.ts`
Expected: FAIL —「Cannot find module './recruitment-lifecycle'」或「notifyRecruitmentLifecycle is not a function」。

- [ ] **Step 3: 写最小实现**

`server/notifications/recruitment-lifecycle.ts`：

```ts
// 把招聘 agent 的业务节点收成统一的「消息」通知。文案 / canonical short 映射 /
// 幂等都集中在这里，避免在 6 个 emit 点复制 recordNotification 块。
//
// 设计约束（见 spec §2）：固定 level:'info' → kind=message、不推红点；绝不传
// eventName → 由 anchors 驱动 candidate/job 分类；step.run 包裹 → Inngest 重试
// 不会重复落消息行（message 的 dedupeKey=null，不包就会每次 handler 调用都插一行）。

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

// 业务中文文案，无开发者术语（遵守 [[feedback_ao_no_dev_jargon_ui]]）。
const COPY: Record<RecruitmentSignal, string> = {
  RESUME_PROCESSED: '简历解析完成',
  MATCH_RULE_CHECK_PASSED: '候选人已通过规则校验',
  MATCH_RULE_CHECK_FAILED: '候选人未通过规则校验',
  MATCH_PASSED_NEED_INTERVIEW: '候选人匹配通过，待安排面试',
  MATCH_FAILED: '候选人匹配未通过',
  JD_GENERATED: '职位描述已生成',
  INTERVIEW_INVITATION_SENT: '面试邀约已发送',
};

// signal → 拥有它的 agent 的 canonical short（PascalCase），供 displayNameFor 解析
// 中文短名。agent 文件里用的 'ruleCheck'/'resumeParser' 不被 displayNameFor 识别。
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
  anchors: Record<string, string | null | undefined>; // candidate_id / job_requisition_id / upload_id …
  runId?: string | null;
  traceId?: string | null;
}

// 最小 step 形状 —— 只用到 step.run（Inngest StepTools 的子集）。
type StepRun = { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> };

export async function notifyRecruitmentLifecycle(
  step: StepRun,
  signal: RecruitmentSignal,
  ctx: Ctx,
): Promise<void> {
  const short = AGENT_SHORT[signal];
  await step.run(`notify:${signal}`, async () => {
    await recordNotification({
      level: 'info',                       // → kind=message, shouldNotify=false（不推红点）
      category: 'agent_lifecycle',
      source: displayNameFor(short, 'zh'), // 业务短名，不直出函数名
      agent: short,
      message: COPY[signal],
      runId: ctx.runId ?? null,
      traceId: ctx.traceId ?? null,
      anchors: ctx.anchors,                // 不传 eventName → anchors 驱动 candidate/job
    });
    return null;
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/notifications/recruitment-lifecycle.test.ts`
Expected: PASS（4 个用例全绿）。
> 若「候选人类信号」用例里 `source` 断言失败（返回 'ResumeParser' 而非 '简历解析'），说明 `displayNameFor` 没解析 PascalCase short——回去核对 `lib/agent-display-names.ts` 的 `AGENT_NAMES_ZH` 键名与 `AGENT_SHORT` 一致。

- [ ] **Step 5: commit**

```bash
git commit -m "feat(notifications): recruitment lifecycle notify helper

Single sink for the 6 recruitment emit sites: fixed level=info (message,
no badge ping), never passes eventName (anchors drive candidate/job
category), step.run-wrapped for Inngest retry idempotency.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- \
  server/notifications/recruitment-lifecycle.ts \
  server/notifications/recruitment-lifecycle.test.ts
```

---

### Task 2: derive 回归测（确认 anchors-only 不传 eventName 时归 candidate/job）

**Files:**
- Modify: `server/notifications/derive.test.ts`

- [ ] **Step 1: 加失败测试**

在 `server/notifications/derive.test.ts` 末尾的合适 describe 内追加（沿用文件已有 import；若文件无 `deriveNotification` import 则补上 `import { deriveNotification } from './derive';`）：

```ts
describe('agent_lifecycle 消息（招聘接线回归）', () => {
  it('带 candidate_id 且无 eventName → candidate 消息、不推红点', () => {
    const d = deriveNotification({
      level: 'info',
      category: 'agent_lifecycle',
      source: '简历解析',
      message: '简历解析完成',
      anchors: { candidate_id: 'c1', upload_id: 'u1' },
      runId: 'r1',
    })!;
    expect(d.kind).toBe('message');
    expect(d.category).toBe('candidate');
    expect(d.shouldNotify).toBe(false);
    expect(d.linkKind).toBe('run');
  });

  it('只带 job_requisition_id 且无 eventName → job 消息', () => {
    const d = deriveNotification({
      level: 'info',
      category: 'agent_lifecycle',
      source: 'JD 生成',
      message: '职位描述已生成',
      anchors: { job_requisition_id: 'jr1' },
      runId: 'r2',
    })!;
    expect(d.kind).toBe('message');
    expect(d.category).toBe('job');
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run server/notifications/derive.test.ts`
Expected: PASS（确认既有 derive 行为已满足接线需求，无需改 derive.ts）。
> 这是「保护性」回归测——证明接线方式与 derive 语义吻合。若失败说明对 derive 的理解有误，**停下来**重读 `categoryOf`，不要改 derive。

- [ ] **Step 3: commit**

```bash
git commit -m "test(notifications): derive regression for agent_lifecycle candidate/job

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- \
  server/notifications/derive.test.ts
```

---

### Task 3: 接线 resume-parser + 集成测

**Files:**
- Modify: `server/inngest/agents/resume-parser-agent.ts`（emit 在 :391）
- Modify: `server/inngest/agents/resume-parser-agent.test.ts`

- [ ] **Step 1: 加集成失败测试**

参考 `rule-check-agent.test.ts` 的 mock 模式（`createFunction` mock 返回 `{cfg,handler}`，mockStep 的 `run` 执行 fn、`sendEvent` 记录到 `sent`）。在 `resume-parser-agent.test.ts` 加一个用例，断言成功 emit RESUME_PROCESSED 后 `recordNotification` 被调且 anchors 带 candidate_id。

> 实现者注意：resume-parser 的 mock 链较长。**最小可行做法**——在该测试文件顶部加：
> ```ts
> const recordNotification = vi.fn(async () => ({ id: 'n1' }));
> vi.mock('@/server/notifications/recruitment-lifecycle', () => ({
>   notifyRecruitmentLifecycle: vi.fn(async (_step, signal, ctx) => { recordNotification(signal, ctx); }),
> }));
> ```
> 然后断言：跑完 handler 后 `recordNotification` 以 `('RESUME_PROCESSED', expect.objectContaining({ anchors: expect.objectContaining({ candidate_id: ... }) }))` 被调用一次。
> 若 resume-parser 现有测试文件尚无可复用的 handler 调用骨架，**优先复制 `rule-check-agent.test.ts` 的整体结构**再裁剪。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/inngest/agents/resume-parser-agent.test.ts`
Expected: FAIL —`recordNotification` 未被调用（接线还没加）。

- [ ] **Step 3: 加接线**

在 `resume-parser-agent.ts` 文件顶部 import 区加：
```ts
import { notifyRecruitmentLifecycle } from '@/server/notifications/recruitment-lifecycle';
```

在 `:391` 的 `await step.sendEvent('emit-resume-processed', {...})` **之后**加：
```ts
    await notifyRecruitmentLifecycle(step, 'RESUME_PROCESSED', {
      anchors: {
        candidate_id: saveResult.candidate_id,
        upload_id,
        resume_id: saveResult.resume_id,
        client_id: client_id ?? null,
      },
      runId: runId ?? null,
      traceId,
    });
```
（`runId` 来自 handler 参数 `async ({ event, step, logger, runId })`；`traceId` 在 :115 已声明。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/inngest/agents/resume-parser-agent.test.ts`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
git commit -m "feat(notifications): wire RESUME_PROCESSED → candidate message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- \
  server/inngest/agents/resume-parser-agent.ts \
  server/inngest/agents/resume-parser-agent.test.ts
```

---

### Task 4: 接线 rule-check（PASSED + FAILED）

**Files:**
- Modify: `server/inngest/agents/rule-check-agent.ts`（PASSED emit :554、FAILED emit :621）

- [ ] **Step 1: 加接线**

文件顶部 import 区加：
```ts
import { notifyRecruitmentLifecycle } from '@/server/notifications/recruitment-lifecycle';
```

在 `:554` 的 `await step.sendEvent(\`emit-passed-${stepKey}\`, {...})` **之后**加：
```ts
      await notifyRecruitmentLifecycle(step, 'MATCH_RULE_CHECK_PASSED', {
        anchors: { candidate_id: candidateId ?? null, job_requisition_id: jrid, upload_id: uploadId ?? null },
        runId: runId ?? null,
        traceId,
      });
```

在 `:621` 的 `await step.sendEvent(\`emit-failed-${stepKey}\`, {...})` **之后**加：
```ts
      await notifyRecruitmentLifecycle(step, 'MATCH_RULE_CHECK_FAILED', {
        anchors: { candidate_id: candidateId ?? null, job_requisition_id: jrid, upload_id: uploadId ?? null },
        runId: runId ?? null,
        traceId,
      });
```
（`candidateId`/`uploadId`/`jrid` 均在循环作用域内可得；`runId`/`traceId` 在 handler 顶部已声明，:360 的既有 recordNotification 已证明可用。）

- [ ] **Step 2: 跑既有 agent 测试确认无回归**

Run: `npx vitest run server/inngest/agents/rule-check-agent.test.ts`
Expected: PASS。既有用例断言 `step.sent` 含 PASSED/FAILED；新增的 `step.run('notify:…')` 不进 `sent`，不应破坏现有断言。
> 若现有测试用真实 `recordNotification`（未 mock）导致 DB 调用——在该测试文件确认 `@/server/db` 已被 mock（:56 已有 `notification.upsert/create` mock），则 helper 内的 `recordNotification` 走 mock 路径，安全。

- [ ] **Step 3: commit**

```bash
git commit -m "feat(notifications): wire rule-check PASSED/FAILED → candidate message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- \
  server/inngest/agents/rule-check-agent.ts
```

---

### Task 5: 接线 create-jd（JD_GENERATED → job）

**Files:**
- Modify: `server/inngest/agents/create-jd-agent.ts`（emit :370）

- [ ] **Step 1: 加接线**

import 区加 helper import。在 `:370` 的 `await step.sendEvent(\`emit-jd-generated-${sanitize(requisitionId)}\`, {...})` **之后**加：
```ts
    await notifyRecruitmentLifecycle(step, 'JD_GENERATED', {
      anchors: { job_requisition_id: requisitionId, client_id: clientId },
      runId: runId ?? null,
      traceId,
    });
```
（`requisitionId`/`clientId` 在作用域内；`runId` 来自 handler 参数 :113；`traceId` 在 :121 声明。**不带 candidate_id** → 归 job chip。）

- [ ] **Step 2: 跑测试**

Run: `npx vitest run server/inngest/agents/create-jd-agent.test.ts`
Expected: PASS（无回归）。

- [ ] **Step 3: commit**

```bash
git commit -m "feat(notifications): wire JD_GENERATED → job message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- \
  server/inngest/agents/create-jd-agent.ts
```

---

### Task 6: 接线 match-resume（PASSED/FAILED 二选一）

**Files:**
- Modify: `server/inngest/agents/match-resume-agent.ts`（emit :241，`eventName` 为变量）

- [ ] **Step 1: 加接线**

import 区加 helper import。在 `:241` 的 `await step.sendEvent(\`emit-match-${stepKey}\`, { name: eventName, data: payload })` **之后**加（用 `eventName` 决定 signal，仅当它是我们关心的两类时才记）：
```ts
    if (eventName === 'MATCH_PASSED_NEED_INTERVIEW' || eventName === 'MATCH_FAILED') {
      await notifyRecruitmentLifecycle(step, eventName, {
        anchors: { candidate_id: candidateId, job_requisition_id: data.job_requisition_id, upload_id: uploadId },
        runId: runId ?? null,
        traceId,
      });
    }
```
（`candidateId` :57、`uploadId` :58、`data.job_requisition_id`、`runId` 来自 handler :43、`traceId` :54 均在作用域内。`step.run` id `notify:${eventName}` 在该函数内唯一。）

> 说明：match 还可能 emit `MATCH_PASSED_NO_INTERVIEW`（见 AGENT_MAP），本轮不记（spec 范围只列了 PASSED_NEED_INTERVIEW / FAILED）；`if` 守卫确保只对这两类记，其它 emit 不受影响。

- [ ] **Step 2: 跑测试**

Run: `npx vitest run server/inngest/agents/match-resume-agent.test.ts` （若存在；否则跑全量 `npm test` 兜底）
Expected: PASS。

- [ ] **Step 3: commit**

```bash
git commit -m "feat(notifications): wire match PASSED_NEED_INTERVIEW/FAILED → candidate message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- \
  server/inngest/agents/match-resume-agent.ts
```

---

### Task 7: 接线 interview-inviter（INTERVIEW_INVITATION_SENT）

**Files:**
- Modify: `server/inngest/agents/interview-inviter-agent.ts`（emit :460）

- [ ] **Step 1: 加接线**

import 区加 helper import。在 `:460` 的 `await step.sendEvent(\`emit-invitation-sent-${stepKey}\`, {...})` **之后**加：
```ts
    await notifyRecruitmentLifecycle(step, 'INTERVIEW_INVITATION_SENT', {
      anchors: { candidate_id: candidateId, job_requisition_id: jrId, application_id: interviewRecordId },
      traceId: traceId ?? null,
    });
```
（`candidateId` :73、`jrId`、`interviewRecordId` 在作用域内；`traceId` :69 声明。此 handler 也有 `runId` 参数 :49——可一并传 `runId: runId ?? null`，建议加上以获得 run 深链。）

- [ ] **Step 2: 跑测试**

Run: `npx vitest run server/inngest/agents/interview-inviter-agent.test.ts`
Expected: PASS。

- [ ] **Step 3: commit**

```bash
git commit -m "feat(notifications): wire INTERVIEW_INVITATION_SENT → candidate message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- \
  server/inngest/agents/interview-inviter-agent.ts
```

---

### Task 8: 全量验证

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全绿（含新增 helper / derive 回归 / resume-parser 集成测 + 既有全部）。

- [ ] **Step 2: 生产构建（typecheck + lint）**

Run: `npm run build`
Expected: 构建成功，无 TS 错误、无 lint 错误。
> 重点看：helper 的 `StepRun` 类型与各 agent 传入的真实 `step` 兼容（Inngest 的 step 是 `StepRun` 的超集，结构兼容应通过）；6 个 import 路径 `@/server/notifications/recruitment-lifecycle` 正确。

- [ ] **Step 3: 收尾**

确认 `git status` 无遗漏未提交改动（除仓库本就存在的其它 WIP）。**不要 push**。

---

## 验收对照（实现完成后逐条核对）

1. ✅ 通知中心「候选人」chip 出现：简历解析完成 / 候选人已通过规则校验 / 候选人未通过规则校验 / 候选人匹配通过待安排面试 / 候选人匹配未通过 / 面试邀约已发送。
2. ✅ 「岗位」chip 出现：职位描述已生成。
3. ✅ 这些都在「消息」段、`shouldNotify=false`（不推红点、不进预警、不计 needsHuman）。
4. ✅ 每条可点击跳 `/monitor/runs/[id]`（或 trace）。
5. ✅ 零回归：rule-check 真实 FAIL 的 partner 写/emit 不变；重试不重复落消息（step.run 幂等）；`npm test` 全绿；`npm run build` 通过。
