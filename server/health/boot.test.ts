import { describe, it, expect } from 'vitest';
import { evaluateBoot, bootNotification } from './boot';

describe('evaluateBoot', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  it('classifies a missing prior row as first boot', () => {
    const v = evaluateBoot(null, false, now);
    expect(v).toEqual({ kind: 'first', downtimeMs: null, bootCount: 1 });
  });

  it('classifies a clean-marker present as a clean restart (even if DB flag stale)', () => {
    const v = evaluateBoot(
      { cleanShutdown: false, lastHeartbeatAt: new Date('2026-06-01T11:50:00Z'), bootCount: 4 },
      true, // marker present
      now,
    );
    expect(v.kind).toBe('clean');
    expect(v.downtimeMs).toBeNull();
    expect(v.bootCount).toBe(5);
  });

  it('classifies a DB clean flag as a clean restart (even without a marker)', () => {
    const v = evaluateBoot(
      { cleanShutdown: true, lastHeartbeatAt: new Date('2026-06-01T11:50:00Z'), bootCount: 4 },
      false,
      now,
    );
    expect(v.kind).toBe('clean');
  });

  it('classifies no-marker + non-clean DB flag as a crash with downtime from last heartbeat', () => {
    const v = evaluateBoot(
      { cleanShutdown: false, lastHeartbeatAt: new Date('2026-06-01T11:57:00Z'), bootCount: 4 },
      false,
      now,
    );
    expect(v.kind).toBe('crash');
    expect(v.downtimeMs).toBe(3 * 60 * 1000);
    expect(v.bootCount).toBe(5);
  });

  it('crash with no recorded heartbeat reports null downtime', () => {
    const v = evaluateBoot({ cleanShutdown: false, lastHeartbeatAt: null, bootCount: 0 }, false, now);
    expect(v.kind).toBe('crash');
    expect(v.downtimeMs).toBeNull();
  });

  it('never reports negative downtime when clocks skew', () => {
    const v = evaluateBoot(
      { cleanShutdown: false, lastHeartbeatAt: new Date('2026-06-01T12:05:00Z'), bootCount: 1 },
      false,
      now,
    );
    expect(v.downtimeMs).toBe(0);
  });
});

describe('bootNotification', () => {
  it('frames a crash as a critical system alert with the crash dedupe key', () => {
    const n = bootNotification({ kind: 'crash', downtimeMs: 3 * 60 * 1000, bootCount: 5 });
    expect(n.level).toBe('critical');
    expect(n.category).toBe('system');
    expect(n.dedupeHint).toBe('backend_crash_restart');
    expect(n.message).toContain('异常重启');
    expect(n.message).toContain('3 分钟');
  });

  it('handles sub-minute downtime crash framing', () => {
    const n = bootNotification({ kind: 'crash', downtimeMs: 20_000, bootCount: 2 });
    expect(n.message).toContain('不到 1 分钟');
  });

  it('frames a clean restart as an info system_lifecycle message', () => {
    const n = bootNotification({ kind: 'clean', downtimeMs: null, bootCount: 5 });
    expect(n.level).toBe('info');
    expect(n.category).toBe('system_lifecycle');
    expect(n.message).toContain('正常重启');
  });

  it('frames first boot as an info system_lifecycle message', () => {
    const n = bootNotification({ kind: 'first', downtimeMs: null, bootCount: 1 });
    expect(n.level).toBe('info');
    expect(n.category).toBe('system_lifecycle');
    expect(n.message).toContain('首次启动');
  });
});
