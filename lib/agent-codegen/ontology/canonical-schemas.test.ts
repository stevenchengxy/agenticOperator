import { describe, it, expect } from 'vitest';
import {
  CANONICAL_ENTITIES,
  findCanonicalEntity,
  canonicalFieldNames,
  formatCanonicalForPrompt,
} from './canonical-schemas';

describe('CANONICAL_ENTITIES', () => {
  it('covers the 8 entities AO writes to', () => {
    const names = CANONICAL_ENTITIES.map((e) => e.name);
    expect(names).toEqual([
      'Job_Requisition',
      'Job_Posting',
      'Candidate',
      'Resume',
      'Candidate_Match_Result',
      'Communication_Log',
      'Interview_Record',
      'Application',
    ]);
  });

  it('every entity has at least one PK field marked', () => {
    for (const e of CANONICAL_ENTITIES) {
      expect(e.fields.some((f) => f.pk), `${e.name} missing PK`).toBe(true);
    }
  });

  it('every entity has at least one writer mapping', () => {
    for (const e of CANONICAL_ENTITIES) {
      expect(e.writers.length, `${e.name} writers empty`).toBeGreaterThan(0);
    }
  });
});

describe('findCanonicalEntity / canonicalFieldNames', () => {
  it('finds Candidate by name', () => {
    const e = findCanonicalEntity('Candidate');
    expect(e).toBeDefined();
    expect(e!.fields.some((f) => f.name === 'candidate_id' && f.pk)).toBe(true);
  });

  it('returns undefined for unknown entity', () => {
    expect(findCanonicalEntity('Nope_Entity')).toBeUndefined();
  });

  it('canonicalFieldNames returns a Set of the field names', () => {
    const names = canonicalFieldNames('Communication_Log');
    expect(names.has('communication_log_id')).toBe(true);
    expect(names.has('interaction_type')).toBe(true);
    expect(names.has('not_a_real_field')).toBe(false);
  });

  it('canonicalFieldNames returns empty Set for unknown', () => {
    expect(canonicalFieldNames('Nope').size).toBe(0);
  });
});

describe('formatCanonicalForPrompt', () => {
  it('renders a prompt-ready block including the PK + STRICT note', () => {
    const block = formatCanonicalForPrompt('Candidate');
    expect(block).toContain('Canonical Candidate fields');
    expect(block).toContain('candidate_id');
    expect(block).toContain('PK');
    expect(block).toContain('STRICT');
  });

  it('returns null for unknown entity', () => {
    expect(formatCanonicalForPrompt('Nope')).toBeNull();
  });
});
