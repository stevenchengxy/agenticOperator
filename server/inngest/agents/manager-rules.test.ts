import { describe, it, expect } from 'vitest';
import { decideAction } from './manager-rules';
import type { MonitorAlertData } from '@/lib/behavior/types';

function makeAlert(alertKey: string, severity: string = 'error'): MonitorAlertData {
  return {
    alertId: 'alert-001',
    alertKey,
    severity,
    ruleId: alertKey.split('.')[0],
    details: 'test',
    detectedAt: new Date().toISOString(),
  };
}

describe('decideAction — manager-rules v1', () => {
  it('agent_error_rate.* at error → escalate', () => {
    const d = decideAction(makeAlert('agent_error_rate.JDGenerator', 'error'));
    expect(d.action).toBe('escalate');
    expect(d.reason).toContain('20%');
  });

  it('agent_error_rate.* at warning → monitor', () => {
    const d = decideAction(makeAlert('agent_error_rate.JDGenerator', 'warning'));
    expect(d.action).toBe('monitor');
  });

  it('agent_error_rate_degraded.* → monitor', () => {
    const d = decideAction(makeAlert('agent_error_rate_degraded.Publisher', 'warning'));
    expect(d.action).toBe('monitor');
    expect(d.reason).toContain('5–20%');
  });

  it('queue_backlog.* → throttle', () => {
    const d = decideAction(makeAlert('queue_backlog.RESUME_DOWNLOADED', 'warning'));
    expect(d.action).toBe('throttle');
    expect(d.reason).toContain('throttle');
  });

  it('hitl_stale.* → escalate', () => {
    const d = decideAction(makeAlert('hitl_stale.task-abc123', 'warning'));
    expect(d.action).toBe('escalate');
    expect(d.reason).toContain('HITL');
  });

  it('run_stalled.* → escalate', () => {
    const d = decideAction(makeAlert('run_stalled.run-xyz', 'error'));
    expect(d.action).toBe('escalate');
    expect(d.reason).toContain('stalled');
  });

  it('em_degraded → escalate', () => {
    const d = decideAction(makeAlert('em_degraded', 'error'));
    expect(d.action).toBe('escalate');
    expect(d.reason).toContain('SRE');
  });

  it('unknown alert type → monitor (fallback)', () => {
    const d = decideAction(makeAlert('some_unknown_rule.foo', 'warning'));
    expect(d.action).toBe('monitor');
    expect(d.reason).toContain('Unknown alert type');
  });
});
