// Next.js instrumentation hook — runs once when the server process boots.
// We use it for backend liveness: record this boot (and detect a crash-restart
// from the previous run's heartbeat), start a periodic heartbeat, and install
// SIGTERM/SIGINT handlers that flip the clean-shutdown flag so the NEXT boot
// can tell a graceful restart from a crash. See
// 2026-06-01-system-health-notifications-design.md §3.
//
// Guarded to the Node.js runtime — the Edge runtime has no Prisma/process. The
// liveness logic lives in @/server/health/boot (dynamically imported) so its
// process.* APIs never reach the Edge bundle.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { recordBoot, startHeartbeat, installShutdownHandlers } = await import('@/server/health/boot');

  await recordBoot();
  startHeartbeat();
  installShutdownHandlers();
}
