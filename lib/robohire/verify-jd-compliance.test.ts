import { describe, it, expect } from 'vitest';
import { verifyJdCompliance } from './verify-jd-compliance';

describe('verifyJdCompliance — ontology rule 4-2: JD must not expose the client name', () => {
  it('replaces the client real name with the anonymized descriptor and records a fix', () => {
    const r = verifyJdCompliance('欢迎加入字节跳动，与字节跳动一起成长', {
      clientName: '字节跳动',
      companyDescriptor: '某互联网行业知名企业',
    });
    expect(r.content).toBe('欢迎加入某互联网行业知名企业，与某互联网行业知名企业一起成长');
    expect(r.fixes.length).toBeGreaterThan(0);
  });

  it('is a no-op when the client name does not appear', () => {
    const r = verifyJdCompliance('高级后端工程师，负责核心系统', {
      clientName: '字节跳动',
      companyDescriptor: '某互联网行业知名企业',
    });
    expect(r.content).toBe('高级后端工程师，负责核心系统');
    expect(r.fixes).toEqual([]);
  });

  it('falls back to a generic descriptor when none is provided', () => {
    const r = verifyJdCompliance('加入字节跳动', { clientName: '字节跳动' });
    expect(r.content).toBe('加入某知名企业');
    expect(r.fixes.length).toBe(1);
  });

  it('matches latin client names case-insensitively', () => {
    const r = verifyJdCompliance('Join ACME Corp today', {
      clientName: 'Acme Corp',
      companyDescriptor: 'a leading firm',
    });
    expect(r.content).toBe('Join a leading firm today');
    expect(r.fixes.length).toBe(1);
  });

  it('is a no-op when clientName is empty / too short to be an identity', () => {
    expect(verifyJdCompliance('内容', { clientName: '' }).content).toBe('内容');
    expect(verifyJdCompliance('内容', { clientName: null }).content).toBe('内容');
    expect(verifyJdCompliance('A公司在A', { clientName: 'A' }).fixes).toEqual([]); // 1-char → skip
  });

  it('does not throw and preserves content on non-string input', () => {
    expect(verifyJdCompliance('', { clientName: '字节跳动' }).content).toBe('');
  });
});
