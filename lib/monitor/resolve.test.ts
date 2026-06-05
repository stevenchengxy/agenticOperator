import { describe, it, expect } from 'vitest';
import { keysToResolve, resolveStale } from './resolve';

describe('keysToResolve', () => {
  it('returns firing keys not in the active set', () => {
    expect(keysToResolve(['run_stalled.a', 'run_stalled.b'], new Set(['run_stalled.a']))).toEqual([
      'run_stalled.b',
    ]);
  });

  it('returns empty when all firing keys are still active', () => {
    expect(keysToResolve(['k1'], new Set(['k1']))).toEqual([]);
  });
});

describe('resolveStale', () => {
  it('marks firing rows under the prefix that are no longer active as resolved', async () => {
    const marked: string[][] = [];
    const deps = {
      findFiring: async (_prefix: string) => ['run_stalled.a', 'run_stalled.b'],
      markResolved: async (keys: string[]) => {
        marked.push(keys);
      },
    };
    const n = await resolveStale('run_stalled.', new Set(['run_stalled.a']), deps);
    expect(n).toBe(1);
    expect(marked).toEqual([['run_stalled.b']]);
  });

  it('does nothing (no write) when nothing is stale', async () => {
    let wrote = false;
    const deps = {
      findFiring: async () => ['k'],
      markResolved: async () => {
        wrote = true;
      },
    };
    const n = await resolveStale('p', new Set(['k']), deps);
    expect(n).toBe(0);
    expect(wrote).toBe(false);
  });
});
