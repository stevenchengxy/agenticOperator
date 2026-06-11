// OpenClawWecomChannel 策略单测 — 纯逻辑,注入 env/exec/now,不碰 docker。
import { describe, expect, it, vi } from 'vitest';
import { OpenClawWecomChannel, type NotifyTarget } from '@/server/notifications/channels';

type EnvLike = Record<string, string | undefined>;

const BASE_ENV: EnvLike = {
  WECOM_ALERT_TARGETS: 'UserAaa,UserBbb',
};

function target(over: Partial<NotifyTarget> = {}): NotifyTarget {
  return {
    id: 'row-1',
    kind: 'alert',
    severity: 'warning',
    category: 'system',
    source: 'LLM 网关',
    title: 'LLM 网关连续超时',
    body: 'LLM 网关连续超时,最近一次 504',
    runId: null,
    ...over,
  };
}

function makeChannel(env: EnvLike, nowMs = 1_000_000) {
  const exec = vi.fn<(cmd: string, args: string[]) => Promise<void>>(async () => {});
  let now = nowMs;
  const ch = new OpenClawWecomChannel({ exec, env, now: () => now });
  return { ch, exec, advance: (ms: number) => (now += ms) };
}

describe('OpenClawWecomChannel', () => {
  it('未配置 WECOM_ALERT_TARGETS 时静默', async () => {
    const { ch, exec } = makeChannel({});
    await ch.send(target());
    expect(exec).not.toHaveBeenCalled();
  });

  it('warning 告警默认推送,且按 targets 逐个发送', async () => {
    const { ch, exec } = makeChannel(BASE_ENV);
    await ch.send(target());
    expect(exec).toHaveBeenCalledTimes(2);
    const args = exec.mock.calls[0][1];
    expect(args).toContain('wecom');
    expect(args).toContain('UserAaa');
    expect(args.join(' ')).toContain('message send');
  });

  it('info 告警不推送;minSeverity=critical 时 warning 被挡、critical 通过', async () => {
    const { ch, exec } = makeChannel(BASE_ENV);
    await ch.send(target({ severity: 'info', id: 'r-info' }));
    expect(exec).not.toHaveBeenCalled();

    const strict = makeChannel({ ...BASE_ENV, WECOM_ALERT_MIN_SEVERITY: 'critical' });
    await strict.ch.send(target({ id: 'r-w' }));
    expect(strict.exec).not.toHaveBeenCalled();
    await strict.ch.send(target({ severity: 'critical', id: 'r-c' }));
    expect(strict.exec).toHaveBeenCalledTimes(2);
  });

  it('业务事件:白名单信号推送,其余不推', async () => {
    const { ch, exec } = makeChannel(BASE_ENV);
    const msg = target({
      kind: 'message',
      severity: 'info',
      title: '面试邀约已发送',
      body: '面试邀约已发送',
    });
    await ch.send({ ...msg, id: 'm-1', signal: 'INTERVIEW_INVITATION_SENT' });
    expect(exec).toHaveBeenCalledTimes(2);
    await ch.send({ ...msg, id: 'm-2', signal: 'RESUME_PROCESSED' });
    await ch.send({ ...msg, id: 'm-3', signal: null });
    expect(exec).toHaveBeenCalledTimes(2); // 仍是 2:后两条没发
  });

  it('白名单可由 env 覆盖', async () => {
    const { ch, exec } = makeChannel({ ...BASE_ENV, WECOM_EVENT_WHITELIST: 'RESUME_PROCESSED' });
    await ch.send(target({ kind: 'message', id: 'm-4', signal: 'RESUME_PROCESSED' }));
    expect(exec).toHaveBeenCalledTimes(2);
    await ch.send(target({ kind: 'message', id: 'm-5', signal: 'INTERVIEW_INVITATION_SENT' }));
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('同一 firing 告警行在窗口内只推一次,窗口过后可再推', async () => {
    const { ch, exec, advance } = makeChannel(BASE_ENV); // 默认抑制 15min
    await ch.send(target());
    await ch.send(target()); // 同 id 重复发生
    expect(exec).toHaveBeenCalledTimes(2); // 2 个 target × 1 次
    advance(16 * 60_000);
    await ch.send(target());
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('不同告警行不互相抑制', async () => {
    const { ch, exec } = makeChannel(BASE_ENV);
    await ch.send(target({ id: 'a' }));
    await ch.send(target({ id: 'b' }));
    expect(exec).toHaveBeenCalledTimes(4);
  });
});
