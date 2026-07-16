import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type HealthCheck = "live" | "ready";

function response(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Container/orchestrator probe.
 *
 * `?check=live` only proves that the Next.js process can answer HTTP.
 * `?check=ready` (the default) also proves the durable Postgres store is
 * queryable. Inngest is deliberately excluded to avoid a startup dependency
 * cycle; deep dependency health remains available through /api/system/config.
 */
export async function GET(request: Request): Promise<Response> {
  const requested = new URL(request.url).searchParams.get("check");
  const check: HealthCheck = requested === "live" ? "live" : "ready";
  const base = {
    service: "agentic-operator",
    check,
    timestamp: new Date().toISOString(),
  };

  if (check === "live") {
    return response({ ...base, status: "ok" });
  }

  const startedAt = Date.now();
  let postgresReady = false;
  let ruleAuditSchemaReady = false;
  try {
    // Attach the rejection handler immediately. Besides ordinary Prisma
    // promises this also handles thenables/mocks without allowing a rejected
    // probe to escape as an unhandled rejection.
    // Static probe, so the unsafe variant carries no injection risk. Using a
    // normal function call also behaves consistently across Prisma adapters.
    const rows = await Promise.resolve(prisma.$queryRawUnsafe(`
      SELECT
        to_regclass('public."RuleCheckAudit"')::text AS "RuleCheckAudit",
        to_regclass('public."RuleCheckFlag"')::text AS "RuleCheckFlag",
        to_regclass('public."OntologyRuleCheck"')::text AS "OntologyRuleCheck",
        to_regclass('public."OntologyRuleCheckEval"')::text AS "OntologyRuleCheckEval"
    `));
    if (Array.isArray(rows) && rows.length > 0) {
      postgresReady = true;
      const schema = rows[0] as Record<string, unknown>;
      ruleAuditSchemaReady = [
        "RuleCheckAudit",
        "RuleCheckFlag",
        "OntologyRuleCheck",
        "OntologyRuleCheckEval",
      ].every((table) => typeof schema[table] === "string" && schema[table] !== "");
    }
  } catch {
    // Synchronous adapter/configuration failures take the same redacted path.
    postgresReady = false;
  }

  if (!postgresReady || !ruleAuditSchemaReady) {
    return response(
      {
        ...base,
        status: "unavailable",
        dependencies: {
          postgres: postgresReady ? "ok" : "unavailable",
          ruleAuditSchema: ruleAuditSchemaReady ? "ok" : "unavailable",
        },
        latencyMs: Date.now() - startedAt,
      },
      503,
    );
  }

  return response({
    ...base,
    status: "ok",
    dependencies: { postgres: "ok", ruleAuditSchema: "ok" },
    latencyMs: Date.now() - startedAt,
  });
}
