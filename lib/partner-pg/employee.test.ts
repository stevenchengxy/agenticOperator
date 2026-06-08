// lib/partner-pg/employee.test.ts
//
// Tests for resolveRecruiterEmail — mocks the partner-pg query module so
// no real Postgres connection is needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock query before module import ──────────────────────────────────────────

let mockRow: { email: string | null; name: string | null } | undefined;

vi.mock('./client', () => ({
  query: vi.fn(async (_text: string, _params?: unknown[]) => {
    if (mockRow === undefined) {
      return { rows: [] };
    }
    return { rows: [mockRow] };
  }),
}));

// Import AFTER mock is set up
import { resolveRecruiterEmail } from './employee';
import { query } from './client';

const mockQuery = vi.mocked(query);

beforeEach(() => {
  mockRow = undefined;
  mockQuery.mockClear();

  // Clear the process-local cache between tests by importing and resetting.
  // We reach into the globalThis cache key defined in the module.
  const cacheKey = '__partnerPgEmployeeCache';
  if ((globalThis as Record<string, unknown>)[cacheKey]) {
    ((globalThis as Record<string, unknown>)[cacheKey] as Map<string, unknown>).clear();
  }
});

describe('resolveRecruiterEmail', () => {
  it('returns { email, name } when a row is found', async () => {
    mockRow = { email: 'alice@example.com', name: 'Alice' };
    const result = await resolveRecruiterEmail('emp_001');
    expect(result).toEqual({ email: 'alice@example.com', name: 'Alice' });
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][1]).toEqual(['emp_001']);
  });

  it('returns null when no row is found', async () => {
    mockRow = undefined;
    const result = await resolveRecruiterEmail('emp_404');
    expect(result).toBeNull();
  });

  it('returns null when the row has a null email', async () => {
    mockRow = { email: null, name: 'Bob' };
    const result = await resolveRecruiterEmail('emp_002');
    expect(result).toBeNull();
  });

  it('returns null when the row has an empty-string email', async () => {
    mockRow = { email: '   ', name: 'Charlie' };
    const result = await resolveRecruiterEmail('emp_003');
    expect(result).toBeNull();
  });

  it('returns null when employeeId is null', async () => {
    const result = await resolveRecruiterEmail(null);
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns null when employeeId is an empty string', async () => {
    const result = await resolveRecruiterEmail('');
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('caches a positive result — second call does NOT re-query', async () => {
    mockRow = { email: 'dana@example.com', name: 'Dana' };
    const r1 = await resolveRecruiterEmail('emp_cached');
    const r2 = await resolveRecruiterEmail('emp_cached');
    expect(r1).toEqual({ email: 'dana@example.com', name: 'Dana' });
    expect(r2).toEqual(r1);
    // Should have queried only once despite two calls
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it('caches a negative (null) result — second call does NOT re-query', async () => {
    mockRow = undefined;
    const r1 = await resolveRecruiterEmail('emp_miss');
    const r2 = await resolveRecruiterEmail('emp_miss');
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(mockQuery).toHaveBeenCalledOnce();
  });
});
