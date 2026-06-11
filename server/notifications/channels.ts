// Pluggable notification channels (spec §8).
//
// In-app is the system of record: the Notification row itself IS the in-app
// notification (the 消息通知 center reads the table). External channels are
// pluggable — implement NotifyChannel and add its id to NOTIFY_CHANNELS.
//
// ingest.ts offers EVERY persisted row to dispatchExternal; each channel owns
// its send policy. openclaw-wecom (real) gates alerts by severity, lifecycle
// messages by signal whitelist, and suppresses repeat firing-alert sends.
// Delivery goes through the OpenClaw gateway container (docker exec → CLI) —
// deterministic, no LLM in the path (same load-bearing rule as derive.ts).

import { execFile } from 'node:child_process';
import { recordLogEvent } from '@/server/log/log-event';

/** 告警解除的外推信号(server/notifications/resolve.ts 构造)— 报警也报平安。 */
export const RECOVERY_SIGNAL = '__ALERT_RESOLVED';

export interface NotifyTarget {
  id: string;
  kind: 'message' | 'alert';
  severity: string;
  category: string;
  source: string;
  title: string;
  body: string;
  runId: string | null;
  /** 业务里程碑信号(如 INTERVIEW_INVITATION_SENT)— message 类的白名单键。 */
  signal?: string | null;
  agent?: string | null;
  /** in-app 红点语义,仅供通道参考;外部推送不再以它为门槛。 */
  shouldNotify?: boolean;
}

export interface NotifyChannel {
  readonly id: string;
  send(n: NotifyTarget): Promise<void>;
}

/** Placeholder external channel — logs intent, sends nothing. Replace with a
 *  real implementation (Feishu webhook, SMTP, …) when external delivery lands. */
class NoopExternalChannel implements NotifyChannel {
  constructor(public readonly id: string) {}
  async send(n: NotifyTarget): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[notify:${this.id}] would send · ${n.severity} · ${n.title}`);
  }
}

// ─── openclaw-wecom 真实通道 ────────────────────────────────────────────────

const SEV_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };
const SEV_ICON: Record<string, string> = { critical: '🔴', warning: '🟠', info: '🔵' };
const DEFAULT_EVENT_WHITELIST =
  'MATCH_PASSED_NEED_INTERVIEW,INTERVIEW_INVITATION_SENT,JD_GENERATED';

interface WecomCfg {
  targets: string[];
  minSeverity: string;
  eventWhitelist: Set<string>;
  container: string;
  account: string;
  baseUrl: string;
  suppressMs: number;
  /** 同一告警行在窗口抑制之外最多补发几次(首发不计)— 永不解除的告警不能无限轰炸。 */
  maxResends: number;
  /** 解除推送(报平安)开关,默认开。 */
  sendRecovery: boolean;
  /** message 类全局限流(条/分钟)— 白名单业务事件突发时不打爆网关。 */
  msgRatePerMin: number;
}

type EnvLike = Record<string, string | undefined>;

/** 读 env 出通道配置;未配置 WECOM_ALERT_TARGETS 时通道静默(返回 null)。 */
function readWecomCfg(env: EnvLike): WecomCfg | null {
  const targets = (env.WECOM_ALERT_TARGETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (targets.length === 0) return null;
  return {
    targets,
    minSeverity: env.WECOM_ALERT_MIN_SEVERITY?.trim() || 'warning',
    eventWhitelist: new Set(
      (env.WECOM_EVENT_WHITELIST ?? DEFAULT_EVENT_WHITELIST)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    container: env.OPENCLAW_GATEWAY_CONTAINER?.trim() || 'openclaw-openclaw-gateway-1',
    // AO 告警固定走 AICOE(default)机器人,不与会议总结(meeting)混账号。
    account: env.OPENCLAW_WECOM_ACCOUNT?.trim() || 'default',
    baseUrl: env.AO_BASE_URL?.trim() || 'http://localhost:3002',
    suppressMs: numEnv(env.WECOM_REPEAT_SUPPRESS_MIN, 15) * 60_000,
    maxResends: numEnv(env.WECOM_MAX_RESENDS, 3),
    sendRecovery: env.WECOM_SEND_RECOVERY !== '0',
    msgRatePerMin: numEnv(env.WECOM_MSG_RATE_PER_MIN, 10),
  };
}

/** 数字 env 解析 — 非法值回落默认,不会 NaN 把策略静默打穿。 */
function numEnv(raw: string | undefined, fallback: number): number {
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function formatWecomText(n: NotifyTarget, baseUrl: string): string {
  const icon = SEV_ICON[n.severity] ?? '🔵';
  const label = n.kind === 'alert' ? '告警' : '业务事件';
  const lines = [`${icon}【AO ${label}】${n.title}`];
  if (n.body && n.body !== n.title) {
    lines.push(n.body.length > 300 ? `${n.body.slice(0, 299)}…` : n.body);
  }
  lines.push(`来源:${n.source}${n.agent ? ` · ${n.agent}` : ''}`);
  lines.push(n.kind === 'alert' ? `${baseUrl}/alerts` : `${baseUrl}/notifications`);
  return lines.join('\n');
}

/** docker exec 进 OpenClaw 网关容器跑 CLI 发送(实测 ~2.6s,token 在容器 env 里)。 */
function execDockerSend(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

export class OpenClawWecomChannel implements NotifyChannel {
  readonly id = 'openclaw-wecom';
  /** firing 告警 upsert 复用同一行 id → 以行 id 做窗口抑制 + 补发限次。
   *  sends 达到上限的条目不被清理(永不解除的告警必须记住"已发够了")。 */
  private sent = new Map<string, { lastSentAt: number; sends: number }>();
  /** message 类限流窗口(最近 1 分钟的发送时间戳)。 */
  private msgWindow: number[] = [];

  constructor(
    private readonly deps: {
      exec?: (cmd: string, args: string[]) => Promise<void>;
      env?: EnvLike;
      now?: () => number;
    } = {},
  ) {}

  /** 纯策略判断,可单测:alert 按严重级门槛,message 按信号白名单(+解除推送)。 */
  shouldSend(
    n: NotifyTarget,
    cfg: Pick<WecomCfg, 'minSeverity' | 'eventWhitelist' | 'sendRecovery'>,
  ): boolean {
    if (n.kind === 'alert') {
      return (SEV_RANK[n.severity] ?? 0) >= (SEV_RANK[cfg.minSeverity] ?? 1);
    }
    if (n.signal === RECOVERY_SIGNAL) return cfg.sendRecovery;
    return Boolean(n.signal && cfg.eventWhitelist.has(n.signal));
  }

  async send(n: NotifyTarget): Promise<void> {
    const cfg = readWecomCfg(this.deps.env ?? process.env);
    if (!cfg || !this.shouldSend(n, cfg)) return;
    const now = (this.deps.now ?? Date.now)();

    if (n.kind === 'alert' && cfg.suppressMs > 0) {
      const prev = this.sent.get(n.id);
      if (prev) {
        // 永不解除的告警 × 固定窗口 = 无限轰炸(2026-06-11 审计:~480 条/天)。
        // 首发后最多补发 maxResends 次,之后静默直到解除(解除走 RECOVERY_SIGNAL)。
        if (prev.sends > cfg.maxResends) return;
        if (now - prev.lastSentAt < cfg.suppressMs) return;
      }
      if (this.sent.size > 500) {
        // 粗粒度清理,防长期运行泄漏;窗口外且未达上限的记录已无抑制价值。
        const cutoff = now - cfg.suppressMs;
        for (const [k, v] of this.sent) {
          if (v.lastSentAt < cutoff && v.sends <= cfg.maxResends) this.sent.delete(k);
        }
      }
    }

    if (n.kind === 'message') {
      // 全局限流:白名单业务事件批量突发(如批量邀约)时丢弃超额,不打爆网关
      // (每次 docker exec ~2.6s)。丢弃只影响外推,站内行不受影响。
      this.msgWindow = this.msgWindow.filter((t) => now - t < 60_000);
      if (this.msgWindow.length >= cfg.msgRatePerMin) {
        // eslint-disable-next-line no-console
        console.warn(`[notify:${this.id}] message rate limit (${cfg.msgRatePerMin}/min) — dropped: ${n.title}`);
        return;
      }
      this.msgWindow.push(now);
    }

    const text = formatWecomText(n, cfg.baseUrl);
    const exec = this.deps.exec ?? execDockerSend;
    let okCount = 0;
    let lastErr: Error | null = null;
    for (const target of cfg.targets) {
      // 企微规则:target 必须是「给机器人发过消息」的原始大小写 userId/groupId。
      try {
        await exec('docker', [
          'exec', '-i', cfg.container,
          'node', 'dist/index.js', 'message', 'send',
          '--channel', 'wecom', '--account', cfg.account, '--target', target, '-m', text,
        ]);
        okCount++;
      } catch (e) {
        lastErr = e as Error; // 单 target 失败不中断其余 target
      }
    }
    // 邮戳后移:至少一个 target 真发出去才记账 — 发送失败不该把这条告警
    // 静音一整个抑制窗口(2026-06-11 审计)。
    if (n.kind === 'alert' && okCount > 0) {
      const prev = this.sent.get(n.id);
      this.sent.set(n.id, { lastSentAt: now, sends: (prev?.sends ?? 0) + 1 });
    }
    if (lastErr) throw lastErr; // 交给 dispatchExternal 统一落审计
  }
}

const EXTERNAL_REGISTRY: Record<string, NotifyChannel> = {
  'openclaw-wecom': new OpenClawWecomChannel(),
  feishu: new NoopExternalChannel('feishu'),
  email: new NoopExternalChannel('email'),
  sms: new NoopExternalChannel('sms'),
};

/** External channels enabled via NOTIFY_CHANNELS (csv). 'in_app' is implicit
 *  (the row) and never appears here. Unknown ids are ignored. */
export function enabledExternalChannels(env = process.env.NOTIFY_CHANNELS): NotifyChannel[] {
  return (env ?? 'in_app')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'in_app')
    .map((id) => EXTERNAL_REGISTRY[id])
    .filter((c): c is NotifyChannel => Boolean(c));
}

/** Fan a notification out to every enabled external channel. No-op by default
 *  (in_app only). Never throws — a channel failure must not break ingestion. */
export async function dispatchExternal(n: NotifyTarget): Promise<void> {
  for (const ch of enabledExternalChannels()) {
    try {
      await ch.send(n);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[notify:${ch.id}] send failed: ${(e as Error).message}`);
      // 落审计日志 — 只有 console 的话运维永远不知道外推通道死了
      // (2026-06-11 审计)。fire-and-forget,自身失败也吞。
      void recordLogEvent({
        type: 'anomaly',
        source: 'system',
        message: `外部通知推送失败(${ch.id}):${(e as Error).message?.slice(0, 200)} · ${n.title.slice(0, 80)}`,
      }).catch(() => {});
    }
  }
}
