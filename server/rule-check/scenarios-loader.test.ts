import { describe, expect, it } from 'vitest';
import { loadScenarios, loadSharedJds } from './scenarios-loader';

describe('scenarios-loader', () => {
  it('loads all 14 scenarios when no filter', () => {
    const scenarios = loadScenarios();
    expect(scenarios).toHaveLength(14);
    expect(scenarios[0].id).toBe('S01');
    expect(scenarios[13].id).toBe('S14');
  });

  it('filters by scenario ids when provided', () => {
    const scenarios = loadScenarios(['S02', 'S05']);
    expect(scenarios).toHaveLength(2);
    expect(scenarios.map((s) => s.id).sort()).toEqual(['S02', 'S05']);
  });

  it('returns shared JDs', () => {
    const jds = loadSharedJds();
    expect(jds.length).toBeGreaterThan(0);
    expect((jds[0] as { job_requisition_id?: string }).job_requisition_id).toBeDefined();
  });
});
