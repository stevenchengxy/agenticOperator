// Localized verdict label for rule-check results.
//
// Internal status strings (decision `PASS`/`FAIL`, per-rule flag results
// `INSUFFICIENT_INFO`/`REVIEW`/`NOT_TRIGGERED`, second-verdict values) are mapped
// to a single user-facing 通过/不通过 vocabulary — zh: 通过/不通过, en: pass/fail.
// Per-rule states stay granular internally; only the *display* collapses here.
//
// Under the 2026-06-01 fail-closed policy, INSUFFICIENT_INFO / REVIEW(pending) all
// mean 不通过 — the label says so, with a short reason suffix so a reviewer can tell
// an info-gap fail from a hard violation.

type Translate = (key: string) => string;

export function verdictLabel(value: string | null | undefined, t: Translate): string {
  switch ((value ?? '').toUpperCase()) {
    case 'PASS':
      return t('rc_verdict_pass');
    case 'FAIL':
      return t('rc_verdict_fail');
    case 'INSUFFICIENT_INFO':
      return t('rc_verdict_insufficient');
    case 'REVIEW':
    case 'PENDING':
      return t('rc_verdict_review');
    case 'NOT_TRIGGERED':
    case 'NOT_APPLICABLE':
      return t('rc_verdict_na');
    default:
      return value ?? '';
  }
}
