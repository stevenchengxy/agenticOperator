import { requireFactoryAuth } from "@/lib/factory-auth";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/factory-v3/runs/[id] — one brain run WITH its full transcript
 * (BrainEvent[]), so the chatbot can reopen a past generation read-only. (Fix #3.)
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireFactoryAuth(req, { allowQueryToken: true });
  if (denied) return denied;

  const { id } = await ctx.params;
  try {
    const pc = prisma as unknown as {
      factoryBrainRun?: { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> };
    };
    let row: Record<string, unknown> | null;
    if (pc.factoryBrainRun?.findUnique) {
      row = await pc.factoryBrainRun.findUnique({ where: { id } });
    } else {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT * FROM "FactoryBrainRun" WHERE "id"=$1 LIMIT 1`,
        id,
      )) as Array<Record<string, unknown>>;
      row = rows[0] ?? null;
    }
    if (!row) return Response.json({ error: "not found" }, { status: 404 });

    // Parse the transcript JSON so the client gets a BrainEvent[] directly.
    let transcript: unknown[] = [];
    try { transcript = JSON.parse(String(row.transcript ?? "[]")); } catch { /* keep [] */ }
    return Response.json({ run: { ...row, transcript } });
  } catch (e) {
    console.error("[factory-v3 runs] detail failed:", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
