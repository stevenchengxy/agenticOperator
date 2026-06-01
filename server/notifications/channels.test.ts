import { describe, it, expect, vi } from 'vitest';
import { enabledExternalChannels, dispatchExternal } from './channels';

describe('enabledExternalChannels', () => {
  it('is empty by default (in_app only)', () => {
    expect(enabledExternalChannels('in_app')).toEqual([]);
    expect(enabledExternalChannels(undefined)).toEqual([]);
  });
  it('resolves known external ids, ignores in_app + unknown', () => {
    const chans = enabledExternalChannels('in_app,feishu,bogus,email');
    expect(chans.map((c) => c.id).sort()).toEqual(['email', 'feishu']);
  });
});

describe('dispatchExternal', () => {
  it('is a no-op when no external channels enabled (default)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dispatchExternal({
      id: 'n1', severity: 'critical', category: 'system', source: 'rule-check',
      title: 't', body: 'b', runId: null,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
