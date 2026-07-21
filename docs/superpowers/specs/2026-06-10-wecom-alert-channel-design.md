# AO → 企业微信告警链路设计(经 OpenClaw 网关)

日期:2026-06-10 · 状态:已实施并通过 E2E 验证

## 目标

把 AO 的运行告警(SLA 超时、DLQ、依赖宕机)、关键招聘业务事件,以及
AO/Inngest/OpenClaw 三个服务自身的存活状态,推送到企业微信 AICOE 智能机器人
(OpenClaw `wecom` channel,长连接模式,无需公网 IP)。

## 架构:两条腿 + 一个日报

```
腿A(应用事件,推)
  agent 运行 → recordNotification(ingest)→ Notification 落库
    → dispatchExternal(每行都提供给外部通道)
    → OpenClawWecomChannel(通道自有策略)
    → docker exec openclaw-gateway CLI message send → 企微

腿B1(存活,拉,确定性)
  launchd 每5分钟 → scripts/health-watchdog.mjs
    → 探测 AO:3002 / Inngest:8288 / OpenClaw:18789
    → 状态翻转才推送(宕机1条、恢复1条带时长)

腿B2(日报,agentic)
  OpenClaw cron「ao-daily-inspection」每天 09:30 Asia/Shanghai
    → agent curl AO /api/alerts + /api/agents/health → 中文日报 → 企微
```

## 关键决策

- **通道自有策略,而不是 ingest 把关**:`dispatchExternal` 改为对每条落库
  通知都调用(原先只在 `shouldNotify` 时),in-app 红点语义不变。原因:
  业务里程碑事件是 `kind=message, shouldNotify=false`,旧门槛下永远到不了
  外部通道。各通道按自己的策略过滤(severity 门槛 / 信号白名单)。
- **`signal` 透传**:`CaptureInput → NotificationDraft → NotifyTarget` 新增
  可选 `signal`(不落库),白名单按信号匹配,不依赖中文文案串。
- **监控链路无 LLM**(沿用 `derive.ts` 的承重原则):发送 = `docker exec`
  进网关容器跑 CLI(实测 ~2.6s),探针是纯 Node 脚本。LLM 只出现在腿B2 的
  日报总结里,且其失败不影响告警链路。
- **重复抑制在通道内**:firing 告警 upsert 复用同一行 id,通道按行 id 做
  15 分钟窗口抑制(`WECOM_REPEAT_SUPPRESS_MIN`),防刷屏(企微限速
  30条/分/会话)。

## 配置(全 env,见 `.env.example` §12)

| 变量 | 作用 | 默认 |
|---|---|---|
| `NOTIFY_CHANNELS` | 加 `openclaw-wecom` 启用通道 | `in_app` |
| `WECOM_ALERT_TARGETS` | 接收人 userId/groupId,逗号分隔,**原始大小写** | 空=通道静默 |
| `WECOM_ALERT_MIN_SEVERITY` | 告警门槛 `warning`/`critical` | `warning` |
| `WECOM_EVENT_WHITELIST` | 业务事件信号白名单 | 待面试/邀约已发/JD生成 |
| `WECOM_REPEAT_SUPPRESS_MIN` | 同一告警行抑制窗口(分钟) | `15` |
| `OPENCLAW_GATEWAY_CONTAINER` | 网关容器名 | `openclaw-openclaw-gateway-1` |
| `AO_BASE_URL` | 消息尾部控制台链接 | `http://localhost:3002` |

企微规则:**接收人必须先给 AICOE 机器人发过一条消息**;userId 从网关日志
`from.userid` 取(大小写敏感,不要从 sessionKey 取——core 会小写化)。

## 存活探针(腿B1)运维

- 脚本:`scripts/health-watchdog.mjs`(零依赖;状态文件 `~/.ao-watchdog/state.json`)
- launchd:`~/Library/LaunchAgents/com.ao.health-watchdog.plist`
  (300s 间隔,RunAtLoad,日志 `~/Library/Logs/ao-health-watchdog.log`)
- 装载:`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ao.health-watchdog.plist`
- 卸载:`launchctl bootout gui/$(id -u)/com.ao.health-watchdog`
- 注意:plist 里 node 用的是 nvm 绝对路径,换机器/升 node 要改。

## 已知缺口(如实声明)

1. OpenClaw 网关自身宕机时,探针发不出「网关宕机」消息(发送链路就是它);
   由容器 `restart: unless-stopped` 兜底,恢复翻转消息会补发。
   后续可加企微群 webhook 作死信备路。
2. `next dev` 启动后改 `.env.local` 需重启 dev server 才保证生效。
3. 探针只测 HTTP 可达性,不解析依赖降级(降级类告警由腿A 的
   dependency-health 路径负责,职责分离)。

## 生产迁移清单

1. 仓库代码随 git 走;`.env`(生产)按 §12 填 `WECOM_ALERT_TARGETS` 等。
2. OpenClaw 侧:拷 `docker-compose.yml` + `.env` + `~/.openclaw/`
   + `~/.openclaw-auth-profile-secrets/`,镜像固定版本标签(勿用 latest)。
   插件与 cron 任务持久在 `~/.openclaw/` 内,随目录迁移,无需重装。
3. launchd plist 按新机器的 node/docker 绝对路径调整后 bootstrap
   (Linux 生产机用 systemd timer 等价改写)。
4. **密钥轮换**(上生产前必做):企微 Secret、网关 token、Kimi key
   在调试期暴露过,全部重置后更新 `.env` / 企微后台。

## E2E 验证记录(2026-06-10)

- 腿A:`recordNotification`(error 告警)→ 企微送达;同 dedupeHint 立即重复
  → 同一行 id,网关仅 1 条出站(抑制生效);白名单事件
  `INTERVIEW_INVITATION_SENT` → 送达。网关出站 reqId:
  `aibot_send_msg_1781063266561_3be02222`、`..._027edbec`。
- 腿B1:`docker stop ao-inngest` → 🔴 推送;宕机中重跑 → 不重复;恢复 →
  🟢 带时长。出站 reqId:`..._8640e425`(宕)、`..._3f185640`(复)。
- 单测:`__tests__/wecom-channel.test.ts` 7/7;通知模块 46/46;
  改动文件 tsc 0 错误。
