# 候选人锁定 — 对齐公司 RMHR 简历锁定接口（设计）

> 日期：2026-06-08 · 状态：设计已确认，待转 writing-plans
> 设计取向：**C = 干净架构**（①持久化 与 ②校验 物理解耦 + 单一 LockResolver 接缝 + feature flag）

## 1. 问题（要修的 bug）

招聘锁定简历，保证两个招聘不重复跟同一候选人。公司 **RMHR** 系统是锁定的**唯一真相源、且自己强制执行**（重复+已被他人锁定/保护/黑名单 → 不改锁定、返回当前锁定人）。

bug 的本质 = **本地缓存过期**：RAAS（用户口中的 "Rice" 即 RAAS）锁定一次后不刷新，公司也不开放解锁/变更通知接口，招聘还在公司"议程系统"里改锁。结果 RAAS / AO 对"张三现在被谁锁"的认知一直在烂。

**唯一能刷新的时刻 = 重新上传**：那一刻调 RMHR，会返回当前真实锁定人。所以修复 = 在每次真实上传时调一次 RMHR、忠实记录返回、据此放行/拦截。

> 治标极限：只有上传接口 → 只能上传时刷新，两次上传之间无解。治本需公司开查询/解锁接口，或组织上统一只在 RAAS 锁/解锁。本设计只做"上传时刷新对"这一段。

## 2. 接口契约（RMHR `uploadByRecruiterEmail` v1.2）

- `POST {host}/?module=rmhr_internal&httpMethod=post&method=/internal/uploadByRecruiterEmail`，`multipart/form-data`，Header `X-Internal-Api-Key`。
- Body：`file`（简历字节）+ `recruiterEmail`（公司邮箱，**身份键**）+ `resumeSourceId`（渠道码，如 `02001034`）。
- 两层响应：外层网关 `code`（200=转发成功 ≠ 业务成功）；内层 `data.code`（1000=成功，1001=业务异常）；`data.model` 是 **JSON 字符串**需 `JSON.parse`。
- `model` → `{resumeId, lockState(1未锁/2锁定/3保护), lockBy(工号), lockByName, lockByEmail, lockTime "yyyy-MM-dd HH:mm:ss", message}`。
- 公司侧：校验 recruiterEmail 存在；上传+解析+**按手机号去重**；新建/重复未锁 → 锁到该招聘；重复+被他人锁/保护/黑名单 → 不改、返回当前锁定人。
- **不对称幂等**：对已锁定的重复简历重复调用安全；对**未锁定**的候选人重复调用会把他**锁到你传进去的招聘名下**——故不能拿它当轮询、replay 要防。
- 测试环境（已获）：host `http://gdev.chinasoftinc.com:8999/soulin/?module=rmhr_internal&httpMethod=post&method=/internal/uploadByRecruiterEmail`，key `X-Internal-Api-Key` 由 partner 提供（放密钥配置，**不入仓库**）。

## 3. 架构（干净架构）

新模块 `lib/candidate-lock/`，①与②互不 import，只在调用点按 `①调RMHR → decide() → ②落库` 顺序碰头，各自独立 flag：

```
lib/candidate-lock/
  types.ts            词汇：LockState{FREE=1,LOCKED=2,PROTECTED=3} + BLACKLISTED 哨兵(不入 RMHR scale)、
                      LockSnapshot、LockRecord、LockDecision='proceed'|'lock-only'|'park'、LockOutcomeReason
  rmhr-client.ts      ②的接缝：唯一懂公司契约的文件（照 lib/robohire-client.ts）。两层响应 + JSON.parse(data.model)
  decide.ts           纯函数闸门（零 IO，满单测）
  classify.ts         RMHR 错误分档，复用 lib/dependency-health（没钱/故障/说不准）
  persistence-port.ts 笨持久化：拿到啥写啥，零分支、零 flag 读
  index.ts
```

**放置纠正**：锁定校验放在 **resume-parser 入口接缝**，**不放 rule-check**——RMHR 是"上传+锁定"合一、请求体要简历文件，文件只在入库那刻有（`pdfBuffer`，可经 `getResumeBuffer(bucket,object_key)` 重取）；rule-check 跑在无文件的重匹配瘦事件上。具体：在 [resume-parser-agent.ts](../../../server/inngest/agents/resume-parser-agent.ts) save-candidate 之后、processedPayload 之前插一个 `rmhr-lock-check` step，结果去闸住**两个**下游广播（`emit-resume-processed` + `notifyRecruitmentLifecycle`）。`retries:0` 是关键(防 Inngest 自动重试触发不对称幂等)；legacy 无文件路径 early-return `proceed`。

Flag（`process.env.X === '1'`，默认 OFF）：`LOCK_CHECK_ENABLED`、`CANDIDATE_LOCK_PG_WRITE`、`DEDUP_PHONE_PRIMARY`、`RESUME_SOURCE_MAP_ENABLED`，全部在调用点读，**绝不**在笨 port 或纯 decide 里读。

## 4. 七处对齐（与 RMHR 口径对齐）

| 对齐项 | 改动 | 归属 |
|---|---|---|
| 去重改手机号为主 | [candidates.ts](../../../lib/partner-pg/candidates.ts)：normalizeMobile 收紧到 ≥11位取后11；强手机号走纯手机号 tier；**邮箱+姓名兜底原样保留**（不重开 2026-05-26 合并 bug）；needs_mobile_review 标记；normalizeName | AO（flag+dry-run） |
| 锁定三态+黑名单 | types LockState；扩 `CandidateLock` 表 | AO（自有迁移） |
| 归属用邮箱 | 新 `lib/partner-pg/employee.ts`：employee_id→email 反查 | 代码 AO；列名/邮箱口径待 partner |
| 存全锁定真相 | 扩 `CandidateLock`：放宽 expiresAt 为可空、加 lockState/lockOwnerEmployeeId/lockByName/lockByEmail/lockTime(原样字符串)/rmhrResumeId/message/requestedByEmail/lastCheckedAt | AO（自有迁移，零现有读写） |
| 渠道码映射 | 新 `lib/rmhr/resume-source-map.ts`：纯函数+默认码+映射表 | 框架 AO；码表待公司 |
| RMHR 客户端+两层响应+错误分档 | rmhr-client.ts + classify.ts；DepProvider 增 `'rmhr'`；external-api-log 增 `'rmhr'` 类 | 形状 AO；host/key 待 partner |
| 闸门+笨持久化+flag+接线 | decide.ts / persistence-port.ts / resume-parser 接线 | AO（flag 关着先接上） |

## 5. 三个决策（含故障更正）

### 决策一 · 拦截 UX = lock-only + 响亮冲突信号
被他人锁定时：**不跑非锁定人的匹配**（lock-only，照样持久化候选人+锁定真相），同时 emit 已定义但从未触发的 `RESUME_LOCKED_CONFLICT`（[events-catalog.ts](../../../lib/events-catalog.ts) 已接 HSM·仲裁台）让招聘/运营看得到"已被某工号锁定"。**不**照常流转(浪费匹配+误呈现为可处理)，**不**静默吞掉(招聘困惑→重传踩雷)。标注：是否在 RAAS 里**展示**张三为"他人锁定"是产品最终拍板项，但可见性靠冲突信号、不靠把张三推进匹配。

### 决策二 · 失败策略 = 分阶段 + 永不猜邮箱 +（更正）故障也是失败
锁定校验步骤的**结果如实落账**为三类：`proceed` / 业务失败(lock-only：他人锁/保护/黑名单，reason=业务) / **故障失败**(RMHR 挂、网络、网关错、`data.model` 解析失败、取不到 recruiterEmail，**reason=故障**)。

- **故障失败仍然是失败**——按 reason=故障 分类记录、可见、告警；它可恢复(能 park 重试)，但**绝不**当成功、**绝不**静默放过。复用依赖健康 没钱/故障/说不准 + isInfraFailure 的分档。
- **黑暗发布期(P3，只观察不拦)**：故障失败照样**落账为故障失败**，但不拦主流程(不阻塞真实上传)。
- **执行期(P4)**：故障失败 → **可恢复 park 重试**(不放行——停机期放行=背叛特性目的)；取不到 recruiterEmail → 同样 park + 响亮告警去修映射(放行=合法锁定直接丢)。
- **铁律**：绝不猜测/传空 recruiterEmail(不对称幂等下会锁错人)。

### 决策三 · replay 安全 = 按 upload_id 加幂等守卫
按 **upload_id**(入库事件身份，非候选人)记录"已调过 RMHR + 结果"。重放同一 upload_id → 短路返回存的结果、不再 POST。不同 upload_id(另一招聘重传同一候选人=正常刷新机制) → 照常调。专治"重放复活已释放的锁"+ 省重复调用 + 充当调用审计。所需 `lastCheckedAt`/`rmhrResumeId` 已在 `CandidateLock` 扩展字段里。**P4 执行前必须就位。**

## 6. 分阶段计划（AO-now vs 待 partner）

- **P0 · 纯 AO 脚手架，全 flag OFF，零行为变化**（不依赖任何人，先落）：`lib/candidate-lock/*`(types + 纯 decide + 满单测 + rmhr-client 形状 + classify + 笨 port)、`lib/rmhr/resume-source-map.ts`(占位码表)、`lib/partner-pg/employee.ts`(反查代码)、扩 `CandidateLock` 表(db:push)、DEDUP_PHONE_PRIMARY 改造(flag 关、dry-run)、resume-parser 接线休眠、DepProvider/api-log 增 `'rmhr'`、.env.example 文档化。
- **P1 · employee→email 反查**：代码现做；正确性待 partner 确认 employee 表列名 + `email` 是否即 RMHR 比对/返回的邮箱。
- **P2 · DEDUP_PHONE_PRIMARY**：flag 门控、先 dry-run 数受影响行；待 partner 确认其 worker 是否也转手机号为主 + 可选回填合并。
- **P3 · 接入口接缝，①开成黑暗发布**：真打 RMHR、记录 decide 结果与故障失败、不拦不持久。待 partner 给 host/key/完整 query 串 + 渠道码表。
- **P4 · ②持久化开 + 真执行**：锁定落库持久、lock-only 拦截两个广播、故障 park、本体镜像(待 partner 确认 AO 可写 is_locked/lock_start_time 及本体扩字段)。

## 7. 待 partner / 公司交付（都是"填值"非"接线"）

1. RMHR 正式 host + `X-Internal-Api-Key` + 完整 query 串；
2. `resumeSourceId` 码表全集 + 默认码 + 确认默认码不触发 1001 + resumeSourceId 是否必填；
3. employee 表列名 + 确认 `email` 即 RMHR 认/返回的邮箱；
4. 本体扩字段(Allmeta 严格校验，AO 不能私自加 `lock_state/lock_owner_email/is_protected`) + 确认 AO 可写 is_locked/lock_start_time(现注释"留 hsm 端填");
5. 确认黑名单分支与 lockState 1/2/3 互斥；
6.（去风险）partner worker 是否也转手机号为主去重，避免同手机号/不同姓名在两条路径落到不同 candidate_id。

## 8. 开放问题

- `CandidateLock` 键：candidate_id / rmhrResumeId / 复合？(倾向复合)
- 取不到邮箱时执行期 fail-closed(park) 是否永久策略。
- `CandidateLock.expiresAt` 放空 + 现有 `@@index([clientId, expiresAt])` 暗示的 sweeper 不存在 → 删索引或定 TTL 策略。
- PROTECTED(3) 下游是否与 LOCKED 同等拦截；本体只有布尔会有损。
- 手工 replay 的幂等守卫粒度。
