import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ontology-gen', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ontology-gen')>(
    '@/lib/ontology-gen',
  );
  return {
    ...actual,
    fetchAction: vi.fn(),
  };
});

import { fetchAction, OntologyContractError } from '@/lib/ontology-gen';
import { fetchRulesForMatchResume } from './ontology-source';

const mockFetchAction = vi.mocked(fetchAction);

const ORIGINAL_BASE = process.env.ALLMETA_BASE_URL;
const ORIGINAL_TOKEN = process.env.ALLMETA_API_KEY;

afterEach(() => {
  mockFetchAction.mockReset();
  if (ORIGINAL_BASE === undefined) delete process.env.ALLMETA_BASE_URL;
  else process.env.ALLMETA_BASE_URL = ORIGINAL_BASE;
  if (ORIGINAL_TOKEN === undefined) delete process.env.ALLMETA_API_KEY;
  else process.env.ALLMETA_API_KEY = ORIGINAL_TOKEN;
});

describe('fetchRulesForMatchResume — env gating', () => {
  it('no ALLMETA_BASE_URL → JSON fallback, no API call', async () => {
    delete process.env.ALLMETA_BASE_URL;
    process.env.ALLMETA_API_KEY = 'tok';
    const out = await fetchRulesForMatchResume();
    expect(out.source).toBe('json-fallback');
    expect(out.rules.length).toBeGreaterThan(0);
    expect(mockFetchAction).not.toHaveBeenCalled();
  });

  it('no ALLMETA_API_KEY → JSON fallback, no API call', async () => {
    process.env.ALLMETA_BASE_URL = 'http://localhost:3500';
    delete process.env.ALLMETA_API_KEY;
    const out = await fetchRulesForMatchResume();
    expect(out.source).toBe('json-fallback');
    expect(mockFetchAction).not.toHaveBeenCalled();
  });
});

describe('fetchRulesForMatchResume — API path', () => {
  beforeEach(() => {
    process.env.ALLMETA_BASE_URL = 'http://localhost:3500';
    process.env.ALLMETA_API_KEY = 'tok';
  });

  it('API success + rule_ids match JSON → source=ontology-api, no drift', async () => {
    // 用 rules.json 的真实 rule_id 集合做 mock,确保 drift 为空
    const { loadAllRules } = await import('./ontology');
    const allJsonIds = loadAllRules().map((r) => r.id);
    mockFetchAction.mockResolvedValueOnce({
      id: '10',
      name: 'matchResume',
      description: '',
      submissionCriteria: '',
      objectType: 'action',
      category: '',
      actor: [],
      trigger: [],
      targetObjects: [],
      inputs: [],
      outputs: [],
      sideEffects: { dataChanges: [], notifications: [] },
      triggeredEvents: [],
      actionSteps: [
        {
          order: 1,
          name: 'step1',
          description: '',
          objectType: 'logic',
          rules: allJsonIds.map((id) => ({
            id,
            submissionCriteria: '',
            description: '',
            severity: 'advisory',
          })),
          inputs: [],
          outputs: [],
        },
      ],
    });

    const out = await fetchRulesForMatchResume();
    expect(out.source).toBe('ontology-api');
    expect(out.drift).toBeUndefined();
    expect(out.rules.length).toBe(allJsonIds.length);
  });

  it('API returns extra rule_id not in JSON → drift.only_in_api recorded', async () => {
    mockFetchAction.mockResolvedValueOnce({
      id: '10',
      name: 'matchResume',
      description: '',
      submissionCriteria: '',
      objectType: 'action',
      category: '',
      actor: [],
      trigger: [],
      targetObjects: [],
      inputs: [],
      outputs: [],
      sideEffects: { dataChanges: [], notifications: [] },
      triggeredEvents: [],
      actionSteps: [
        {
          order: 1,
          name: 'step1',
          description: '',
          objectType: 'logic',
          rules: [
            { id: '10-5', submissionCriteria: '', description: '', severity: 'blocker' },
            { id: '10-9999-future', submissionCriteria: '', description: '', severity: 'advisory' },
          ],
          inputs: [],
          outputs: [],
        },
      ],
    });

    const out = await fetchRulesForMatchResume();
    expect(out.source).toBe('ontology-api');
    expect(out.drift?.only_in_api).toContain('10-9999-future');
    // 10-5 在 JSON 里有,所以 returned rules 应该只有 1 个(去掉 only_in_api 那条没 metadata 的)
    expect(out.rules.map((r) => r.id)).toContain('10-5');
    expect(out.rules.map((r) => r.id)).not.toContain('10-9999-future');
  });

  it('API returns 0 rules → fallback to JSON with api_error marker', async () => {
    mockFetchAction.mockResolvedValueOnce({
      id: '10',
      name: 'matchResume',
      description: '',
      submissionCriteria: '',
      objectType: 'action',
      category: '',
      actor: [],
      trigger: [],
      targetObjects: [],
      inputs: [],
      outputs: [],
      sideEffects: { dataChanges: [], notifications: [] },
      triggeredEvents: [],
      actionSteps: [],
    });

    const out = await fetchRulesForMatchResume();
    expect(out.source).toBe('json-fallback');
    expect(out.api_error).toBe('API returned 0 rules');
  });

  it('API throws OntologyContractError → fallback with error summary', async () => {
    mockFetchAction.mockRejectedValueOnce(
      new OntologyContractError('schema mismatch', { reason: 'test' }),
    );
    const out = await fetchRulesForMatchResume();
    expect(out.source).toBe('json-fallback');
    expect(out.api_error).toContain('OntologyContractError');
    expect(out.api_error).toContain('schema mismatch');
  });

  it('API throws network error → fallback', async () => {
    mockFetchAction.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const out = await fetchRulesForMatchResume();
    expect(out.source).toBe('json-fallback');
    expect(out.api_error).toContain('ECONNREFUSED');
  });
});

describe('fetchRulesForMatchResume — grouped steps', () => {
  it('emits steps[] with order, name, description, condition, rules', async () => {
    process.env.ALLMETA_BASE_URL = 'http://localhost:3500';
    process.env.ALLMETA_API_KEY = 'tok';
    mockFetchAction.mockResolvedValueOnce({
      actionSteps: [
        {
          id: '10::s2',
          name: 'matchHardRequirements',
          order: '2',
          description: 'desc 2',
          condition: 'cond 2',
          rules: [{ id: '10-5' }, { id: '10-21' }],
        },
        {
          id: '10::s1',
          name: 'validateRedlineAndBlacklist',
          order: '1',
          description: 'desc 1',
          condition: 'cond 1',
          rules: [{ id: '10-25' }],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchAction>>);

    const out = await fetchRulesForMatchResume();
    expect(out.steps).toBeDefined();
    expect(out.steps).toHaveLength(2);
    // Ordered by numeric order ascending
    expect(out.steps![0].name).toBe('validateRedlineAndBlacklist');
    expect(out.steps![1].name).toBe('matchHardRequirements');
    expect(out.steps![0].order).toBe(1);
    expect(out.steps![0].rules.map((r) => r.id)).toEqual(['10-25']);
    expect(out.steps![1].rules.map((r) => r.id)).toEqual(['10-5', '10-21']);
  });

  it('omits steps[] when falling back to JSON', async () => {
    delete process.env.ALLMETA_BASE_URL; // forces fallback
    const out = await fetchRulesForMatchResume();
    expect(out.source).toBe('json-fallback');
    expect(out.steps).toBeUndefined();
  });
});
