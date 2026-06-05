import { describe, it, expect } from 'vitest';
import { resolveMonitorConfig, JUDGE_PROMPT_VERSION } from './monitor-config';
import { DEFAULT_THRESHOLDS } from './monitor-types';

describe('resolveMonitorConfig', () => {
  it('falls back to coded defaults when no row exists', () => {
    const c = resolveMonitorConfig(null, '招聘-v1');
    expect(c.samplingPct).toBe(10);
    expect(c.autonomy).toBe('read_only');
    expect(c.judgeFamily).toBeNull();
    expect(c.enabledMonitors).toBeNull();
    expect(c.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it('lets a row override sampling, autonomy and thresholds', () => {
    const c = resolveMonitorConfig(
      {
        domain: '能源调度-v1',
        samplingPct: 25,
        judgeFamily: 'anthropic',
        autonomy: 'notify',
        thresholdsJson: '{"stallMs":1000}',
        enabledMonitorsJson: '["health","groundedness"]',
      },
      '能源调度-v1',
    );
    expect(c.samplingPct).toBe(25);
    expect(c.autonomy).toBe('notify');
    expect(c.thresholds.stallMs).toBe(1000);
    expect(c.thresholds.slaP95Ms).toBe(DEFAULT_THRESHOLDS.slaP95Ms); // others preserved
    expect(c.enabledMonitors).toEqual(['health', 'groundedness']);
  });

  it('rejects an invalid autonomy value', () => {
    const c = resolveMonitorConfig(
      { domain: 'x', samplingPct: 5, judgeFamily: null, autonomy: 'wat', thresholdsJson: null, enabledMonitorsJson: null },
      'x',
    );
    expect(c.autonomy).toBe('read_only');
  });

  it('exposes a judge prompt version constant', () => {
    expect(typeof JUDGE_PROMPT_VERSION).toBe('string');
    expect(JUDGE_PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});
