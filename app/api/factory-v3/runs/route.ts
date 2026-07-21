import { requireFactoryAuth } from "@/lib/factory-auth";
import { prisma } from "@/server/db";
import { isActiveRun } from "@/lib/agent-factory-v3/brain/run-registry";

export const dynamic = "force-dynamic";

/**
 * GET /api/factory-v3/runs?domain=<id>&limit=20 — list recent brain runs for a
 * domain (lightweight: no transcript). Powers the chatbot's 历史运行 list so the
 * user can reopen a past generation after a refresh. (Fix #3.)
 *
 * Typed-then-raw-SQL: HMR may leave the dev server's Prisma client without the
 * FactoryBrainRun accessor until `npm run dev` restarts.
 */
export async function GET(req: Request): Promise<Response> {
  const denied = requireFactoryAuth(req, { allowQueryToken: true });
  if (denied) return denied;

  const url = new URL(req.url);
  const domain = url.searchParams.get("domain") ?? undefined;
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));

  try {
    const pc = prisma as unknown as {
      factoryBrainRun?: {
        findMany: (a: unknown) => Promise<unknown[]>;
        updateMany?: (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
      };
    };
    // Zombie sweep: rows stuck 'running' with NO live driver (server/HMR restart
    // orphaned them) and past a short grace window → mark aborted, so the history
    // list never shows eternal "运行中". A genuinely in-flight run is in the live
    // registry (isActiveRun) and is therefore never swept. Best-effort, typed-only.
    try {
      if (pc.factoryBrainRun?.findMany && pc.factoryBrainRun?.updateMany) {
        const running = (await pc.factoryBrainRun.findMany({
          where: { status: "running", ...(domain ? { domain } : {}) },
          select: { id: true, createdAt: true }, take: 100,
        })) as Array<{ id: string; createdAt: Date }>;
        const now = Date.now();
        const zombies = running.filter((r) => !isActiveRun(r.id) && now - new Date(r.createdAt).getTime() > 120_000).map((r) => r.id);
        if (zombies.length) await pc.factoryBrainRun.updateMany({ where: { id: { in: zombies } }, data: { status: "aborted", errorMessage: "运行中断（服务器重启/进程丢失，无活跃驱动）" } });
      }
    } catch { /* sweep is best-effort */ }
    let rows: Array<Record<string, unknown>>;
    if (pc.factoryBrainRun?.findMany) {
      rows = (await pc.factoryBrainRun.findMany({
        where: domain ? { domain } : undefined,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true, domain: true, goal: true, status: true, tokensUsed: true,
          turns: true, agentsCount: true, reachedTerminal: true, createdAt: true,
        },
      })) as Array<Record<string, unknown>>;
    } else {
      rows = domain
        ? await prisma.$queryRawUnsafe(
            `SELECT "id","domain","goal","status","tokensUsed","turns","agentsCount","reachedTerminal","createdAt" FROM "FactoryBrainRun" WHERE "domain"=$1 ORDER BY "createdAt" DESC LIMIT ${limit}`,
            domain,
          )
        : await prisma.$queryRawUnsafe(
            `SELECT "id","domain","goal","status","tokensUsed","turns","agentsCount","reachedTerminal","createdAt" FROM "FactoryBrainRun" ORDER BY "createdAt" DESC LIMIT ${limit}`,
          );
    }
    return Response.json({ runs: rows });
  } catch (e) {
    // Table may not exist yet on a stale dev process — return empty, don't 500.
    console.error("[factory-v3 runs] list failed:", (e as Error).message);
    return Response.json({ runs: [] });
  }
}
