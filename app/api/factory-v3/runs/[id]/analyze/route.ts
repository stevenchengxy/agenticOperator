import { requireFactoryAuth } from "@/lib/factory-auth";
import { readBrainRun } from "@/lib/agent-factory-v3/brain/run-registry";
import { analyzeRun } from "@/lib/agent-factory-v3/run-analyzer";

export const dynamic = "force-dynamic";

/**
 * POST /api/factory-v3/runs/[id]/analyze — #6 AI run review. Loads the run's saved transcript and
 * has an LLM score it (0–100) + surface problems / suggestions, so the user can see, per run, what
 * went well and what to fix. Degrades to a digest-only result when no LLM gateway is configured.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireFactoryAuth(req, { allowQueryToken: true });
  if (denied) return denied;

  const { id } = await ctx.params;
  try {
    const run = await readBrainRun(id);
    if (!run) return Response.json({ error: "not found" }, { status: 404 });
    const review = await analyzeRun(run.transcript, run.domain);
    return Response.json({ review });
  } catch (e) {
    console.error("[factory-v3 runs] analyze failed:", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
