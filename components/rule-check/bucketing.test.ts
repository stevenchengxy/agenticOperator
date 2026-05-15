import { describe, expect, it } from 'vitest';
import { bucketCell } from './bucketing';

describe('bucketCell', () => {
  it('TN: pass → pass', () => {
    expect(bucketCell('pass', 'pass')).toEqual({ bucket: 'TN', marker: 'match' });
  });
  it('TN: not_triggered → not_triggered', () => {
    expect(bucketCell('not_triggered', 'not_triggered')).toEqual({ bucket: 'TN', marker: 'match' });
  });
  it('TN partial: pass → not_triggered (both clear, different label)', () => {
    expect(bucketCell('pass', 'not_triggered')).toEqual({ bucket: 'TN', marker: 'partial' });
  });
  it('TP: fail → fail', () => {
    expect(bucketCell('fail', 'fail')).toEqual({ bucket: 'TP', marker: 'match' });
  });
  it('TP: pending → pending', () => {
    expect(bucketCell('pending', 'pending')).toEqual({ bucket: 'TP', marker: 'match' });
  });
  it('TP partial: fail → pending (both risk, different label)', () => {
    expect(bucketCell('fail', 'pending')).toEqual({ bucket: 'TP', marker: 'partial' });
  });
  it('FP: pass → fail', () => {
    expect(bucketCell('pass', 'fail')).toEqual({ bucket: 'FP', marker: 'mismatch' });
  });
  it('FP: not_triggered → pending', () => {
    expect(bucketCell('not_triggered', 'pending')).toEqual({ bucket: 'FP', marker: 'mismatch' });
  });
  it('FN: fail → pass', () => {
    expect(bucketCell('fail', 'pass')).toEqual({ bucket: 'FN', marker: 'mismatch' });
  });
  it('FN: pending → not_triggered', () => {
    expect(bucketCell('pending', 'not_triggered')).toEqual({ bucket: 'FN', marker: 'mismatch' });
  });
  it('excluded: not_executed on expected side', () => {
    expect(bucketCell('not_executed', 'pass')).toEqual({ bucket: 'excluded', marker: 'excluded' });
  });
  it('excluded: not_executed on actual side', () => {
    expect(bucketCell('pass', 'not_executed')).toEqual({ bucket: 'excluded', marker: 'excluded' });
  });
  it('missing actual, expected risk → FN with missing marker', () => {
    expect(bucketCell('fail', 'missing-from-actual'))
      .toEqual({ bucket: 'FN', marker: 'missing' });
  });
  it('missing actual, expected clear → FP with missing marker', () => {
    expect(bucketCell('pass', 'missing-from-actual'))
      .toEqual({ bucket: 'FP', marker: 'missing' });
  });
  it('missing expected (no fixture pin) → excluded', () => {
    expect(bucketCell('missing-from-expected', 'pass'))
      .toEqual({ bucket: 'excluded', marker: 'excluded' });
  });
  it('both missing → excluded', () => {
    expect(bucketCell('missing-from-expected', 'missing-from-actual'))
      .toEqual({ bucket: 'excluded', marker: 'excluded' });
  });
});
