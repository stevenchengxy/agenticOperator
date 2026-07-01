// Idempotent creation of the Agent Factory ledger tables (FactoryBuildRun /
// FactoryBuildEvent / FactoryLlmCall) via the app's own Prisma connection.
//
// Why a script and not `prisma db push`: the working tree has an unrelated,
// destructive pending migration (drops AgentVersion.liveExecution, 452 rows) we
// must NOT apply. This adds ONLY the three additive Factory tables and touches
// nothing else. Safe to re-run.
//
// Run: npx dotenvx run -f .env.local -- npx tsx scripts/factory-db-setup.ts
import { prisma } from "@/server/db";

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS "FactoryBuildRun" (
     "id" TEXT NOT NULL,
     "domain" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'running',
     "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "finishedAt" TIMESTAMP(3),
     "tokensUsed" INTEGER NOT NULL DEFAULT 0,
     "note" TEXT,
     CONSTRAINT "FactoryBuildRun_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "FactoryBuildRun_domain_startedAt_idx" ON "FactoryBuildRun"("domain","startedAt")`,
  `CREATE TABLE IF NOT EXISTS "FactoryBuildEvent" (
     "id" TEXT NOT NULL,
     "runId" TEXT NOT NULL,
     "seq" INTEGER NOT NULL,
     "type" TEXT NOT NULL,
     "payload" TEXT NOT NULL,
     "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "FactoryBuildEvent_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "FactoryBuildEvent_runId_seq_idx" ON "FactoryBuildEvent"("runId","seq")`,
  `CREATE TABLE IF NOT EXISTS "FactoryLlmCall" (
     "id" TEXT NOT NULL,
     "runId" TEXT NOT NULL,
     "builder" TEXT NOT NULL,
     "target" TEXT,
     "purpose" TEXT NOT NULL,
     "systemPrompt" TEXT NOT NULL,
     "userPrompt" TEXT NOT NULL,
     "responseText" TEXT NOT NULL,
     "model" TEXT,
     "promptTokens" INTEGER NOT NULL DEFAULT 0,
     "completionTokens" INTEGER NOT NULL DEFAULT 0,
     "latencyMs" INTEGER NOT NULL DEFAULT 0,
     "degraded" BOOLEAN NOT NULL DEFAULT false,
     "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "FactoryLlmCall_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "FactoryLlmCall_runId_ts_idx" ON "FactoryLlmCall"("runId","ts")`,
  `ALTER TABLE "FactoryBuildEvent" DROP CONSTRAINT IF EXISTS "FactoryBuildEvent_runId_fkey"`,
  `ALTER TABLE "FactoryBuildEvent" ADD CONSTRAINT "FactoryBuildEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FactoryBuildRun"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  `ALTER TABLE "FactoryLlmCall" DROP CONSTRAINT IF EXISTS "FactoryLlmCall_runId_fkey"`,
  `ALTER TABLE "FactoryLlmCall" ADD CONSTRAINT "FactoryLlmCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FactoryBuildRun"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
];

async function main() {
  for (const s of STATEMENTS) await prisma.$executeRawUnsafe(s);
  const [runs, events, calls] = await Promise.all([
    prisma.factoryBuildRun.count(),
    prisma.factoryBuildEvent.count(),
    prisma.factoryLlmCall.count(),
  ]);
  console.log(`✓ Factory tables ready — FactoryBuildRun=${runs} FactoryBuildEvent=${events} FactoryLlmCall=${calls}`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("✗ setup failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
