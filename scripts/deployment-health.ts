import { prisma } from "../server/db";

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertFresh(label: string, value: Date | null | undefined, maxAgeMs: number): void {
  if (!value) throw new Error(`${label} heartbeat has not been recorded`);
  const ageMs = Date.now() - value.getTime();
  if (ageMs > maxAgeMs) {
    throw new Error(`${label} heartbeat is stale (${ageMs}ms > ${maxAgeMs}ms)`);
  }
}

async function main(): Promise<void> {
  const component = process.argv[2];
  if (component === "archiver") {
    const cursor = await prisma.inngestArchiveCursor.findUnique({ where: { id: "singleton" } });
    const maxAgeMs = Math.max(positiveNumber("ARCHIVE_INTERVAL_MS", 30_000) * 4, 120_000);
    assertFresh("archiver", cursor?.lastPollAt, maxAgeMs);
    console.log(JSON.stringify({ component, status: "ok", lastPollAt: cursor?.lastPollAt }));
    return;
  }

  if (component === "monitor-sweeper") {
    const heartbeat = await prisma.serviceHeartbeat.findUnique({ where: { id: "monitor-sweeper" } });
    const maxAgeMs = Math.max(positiveNumber("MONITOR_SWEEP_INTERVAL_MS", 60_000) * 4, 240_000);
    assertFresh("monitor-sweeper", heartbeat?.lastHeartbeatAt, maxAgeMs);
    console.log(
      JSON.stringify({ component, status: "ok", lastHeartbeatAt: heartbeat?.lastHeartbeatAt }),
    );
    return;
  }

  throw new Error(`unknown component: ${component ?? "(missing)"}`);
}

main()
  .catch((error) => {
    console.error(`[deployment-health] ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });

