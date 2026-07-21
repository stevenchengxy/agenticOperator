import { describe, it, expect, vi } from 'vitest';
import { isConnFailure, runWithMirrorFallback } from './mirror-fallback';

describe('isConnFailure — 只把「连不上」算兜底触发,业务错不算', () => {
  it('ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EHOSTUNREACH / EHOSTDOWN / ENETUNREACH 算连接失败', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH']) {
      expect(isConnFailure({ code })).toBe(true);
    }
  });
  it('EHOSTDOWN 主机宕(message,无 code)也算 —— partner-pg LAN 关机时 pg 抛这条', () => {
    expect(isConnFailure(new Error('connect EHOSTDOWN 192.168.1.101:5432 - Local (192.168.1.108:58814)'))).toBe(true);
  });
  it('message 里含 ECONNREFUSED 也算(没 code 时)', () => {
    expect(isConnFailure(new Error('connect ECONNREFUSED 192.168.1.102:5432'))).toBe(true);
  });
  it('pg-pool 连接超时「Connection terminated due to connection timeout」算连接失败(无 ETIMEDOUT code)', () => {
    // node-postgres Pool 在 connectionTimeoutMillis 超时时抛这条 —— 它没有 ETIMEDOUT code/字样,
    // 之前漏匹配 → partner-pg(192.168.1.101)不可达时不走本地镜像兜底(真实 bug)。
    expect(isConnFailure(new Error('Connection terminated due to connection timeout'))).toBe(true);
    expect(isConnFailure(new Error('Connection terminated unexpectedly'))).toBe(true);
  });
  it('SQL 语法错 / 唯一约束 等业务错不算(不该兜底)', () => {
    expect(isConnFailure({ code: '42601' })).toBe(false); // syntax_error
    expect(isConnFailure({ code: '23505' })).toBe(false); // unique_violation
    expect(isConnFailure(new Error('null value in column'))).toBe(false);
  });
});

describe('runWithMirrorFallback — partner 连不上才走镜像', () => {
  it('partner 成功 → 直接返回,不碰镜像', async () => {
    const mirror = vi.fn(async () => 'MIRROR');
    const r = await runWithMirrorFallback(async () => 'PRIMARY', mirror);
    expect(r).toBe('PRIMARY');
    expect(mirror).not.toHaveBeenCalled();
  });
  it('partner 连接失败 + 有镜像 → 走镜像', async () => {
    const mirror = vi.fn(async () => 'MIRROR');
    const r = await runWithMirrorFallback(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }, mirror);
    expect(r).toBe('MIRROR');
    expect(mirror).toHaveBeenCalledTimes(1);
  });
  it('partner 业务错(非连接)→ 原样抛,不走镜像', async () => {
    const mirror = vi.fn(async () => 'MIRROR');
    await expect(
      runWithMirrorFallback(async () => {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }, mirror),
    ).rejects.toThrow('duplicate key');
    expect(mirror).not.toHaveBeenCalled();
  });
  it('没有镜像(prod / 未配置)→ 连接失败也原样抛', async () => {
    await expect(
      runWithMirrorFallback(async () => {
        throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      }, null),
    ).rejects.toThrow('ECONNREFUSED');
  });
});
