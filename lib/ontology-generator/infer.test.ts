import { describe, it, expect } from 'vitest';
import type { EventDef } from '@/lib/events-catalog';
import { findDanglingEvents, inferAgents, buildInferResult, inferFromOntology } from './infer';
import { DOMAIN_PROFILES, getDomainProfile, resolveProfile } from './profiles';
import type { DomainOntology } from './ontology-source';

function ev(partial: Partial<EventDef> & { name: string }): EventDef {
  return {
    stage: 'x', kind: 'domain', rate: 0, err: 0, desc: '',
    publishers: [], subscribers: [], wf: [], emits: [], data: [], mutations: [],
    ...partial,
  };
}

describe('findDanglingEvents', () => {
  it('returns events that are published but have no subscriber', () => {
    const catalog = [
      ev({ name: 'A', publishers: ['P1'], subscribers: [] }),         // dangling
      ev({ name: 'B', publishers: ['P1'], subscribers: ['S1'] }),     // consumed
      ev({ name: 'C', publishers: [], subscribers: [] }),             // not published
      ev({ name: 'D', publishers: ['P2', 'P3'], subscribers: [] }),   // dangling
    ];
    const out = findDanglingEvents(catalog);
    expect(out.map((d) => d.name)).toEqual(['A', 'D']);
    expect(out[1].publishers).toEqual(['P2', 'P3']);
  });

  it('never flags an event that has at least one subscriber', () => {
    const catalog = [ev({ name: 'X', publishers: ['P'], subscribers: ['S'] })];
    expect(findDanglingEvents(catalog)).toEqual([]);
  });
});

describe('inferAgents', () => {
  it('returns the curated candidates for the recruitment domain', () => {
    const r = inferAgents('raas');
    expect(r.domainId).toBe('raas');
    expect(r.candidates.map((c) => c.agentId)).toEqual([
      'MatchResumeAgent',
      'InterviewInviterAgent',
    ]);
    expect(r.counts).toEqual({ rules: 6, dataObjects: 6, actions: 6, events: 6, workflow: 1 });
  });

  it('annotates ontologyGrounded from the live catalog', () => {
    const r = inferAgents('raas');
    const match = r.candidates.find((c) => c.key === 'match-resume')!;
    // MATCH_RULE_CHECK_PASSED is a real event in the catalog.
    expect(match.ontologyGrounded).toBe(true);
  });

  it('echoes the app domain id and returns an empty ontology for an unknown domain', () => {
    const r = inferAgents('cust-xyz', '测试领域');
    expect(r.domainId).toBe('cust-xyz'); // app id echoed, not a curated profile id
    expect(r.candidates).toEqual([]);
    expect(r.counts).toEqual({ rules: 0, dataObjects: 0, actions: 0, events: 0, workflow: 0 });
  });

  it('surfaces real dangling-event signals from the catalog', () => {
    const r = inferAgents('raas');
    expect(Array.isArray(r.danglingEvents)).toBe(true);
  });
});

describe('resolveProfile (app domain → ontology)', () => {
  it('matches by id', () => {
    expect(resolveProfile('raas').candidates[0].agentId).toBe('MatchResumeAgent');
    expect(resolveProfile('feikong').candidates[0].agentId).toBe('InvoiceAuditAgent');
  });

  it('matches real app domains by name/id keyword', () => {
    // R7 · ATS → recruitment; A-采购报销 → expense
    expect(resolveProfile('r7', 'R7 · ATS').candidates[0].agentId).toBe('MatchResumeAgent');
    expect(resolveProfile('cmxyz', 'A-采购报销').candidates[0].agentId).toBe('InvoiceAuditAgent');
  });

  it('falls back to an empty generic ontology for an unmatched domain', () => {
    const p = resolveProfile('cmabc', '测试领域');
    expect(p.candidates).toEqual([]);
    expect(p.counts.rules).toBe(0);
  });

  it('does not substring-false-match short ASCII keywords', () => {
    // "Empowerment" contains "power" but is not an energy domain.
    expect(resolveProfile('cm1', 'Empowerment Training').candidates).toEqual([]);
    // "Threshold" contains "hr" but is not recruitment.
    expect(resolveProfile('cm2', 'Threshold Ops').candidates).toEqual([]);
    // A genuine whole-word match still resolves.
    expect(resolveProfile('cm3', 'HR Platform').candidates[0].agentId).toBe('MatchResumeAgent');
    expect(resolveProfile('cm4', 'Power Grid Ops').candidates[0].agentId).toBe('LoadForecastAgent');
  });
});

describe('buildInferResult — workflow count', () => {
  function onto(partial: Partial<DomainOntology>): DomainOntology {
    return {
      domainId: 't', objects: [], rules: [], actions: [], events: [],
      workflow: [], source: 'snapshot', ...partial,
    };
  }
  it('counts the NUMBER of workflow definitions, not mere presence', () => {
    // Bug: was `onto.workflow ? 1 : 0` → any non-empty list collapsed to 1.
    expect(buildInferResult(onto({ workflow: [{}, {}, {}] })).counts.workflow).toBe(3);
    expect(buildInferResult(onto({ workflow: [] })).counts.workflow).toBe(0);
  });
  it('derives all 28 workflows for the energy snapshot end-to-end', async () => {
    const r = await inferFromOntology('能源调度-v1');
    expect(r.counts.workflow).toBe(28);
  });
});

describe('DOMAIN_PROFILES integrity', () => {
  it('every candidate has the fields generate needs', () => {
    for (const profile of DOMAIN_PROFILES) {
      expect(profile.candidates.length).toBeGreaterThan(0);
      const keys = profile.candidates.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length); // unique within domain
      for (const c of profile.candidates) {
        expect(c.short).toBeTruthy();
        expect(c.slug).toBeTruthy();
        expect(c.triggerEvent).toBeTruthy();
        expect(c.emitEvent).toBeTruthy();
        expect(c.confidence).toBeGreaterThan(0);
        expect(c.confidence).toBeLessThanOrEqual(100);
      }
    }
  });

  it('getDomainProfile resolves known ids and falls back otherwise', () => {
    expect(getDomainProfile('feikong').id).toBe('feikong');
    expect(getDomainProfile('energy').id).toBe('energy');
    expect(getDomainProfile('nope').id).toBe('raas');
  });
});
