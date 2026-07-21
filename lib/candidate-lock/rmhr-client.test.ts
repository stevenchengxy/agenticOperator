import { describe, it, expect } from 'vitest';
import { parseRmhrResponse, RmhrApiError } from './rmhr-client';
import { LockState } from './types';

const ok = {
  code: 200, msg: 'success', timestamp: 1,
  data: { code: 1000, msg: '操作成功', success: true,
    model: JSON.stringify({ resumeId: 10086, lockState: 2, lockBy: '0006001111',
      lockByName: '王五', lockByEmail: 'wangwu@company.com', lockTime: '2026-03-01 10:00:00',
      message: '重复简历，已被他人锁定' }) },
};

describe('parseRmhrResponse', () => {
  it('parses two-layer success + JSON-string model into a snapshot', () => {
    const s = parseRmhrResponse(ok);
    expect(s.rmhrResumeId).toBe('10086');
    expect(s.lockState).toBe(LockState.LOCKED);
    expect(s.lockByEmail).toBe('wangwu@company.com');
    expect(s.lockTime).toBe('2026-03-01 10:00:00');
  });
  it('detects blacklist from the message branch', () => {
    const bl = { ...ok, data: { ...ok.data, model: JSON.stringify({ resumeId: 1, lockState: 2, lockBy: 'x', lockByName: 'x', lockByEmail: 'x@x.com', lockTime: null, message: '黑名单，无法锁定' }) } };
    expect(parseRmhrResponse(bl).blacklisted).toBe(true);
  });
  it('throws BUSINESS RmhrApiError on data.code 1001', () => {
    const biz = { code: 200, msg: 'success', timestamp: 1, data: { code: 1001, msg: '招聘邮箱不存在，不入库', success: false, model: null } };
    expect(() => parseRmhrResponse(biz)).toThrow(RmhrApiError);
    try { parseRmhrResponse(biz); } catch (e) { expect((e as RmhrApiError).code).toBe('BUSINESS'); }
  });
  it('throws non-BUSINESS (infra) when model is unparseable', () => {
    const bad = { code: 200, msg: 'success', timestamp: 1, data: { code: 1000, msg: 'ok', success: true, model: '{not json' } };
    try { parseRmhrResponse(bad); expect.fail('should throw'); } catch (e) { expect((e as RmhrApiError).code).not.toBe('BUSINESS'); }
  });
});
