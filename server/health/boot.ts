// Backend liveness — boot/crash detection for the AO server (spec §3).
//
// instrumentation.ts#register calls recordBoot() once per process start and
// starts a heartbeat. A clean SIGTERM/SIGINT calls markCleanShutdown(). On the
// NEXT boot, a previous row with cleanShutdown=false means the process died
// without shutting down → a critical "异常重启" notification. The classification
// (evaluateBoot) and the notification framing (bootNotification) are PURE +
// deterministic (zero LLM); only the persistence wrappers touch the DB, and
// they never throw — a liveness write must not break the server starting.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prisma } from '@/server/db';
import { recordNotification } from '@/server/notifications/ingest';
import type { CaptureInput } from '@/server/notifications/derive';

const HEARTBEAT_ID = 'default';
const HEARTBEAT_INTERVAL_MS = 30_000;

// Clean-shutdown is recorded by a SYNCHRONOUS marker file written inside the
// signal handler — the async DB flag can't be relied on, because Next.js's own
// SIGTERM handler exits the process before an async DB write flushes (every
// clean restart would then falsely read as a crash). The marker write is
// instant and the boot decision treats marker-present OR the DB flag as clean.
const CLEAN_MARKER_PATH =
  process.env.AO_SHUTDOWN_MARKER ?? path.join(os.tmpdir(), 'ao-clean-shutdown.marker');

/** Read + clear the clean-shutdown marker. True ⇒ the previous run shut down
 *  gracefully. Best-effort; any fs error reads as "no marker" (→ crash). */
export function consumeCleanMarker(markerPath = CLEAN_MARKER_PATH): boolean {
  try {
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
      return true;
    }
  } catch {
    /* treat as absent */
  }
  return false;
}

function writeCleanMarker(markerPath = CLEAN_MARKER_PATH): void {
  try {
    fs.writeFileSync(markerPath, new Date().toISOString());
  } catch {
    /* best-effort */
  }
}

export type BootKind = 'first' | 'clean' | 'crash';

export interface BootPrev {
  cleanShutdown: boolean;
  lastHeartbeatAt: Date | null;
  bootCount: number;
}

export interface BootVerdict {
  kind: BootKind;
  /** Approximate downtime since the last heartbeat, only meaningful for 'crash'. */
  downtimeMs: number | null;
  bootCount: number;
}

/**
 * Classify a boot from the previous heartbeat row + the clean-shutdown marker.
 * PURE — unit-tested.
 *   null prev                       → 'first'  (fresh install / wiped DB)
 *   marker present OR DB clean flag → 'clean'  (graceful restart / deploy)
 *   neither                         → 'crash'  (process died without shutting down)
 */
export function evaluateBoot(
  prev: BootPrev | null,
  cleanMarker: boolean,
  now: Date,
): BootVerdict {
  if (!prev) return { kind: 'first', downtimeMs: null, bootCount: 1 };
  const bootCount = prev.bootCount + 1;
  if (cleanMarker || prev.cleanShutdown) return { kind: 'clean', downtimeMs: null, bootCount };
  const downtimeMs = prev.lastHeartbeatAt
    ? Math.max(0, now.getTime() - prev.lastHeartbeatAt.getTime())
    : null;
  return { kind: 'crash', downtimeMs, bootCount };
}

/**
 * Frame a boot verdict as a notification capture. PURE — unit-tested.
 *   crash → critical system alert (notifies + triggers AI analysis)
 *   first/clean → info system_lifecycle message (shows in center, no alarm)
 */
export function bootNotification(v: BootVerdict): CaptureInput {
  if (v.kind === 'crash') {
    const mins = v.downtimeMs != null ? Math.round(v.downtimeMs / 60000) : null;
    const gap = mins != null ? (mins > 0 ? `,停机约 ${mins} 分钟` : ',停机不到 1 分钟') : '';
    return {
      level: 'critical',
      category: 'system',
      source: '系统',
      dedupeHint: 'backend_crash_restart',
      message: `后端异常重启 · 上次未正常关闭${gap}(第 ${v.bootCount} 次启动)`,
    };
  }
  const label = v.kind === 'first' ? '首次启动' : '正常重启';
  return {
    level: 'info',
    category: 'system_lifecycle',
    source: '系统',
    message: `后端服务已启动(${label} · 第 ${v.bootCount} 次)`,
  };
}

/**
 * Record this process's boot: read the prior heartbeat, classify it, fire the
 * notification, then persist a fresh boot row (cleanShutdown=false until a
 * graceful shutdown flips it). Never throws.
 */
export async function recordBoot(now = new Date()): Promise<BootVerdict | null> {
  try {
    const cleanMarker = consumeCleanMarker();
    const prev = await prisma.serviceHeartbeat.findUnique({ where: { id: HEARTBEAT_ID } });
    const verdict = evaluateBoot(prev, cleanMarker, now);

    // Fire-and-forget — a notification failure must not block startup.
    void recordNotification(bootNotification(verdict)).catch(() => {});

    await prisma.serviceHeartbeat.upsert({
      where: { id: HEARTBEAT_ID },
      create: {
        id: HEARTBEAT_ID,
        bootCount: verdict.bootCount,
        lastBootAt: now,
        lastHeartbeatAt: now,
        cleanShutdown: false,
        pid: process.pid,
      },
      update: {
        bootCount: verdict.bootCount,
        lastBootAt: now,
        lastHeartbeatAt: now,
        cleanShutdown: false,
        pid: process.pid,
      },
    });
    return verdict;
  } catch (e) {
    console.warn(`[health] recordBoot failed: ${(e as Error).message}`);
    return null;
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Start a periodic liveness ping. Idempotent; the timer is unref'd so it never
 *  keeps the process alive on its own. */
export function startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void prisma.serviceHeartbeat
      .update({ where: { id: HEARTBEAT_ID }, data: { lastHeartbeatAt: new Date() } })
      .catch(() => {});
  }, intervalMs);
  heartbeatTimer.unref?.();
}

/** Mark the current run as cleanly shut down so the next boot reads 'clean'. */
export async function markCleanShutdown(): Promise<void> {
  try {
    await prisma.serviceHeartbeat.update({
      where: { id: HEARTBEAT_ID },
      data: { cleanShutdown: true },
    });
  } catch {
    // best-effort during shutdown
  }
}

let shutdownInstalled = false;

/**
 * On SIGTERM/SIGINT, record a graceful shutdown so the NEXT boot reads 'clean'.
 * Writes the marker file SYNCHRONOUSLY (survives an immediate process exit) and
 * also kicks the async DB flag (best-effort). Registered with prependListener
 * so it runs before Next.js's own signal handler exits the process; we then let
 * that handler perform the actual graceful teardown. Lives here (not
 * instrumentation.ts) so the process.* APIs stay out of the Edge bundle.
 */
export function installShutdownHandlers(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const onSignal = () => {
    writeCleanMarker(); // synchronous — the authoritative clean-shutdown signal
    void markCleanShutdown().catch(() => {}); // best-effort DB flag (may not flush)
  };
  process.prependListener('SIGTERM', onSignal);
  process.prependListener('SIGINT', onSignal);
}
