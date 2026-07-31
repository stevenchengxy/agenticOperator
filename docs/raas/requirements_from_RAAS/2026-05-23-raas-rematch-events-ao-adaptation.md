# RaaS 重匹配事件 — agenticOperator 适配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt agenticOperator so the RaaS Web Console 的"更换关联岗位"和"匹配同序列岗位"两个功能发出的 `RESUME_PROCESSED` 事件能被桥接、通过 schema 校验、并由现有 `ruleCheckAgent → matchResumeAgent` 链路完成匹配与回写。

**Architecture:** RaaS outbox → RaaS Inngest 总线 → AO `raas-bridge` 拉取 → `em.publish` 入 AO 本地 Inngest → `ruleCheckAgent`(路径 A + thin-event 回查) → `matchResumeAgent` → partner-pg 写回 `candidate_match_result(_runtime_state)`。AO agent 链路零改动;仅改 3 处:env 配置、桥的内容过滤、`RESUME_PROCESSED` schema 的 `upload_id` 由必填改可选。

**Tech Stack:** TypeScript 5 / Next.js 16 / Vitest / Zod / Inngest / Prisma。

**关联设计文档:** [docs/superpowers/specs/2026-05-22-raas-rematch-events-ao-adaptation-design.md](../../specs/2026-05-22-raas-rematch-events-ao-adaptation-design.md)

---

## 文件结构

| 文件 | 操作 | 责任 |
|---|---|---|
| `server/em/schemas/builtin.ts` | 修改 | `RESUME_PROCESSED_v1` 的 `upload_id` 由必填改可选 |
| `server/em/schemas/builtin.test.ts` | 新增 | 校验 RaaS 形状(无 `upload_id`)和 AO 形状(有 `upload_id`)均能解析 |
| `server/inngest/raas-bridge.ts` | 修改 | 抽出 `shouldBridgeEvent()` helper + 在 `tick()` 内容过滤 |
| `server/inngest/raas-bridge.test.ts` | 新增 | 单测 `shouldBridgeEvent()` 各分支 |
| `.env.example` | 修改 | `RAAS_BRIDGE_EVENTS` 默认值更新 + 注释 |

---

## Task 0:Pre-flight 核查(开始动代码前必做)

设计文档 §6 验证项 V3:`em` 注册表优先用 Neo4j `EventDefinition` 行,Neo4j 无行才回退 `builtin.ts`(见 [server/em/registry/index.ts:1-22](../../../../server/em/registry/index.ts))。若 Neo4j 已有 `RESUME_PROCESSED` 的定义且 `upload_id` 是 required,**只改 builtin.ts 无效**,Task 1 通过后线上仍会被 Neo4j schema 拦下。

- [ ] **Step 1: 确认 Neo4j 中 `RESUME_PROCESSED` 的 EventDefinition**

Run:
```bash
# 1) 直接看 EM 同步态:
grep -rn "RESUME_PROCESSED" prisma/seed-*.ts 2>/dev/null | head -5
# 2) 启动后访问 /api/em/registry/RESUME_PROCESSED (若有)或 /events 看 schemaSource
# 3) 直接查 Prisma:
npx tsx -e 'import { prisma } from "./server/db"; prisma.eventDefinition.findUnique({ where: { name: "RESUME_PROCESSED" } }).then((r) => console.log(JSON.stringify(r, null, 2)))'
```

Expected outcomes:
- 若返回 `null` → 走 builtin 兜底,Task 1 改 builtin.ts 即可。
- 若返回行且 `schema` 字段含 `"required": ["upload_id"]` → 标记下来,Task 1 完成后还要走 Neo4j 同步流程更新该行(联系 EM/Neo4j 同步负责人,或临时设 `EM_PASSTHROUGH=1` 走兜底,但生产不要长期开)。

- [ ] **Step 2: 确认 RaaS 投递的 `RESUME_PROCESSED` 是信封形态**(设计文档 §6 V1)

抓一条线上事件确认:`data` 顶层有 `payload: {...}` 包裹(与 `RESUME_DOWNLOADED` 一致),而不是扁平直放 `candidate_id/resume_id` 在顶层。

Run:
```bash
curl -s "http://10.100.0.70:8288/v1/events?limit=20" | \
  jq '.data[] | select(.name=="RESUME_PROCESSED") | {id, has_payload: (.data.payload != null), top_keys: (.data | keys), payload_keys: (.data.payload // {} | keys)}' | head -40
```

Expected: `has_payload: true`,`payload_keys` 含 `candidate_id, resume_id, job_requisition_id, reassign_trigger` 或 `same_sequence_trigger`。
若是扁平形态,**停下来**与 RaaS 后端对齐前不要继续——本计划假设信封形态。

- [ ] **Step 3: 确认 `operator_id` 在 payload 中可用**(设计文档 §6 V2)

复用上一步 curl,确认 `payload_keys` 含 `operator_id`。否则部署时必须设 `RAAS_DEFAULT_EMPLOYEE_ID`,否则 `ruleCheckAgent` 会因第 97-99 行的 `NonRetriableError` 失败。

- [ ] **Step 4: 切工作分支**

```bash
git checkout main
git pull
git checkout -b feat/raas-rematch-event-bridging
```

---

## Task 1:放宽 `RESUME_PROCESSED_v1` 的 `upload_id`(TDD)

**Files:**
- Create: `server/em/schemas/builtin.test.ts`
- Modify: `server/em/schemas/builtin.ts:62-72`

- [ ] **Step 1: 写失败测试**

新建 `server/em/schemas/builtin.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// 同 publish.test.ts 的 hoisted mock 套路,让 registry 走 builtin 兜底。
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    eventInstance: { create: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    emSystemStatus: { upsert: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    eventDefinition: { findUnique: vi.fn(async () => null) }, // Neo4j 无行 → 回退 builtin
  },
}));

vi.mock("../../inngest/client", () => ({
  inngest: { send: vi.fn(async () => ({ ids: ["sent"] })) },
}));
vi.mock("../../db", () => ({ prisma: prismaMock }));

import { validate } from "../validate";
import { invalidateCache } from "../registry";

beforeEach(() => {
  vi.clearAllMocks();
  invalidateCache();
});

describe("RESUME_PROCESSED_v1 schema", () => {
  // 既有 AO-emitted 形态(resumeParserAgent 出口):有 upload_id + parsed
  it("accepts AO-shaped event with upload_id + parsed", async () => {
    const r = await validate("RESUME_PROCESSED", {
      entity_type: "Resume",
      entity_id: "r-1",
      event_id: "evt-ao-1",
      payload: {
        upload_id: "u-100",
        parsed: { data: { name: "张三" } },
        job_requisition_id: "jr-1",
      },
    });
    expect(r.ok).toBe(true);
  });

  // 新增:RaaS reassign-job 形态(无 upload_id,无 parsed,thin event)
  it("accepts RaaS reassign-shaped event without upload_id, with candidate_id + reassign_trigger", async () => {
    const r = await validate("RESUME_PROCESSED", {
      entity_type: "Candidate",
      entity_id: "c-1",
      event_id: "evt-raas-1",
      payload: {
        candidate_id: "c-1",
        resume_id: "rsm-1",
        job_requisition_id: "jr-9",
        client_id: "cli-1",
        resume_file_path: "abc/u-1.pdf",
        resume_bucket: "recruit-resume-raw",
        reassign_trigger: true,
        operator_id: "emp-001",
        source_label: "RAAS Web Console · 关联岗位变更",
      },
    });
    expect(r.ok).toBe(true);
  });

  // 新增:RaaS same-sequence 形态
  it("accepts RaaS same-sequence-shaped event with same_sequence_trigger", async () => {
    const r = await validate("RESUME_PROCESSED", {
      entity_type: "Candidate",
      payload: {
        candidate_id: "c-1",
        resume_id: "rsm-1",
        job_requisition_id: "jr-10",
        same_sequence_trigger: true,
        reassign_trigger: false,
        operator_id: "emp-001",
      },
    });
    expect(r.ok).toBe(true);
  });

  // 边界:payload 完全空,但有 envelope 信封 — 当前实现下应该 OK(全字段可选)
  // 仍然报错的形态:不带 payload 信封(扁平)— envelope() 缺 payload 必拒
  it("rejects flat payload (no envelope)", async () => {
    const r = await validate("RESUME_PROCESSED", {
      candidate_id: "c-1",
      resume_id: "rsm-1",
      reassign_trigger: true,
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试,确认 RaaS 形态用例失败**

Run: `npm run test -- server/em/schemas/builtin.test.ts`
Expected: AO-shaped 用例 PASS;RaaS reassign / same-sequence 用例 FAIL,错误信息形如 `payload.upload_id: Required`(或 zod 等价文本)。

- [ ] **Step 3: 修改 schema**

编辑 [server/em/schemas/builtin.ts:62-72](../../../../server/em/schemas/builtin.ts),将:

```ts
const RESUME_PROCESSED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1),
    parsed: z
      .object({
        data: z.record(z.string(), z.unknown()),
      })
      .optional(),
    job_requisition_id: z.string().optional(),
  }).passthrough(),
);
```

改为:

```ts
// 2026-05-23: upload_id 由必填改可选 — RaaS Web Console 的"更换关联岗位"/
// "匹配同序列岗位"两个功能用 candidate_id + resume_id 定位简历,不带
// upload_id。ruleCheckAgent 第 94-96 行本就接受 upload_id 缺失。
// 见 docs/superpowers/specs/2026-05-22-raas-rematch-events-ao-adaptation-design.md
const RESUME_PROCESSED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1).optional(),
    candidate_id: z.string().optional(),
    resume_id: z.string().optional(),
    parsed: z
      .object({
        data: z.record(z.string(), z.unknown()),
      })
      .optional(),
    job_requisition_id: z.string().optional(),
  }).passthrough(),
);
```

- [ ] **Step 4: 跑测试,确认全部通过 + 既有套件不受影响**

```bash
npm run test -- server/em/schemas/builtin.test.ts
npm run test -- server/em            # 跑 em 子目录全部测试,确保 publish.test.ts 不破
```
Expected:都 PASS。`server/em` 全套测试 0 失败。

- [ ] **Step 5: 提交**

```bash
git add server/em/schemas/builtin.ts server/em/schemas/builtin.test.ts
git commit -m "fix(em): RESUME_PROCESSED.upload_id 必填改可选,适配 RaaS 重匹配 thin event"
```

---

## Task 2:抽出桥接内容过滤 helper(TDD)

**Files:**
- Create: `server/inngest/raas-bridge.test.ts`
- Modify: `server/inngest/raas-bridge.ts`(导出 `shouldBridgeEvent`)

- [ ] **Step 1: 写失败测试**

新建 `server/inngest/raas-bridge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldBridgeEvent } from "./raas-bridge";

describe("shouldBridgeEvent — non-RESUME_PROCESSED events", () => {
  it("放行 RESUME_DOWNLOADED(行为不变)", () => {
    expect(
      shouldBridgeEvent("RESUME_DOWNLOADED", { payload: { upload_id: "u-1" } }),
    ).toBe(true);
  });

  it("放行 JD_GENERATED(行为不变)", () => {
    expect(shouldBridgeEvent("JD_GENERATED", { payload: {} })).toBe(true);
  });
});

describe("shouldBridgeEvent — RESUME_PROCESSED 来源过滤", () => {
  it("放行 RaaS reassign-trigger 事件", () => {
    expect(
      shouldBridgeEvent("RESUME_PROCESSED", {
        payload: { candidate_id: "c-1", reassign_trigger: true },
      }),
    ).toBe(true);
  });

  it("放行 RaaS same-sequence-trigger 事件", () => {
    expect(
      shouldBridgeEvent("RESUME_PROCESSED", {
        payload: { candidate_id: "c-1", same_sequence_trigger: true },
      }),
    ).toBe(true);
  });

  it("丢弃无触发标志的 RESUME_PROCESSED(防 AO 自产事件成环)", () => {
    expect(
      shouldBridgeEvent("RESUME_PROCESSED", {
        payload: { upload_id: "u-1", parsed: { data: {} } },
      }),
    ).toBe(false);
  });

  it("丢弃 trigger 标志显式为 false 的事件", () => {
    expect(
      shouldBridgeEvent("RESUME_PROCESSED", {
        payload: { reassign_trigger: false, same_sequence_trigger: false },
      }),
    ).toBe(false);
  });

  it("信封缺失时仍能从顶层读取(扁平兜底)", () => {
    expect(
      shouldBridgeEvent("RESUME_PROCESSED", { reassign_trigger: true }),
    ).toBe(true);
  });

  it("data 非对象时安全返回 false,不抛错", () => {
    expect(shouldBridgeEvent("RESUME_PROCESSED", null)).toBe(false);
    expect(shouldBridgeEvent("RESUME_PROCESSED", "junk")).toBe(false);
    expect(shouldBridgeEvent("RESUME_PROCESSED", undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试,确认全部失败(函数未导出/不存在)**

Run: `npm run test -- server/inngest/raas-bridge.test.ts`
Expected: 全 FAIL,错误形如 `shouldBridgeEvent is not a function` 或 `does not provide an export named 'shouldBridgeEvent'`.

- [ ] **Step 3: 实现 + 导出 `shouldBridgeEvent`**

编辑 [server/inngest/raas-bridge.ts](../../../../server/inngest/raas-bridge.ts),在 `fetchSharedEvents` 函数下方(文件末尾前)新增导出:

```ts
/**
 * 桥接层内容过滤。
 *
 * `RESUME_PROCESSED` 是双源事件:AO `resumeParserAgent` 自产 + RaaS Web Console
 * 两个功能(reassign-job / match-same-sequence)外发。一旦 `forwardToRaas`
 * 启用,AO 自产的 `RESUME_PROCESSED` 会被转发到 RaaS 总线,桥再无差别拉回
 * 就会成环。
 *
 * 用 RaaS Web Console 独有的 `reassign_trigger` / `same_sequence_trigger`
 * 作正向白名单 — AO 自产事件永远不会带这两个标志。
 *
 * 其他事件名(RESUME_DOWNLOADED / JD_GENERATED / ...)行为不变。
 *
 * 见 docs/superpowers/specs/2026-05-22-raas-rematch-events-ao-adaptation-design.md
 */
export function shouldBridgeEvent(name: string, data: unknown): boolean {
  if (name !== "RESUME_PROCESSED") return true;
  if (!data || typeof data !== "object") return false;
  const root = data as Record<string, unknown>;
  const payload =
    root.payload && typeof root.payload === "object"
      ? (root.payload as Record<string, unknown>)
      : root;
  return payload.reassign_trigger === true || payload.same_sequence_trigger === true;
}
```

- [ ] **Step 4: 跑测试,确认全部通过**

Run: `npm run test -- server/inngest/raas-bridge.test.ts`
Expected: 全 PASS(8 用例)。

- [ ] **Step 5: 提交**

```bash
git add server/inngest/raas-bridge.ts server/inngest/raas-bridge.test.ts
git commit -m "feat(raas-bridge): 抽出 shouldBridgeEvent 内容过滤 helper"
```

---

## Task 3:在 `tick()` 中接入 `shouldBridgeEvent`

**Files:**
- Modify: `server/inngest/raas-bridge.ts:102-107`

- [ ] **Step 1: 改 `tick()` 主循环**

在 [server/inngest/raas-bridge.ts:102-107](../../../../server/inngest/raas-bridge.ts) 当前:

```ts
for (const e of events) {
  if (_seenIds.has(e.id)) continue;
  if (!EVENT_NAMES.includes(e.name)) {
    _seenIds.add(e.id);
    continue;
  }

  // New event from RAAS — push through em.publish ...
```

改为(在事件名过滤之后、`em.publish` 之前插入内容过滤):

```ts
for (const e of events) {
  if (_seenIds.has(e.id)) continue;
  if (!EVENT_NAMES.includes(e.name)) {
    _seenIds.add(e.id);
    continue;
  }
  // 内容过滤 — 见 shouldBridgeEvent 注释。
  // RESUME_PROCESSED 在 RaaS 总线上有两个来源(AO 自产被转发回来 vs RaaS Web
  // Console 两个功能外发),只放行后者,避免成环 / 重复处理。
  if (!shouldBridgeEvent(e.name, e.data)) {
    _seenIds.add(e.id);
    _stats.rejectedFilter++;
    if (e.name === "RESUME_PROCESSED") {
      console.log(`[raas-bridge] skip ${e.name} (${e.id}) — no reassign/same-sequence trigger`);
    }
    continue;
  }

  // New event from RAAS — push through em.publish ...
```

注意:`_stats.rejectedFilter` 字段已存在([raas-bridge.ts:41](../../../../server/inngest/raas-bridge.ts)),沿用即可。

- [ ] **Step 2: TypeScript 编译 + lint 通过**

Run:
```bash
npm run build 2>&1 | tail -30
npm run lint 2>&1 | tail -20
```
Expected:build 0 type 错误,lint 0 错误(warn 可接受,但本次改动不应新增 warn)。

- [ ] **Step 3: 跑全部 server 测试,确认无回归**

Run: `npm run test -- server`
Expected:所有用例 PASS。

- [ ] **Step 4: 提交**

```bash
git add server/inngest/raas-bridge.ts
git commit -m "feat(raas-bridge): tick() 接入 shouldBridgeEvent 内容过滤"
```

---

## Task 4:更新 `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: 定位 `RAAS_BRIDGE_*` 段并修改**

Run: `grep -n "RAAS_BRIDGE" .env.example`,找到 `RAAS_BRIDGE_EVENTS` 行(若不存在则新增)。

将其值由 `RESUME_DOWNLOADED` 改为 `RESUME_DOWNLOADED,RESUME_PROCESSED`,并补注释。改后形如:

```bash
# raas-bridge — pulls events from RaaS Inngest (shared bus) into AO's local
# Inngest. Single-direction (AO outbound only). See server/inngest/raas-bridge.ts.
RAAS_BRIDGE_ENABLED=1
RAAS_INNGEST_URL=http://10.100.0.70:8288
RAAS_BRIDGE_POLL_INTERVAL_MS=5000
# Event names the bridge pulls. RESUME_PROCESSED is needed for the RaaS Web
# Console "更换关联岗位" / "匹配同序列岗位" features — those features bypass
# AO's resume parsing and emit RESUME_PROCESSED with reassign_trigger /
# same_sequence_trigger directly. The bridge's content filter
# (shouldBridgeEvent) only ingests trigger-flagged RESUME_PROCESSED to avoid
# loops with AO-self events.
RAAS_BRIDGE_EVENTS=RESUME_DOWNLOADED,RESUME_PROCESSED
# Fallback employee id when RaaS payload's operator_id is missing —
# ruleCheckAgent hard-requires an employee_id (NonRetriableError otherwise).
# Set this if your operator_id pipeline isn't fully wired.
# RAAS_DEFAULT_EMPLOYEE_ID=
```

- [ ] **Step 2: 提交**

```bash
git add .env.example
git commit -m "docs(env): RAAS_BRIDGE_EVENTS 加入 RESUME_PROCESSED + 注释"
```

---

## Task 5:跨系统端到端验证清单(部署后人工)

无法在 AO 仓库内完全自动化(依赖 RaaS Web Console 操作 + RaaS Postgres)。部署到联调环境后照此清单走一遍。

- [ ] **Step 1: 触发功能 A(更换关联岗位)**

- 在 RaaS Web Console 人才库,任选有已解析简历的候选人,点卡片"更换关联岗位",选一个新 JR,提交。
- RaaS 端 audit_log 应出现 `REASSIGN_JOB` 记录;outbox 表新增一行 `event_name='RESUME_PROCESSED'`,payload 含 `reassign_trigger:true`。

- [ ] **Step 2: 在 AO 侧追踪事件**

- AO `/events` 列表(或 `GET /api/events/candidates?windowHours=1`)应在 5-15 秒内出现一行 `RESUME_PROCESSED`,源标 `raas-bridge`。
- AO `/api/raas-bridge/status` 的 `accepted` 计数 +1,`rejectedFilter` 不变,`lastEventBridgedAt` 更新。
- 若看到 `rejectedSchema` +1:回去查 Task 0 Step 1 — Neo4j EventDefinition 没同步,本次改动只覆盖了 builtin。
- 若看到 `rejectedFilter` +1 且没看到 `accepted`:回去查 payload 实际形状,与 `shouldBridgeEvent` 的判据(`reassign_trigger`/`same_sequence_trigger`)对齐。

- [ ] **Step 3: 验证 `ruleCheckAgent` 走通**

- Inngest dev UI(`http://localhost:8288`)的 `rule-check-agent` runs 列表应新增一条 run。
- 该 run 的 step 序列应包含 `list-requirements`(路径 A,单 JR)、`fetch-parsed-resume`(thin-event 回查)、`rule-check-<jr>`、`write-audit-<jr>`、`write-cmr-<jr>`、最终 `emit-passed-<jr>` 或 `emit-failed-<jr>`。
- AO Prisma `RuleCheckAudit` 表新增一行,`job_requisition_id` = 新 JR。
- 若 run 在 `list-requirements` 之前 `NonRetriableError` 报 "缺 employee_id" → 回去查 Task 0 Step 3,设置 `RAAS_DEFAULT_EMPLOYEE_ID`。

- [ ] **Step 4: 验证 `matchResumeAgent` + 写回**

- 若 Step 3 走到 `MATCH_RULE_CHECK_PASSED`,Inngest 应紧跟一条 `match-resume-agent` run,内部调 RoboHire `/match-resume`,完成后写 partner-pg。
- 直查 RaaS Postgres:`SELECT * FROM candidate_match_result_runtime_state WHERE candidate_id = '<c>' AND job_requisition_id = '<新 jr>'` 应有新行,`total_weighted_score` 非空。

- [ ] **Step 5: 回到 RaaS UI 验证**

- 刷新人才详情/对话框,新 JR 的匹配结果可见。

- [ ] **Step 6: 触发功能 B(匹配同序列)— 多 JR 并发**

重复 Step 1-5,但通过人才详情某条匹配结果的"匹配同序列岗位"按钮选 3 个同序列 JR 提交。预期:
- RaaS outbox 新增 3 行 `RESUME_PROCESSED`(`same_sequence_trigger:true`)。
- AO `/api/raas-bridge/status` `accepted` +3。
- Inngest 3 条独立 `rule-check-agent` run + 3 条 `match-resume-agent` run。
- `candidate_match_result_runtime_state` 新增 3 行,3 个不同 `job_requisition_id`。
- RaaS `MatchSameSequenceDialog` 重新打开后,这 3 个 JR 的 `already_matched: true`。

---

## Task 6:发起 PR + 交接

- [ ] **Step 1: 整理 PR**

```bash
git push -u origin feat/raas-rematch-event-bridging
gh pr create --title "feat(raas-bridge): 适配 RaaS 重匹配事件(更换关联岗位 / 匹配同序列)" \
  --body "$(cat <<'EOF'
## Summary
- 桥接层加入 `RESUME_PROCESSED`,按 `reassign_trigger`/`same_sequence_trigger` 内容过滤防成环。
- `RESUME_PROCESSED_v1` schema 放宽 `upload_id` 为可选,适配 RaaS thin event。
- `ruleCheckAgent` / `matchResumeAgent` 零改动 —— 已就绪。

## Design
docs/superpowers/specs/2026-05-22-raas-rematch-events-ao-adaptation-design.md

## Test plan
- [x] `npm run test -- server/em` 全绿(含新 builtin.test.ts)
- [x] `npm run test -- server/inngest/raas-bridge.test.ts` 全绿
- [x] `npm run build` / `npm run lint` 通过
- [ ] 联调环境跑通 Task 5 验证清单 6 步
EOF
)"
```

- [ ] **Step 2: 通知设计文档 §6 验证项 V3 的 owner**

若 Task 0 Step 1 发现 Neo4j `EventDefinition` 有 `RESUME_PROCESSED` 行且 `upload_id` required,在 PR 描述里 @ EM/Neo4j 同步 owner,请同步更新该行;否则线上仍会 `rejectedSchema`。

---

## Self-Review 备忘(实现前快速过一遍)

- **覆盖**:设计文档 §4 的 3 个改动 → Task 1(schema)、Task 2-3(桥过滤)、Task 4(env)。设计文档 §6 验证项 → Task 0 + Task 5。
- **类型一致性**:`shouldBridgeEvent(name: string, data: unknown): boolean` 在 Task 2 测试用例与 Task 2 实现签名一致;Task 3 在 `tick()` 中以 `shouldBridgeEvent(e.name, e.data)` 调用,与 `SharedEvent` 类型字段(`name`/`data`)对齐。
- **DRY/YAGNI**:仅放行需要的 trigger 标志,未引入其他 source 检测;未提前实现 `forwardToRaas` 跳过逻辑(那是另一工作流的事),但已为其落地预留了过滤判据。
- **无 placeholder**:每个 step 给出实际代码或精确命令。
