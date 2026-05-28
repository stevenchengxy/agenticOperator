// lib/terminal-log.ts
//
// Single source of truth for the AO_TERMINAL_LOG switch — whether log output
// is echoed to the terminal (stdout). File logs (logs/*.log via AO_LOG_DIR)
// are NOT affected by this; only the stdout echo is gated.
//
// In a real deployment the per-step / per-API echo floods the terminal and the
// stdout writes hurt runtime performance, so production is silent by default.
//
//   AO_TERMINAL_LOG = 0 | false | off   → disabled
//   AO_TERMINAL_LOG = 1 | true  | on    → enabled
//   AO_TERMINAL_LOG unset                → enabled in dev,
//                                          disabled when NODE_ENV==='production'
//
// Want logs in a production process for debugging? Set AO_TERMINAL_LOG=1.
//
// Note: console.error / console.warn are intentionally NOT routed through this
// gate — production must keep surfacing failures and degradation warnings.

function resolve(): boolean {
  const raw = process.env.AO_TERMINAL_LOG?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  if (raw) return true; // any other explicit non-empty value → on
  // unset/empty → default depends on environment
  return process.env.NODE_ENV !== 'production';
}

// Evaluated once at module load. NODE_ENV and AO_TERMINAL_LOG are fixed for the
// lifetime of a server process, so there's nothing to re-read.
export const terminalLogEnabled: boolean = resolve();

// Thin gated wrapper around console.log for informational, per-operation lines
// that should obey the switch. Use this instead of bare console.log for any log
// that can fire repeatedly during normal operation.
export function tlog(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  if (terminalLogEnabled) console.log(...args);
}
