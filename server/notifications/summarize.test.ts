import { describe, it, expect } from 'vitest';
import { fallbackSummary, parseTriage } from './summarize';

// The AI manager enriches alerts with a Chinese summary + triage. When the LLM
// gateway is down (a top alert source), it must degrade to fallbackSummary —
// pure, no LLM — so the alert is still readable and only-important still holds.

describe('fallbackSummary', () => {
  it('renders a deterministic Chinese line with severity + count', () => {
    const s = fallbackSummary({ source: 'rule-check', severity: 'critical', category: 'system', count: 14, body: '规则校验因基础设施故障挂起(llm-call-error)' });
    expect(s).toContain('rule-check');
    expect(s).toContain('严重');
    expect(s).toContain('14');
    expect(s).toContain('llm-call-error');
  });
  it('omits the count phrase when count is 1', () => {
    const s = fallbackSummary({ source: 'EM', severity: 'warning', category: 'system', count: 1, body: '撮合服务变慢' });
    expect(s).not.toMatch(/\d+\s*次/);
  });
});

describe('parseTriage', () => {
  it('parses a bare JSON object', () => {
    const r = parseTriage('{"summary":"网关认证失败","severity":"critical","should_notify":true}');
    expect(r).toEqual({ summary: '网关认证失败', severity: 'critical', shouldNotify: true });
  });
  it('parses JSON wrapped in a ```json fence', () => {
    const r = parseTriage('```json\n{"summary":"X","severity":"warning","should_notify":false}\n```');
    expect(r).toMatchObject({ summary: 'X', severity: 'warning', shouldNotify: false });
  });
  it('returns null on non-JSON / missing summary', () => {
    expect(parseTriage('not json at all')).toBeNull();
    expect(parseTriage('{"severity":"critical"}')).toBeNull();
  });
});
