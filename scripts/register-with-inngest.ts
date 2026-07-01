// Register the AO /api/inngest endpoint with the shared Inngest dev server
// so RAAS-emitted events flow back into THIS AO instance.
//
// Usage:
//   npx tsx scripts/register-with-inngest.ts
//   # or:
//   npm run register
//
// What it does:
//   PUT http://172.16.1.83:3002/api/inngest
//
// Reads INNGEST_BASE_URL + AO_LAN_IP + AO_PORT from .env.local.
// Re-run any time after the AO dev server restarts (registration is in-memory).

// dotenv only auto-loads .env, not .env.local. Load explicitly.
import { config } from "dotenv";
import path from "node:path";
import {
  RAAS_V1_APP_ID,
  RAAS_V1_EXPECTED_FUNCTION_COUNT,
} from "../lib/raas-v1-inngest";
config({ path: path.resolve(process.cwd(), ".env.local") });
config({ path: path.resolve(process.cwd(), ".env") });

async function main(): Promise<void> {
  const base =
    process.env.INNGEST_BASE_URL ??
    process.env.INNGEST_DEV ??
    "http://localhost:8288";
  const lanIp = process.env.AO_LAN_IP ?? "127.0.0.1";
  const port = process.env.AO_PORT ?? "3002";
  const callback = `http://${lanIp}:${port}/api/inngest`;

  console.log(`Registering RAAS-v1 main app with Inngest:`);
  console.log(`  Inngest server: ${base}`);
  console.log(`  AO callback:    ${callback}`);
  console.log(`  App ID:         ${RAAS_V1_APP_ID}`);
  console.log(`  Expected funcs: ${RAAS_V1_EXPECTED_FUNCTION_COUNT}`);
  console.log("");

  // First sanity-check that the callback is reachable from THIS host.
  // (If localhost can't hit it, neither can 10.100.0.70.)
  try {
    const ping = await fetch(`http://localhost:${port}/api/inngest`, {
      method: "PUT",
    });
    if (!ping.ok) {
      console.warn(`⚠ Local PUT /api/inngest returned ${ping.status}; AO may not be running yet`);
    } else {
      console.log("✓ AO /api/inngest reachable from localhost");
    }
  } catch (e) {
    console.error(`✗ AO is not running on port ${port}: ${(e as Error).message}`);
    process.exit(1);
  }

  // Then self-sync the exact callback URL that the shared Inngest server should
  // store. The SDK endpoint owns the app id + manifest, so PUT is enough.
  try {
    const res = await fetch(callback, { method: "PUT" });
    const text = await res.text();
    if (!res.ok) {
      console.error(`✗ Register failed (${res.status}): ${text}`);
      process.exit(1);
    }
    console.log(`✓ SDK endpoint accepted registration PUT`);
    const count = await probeFunctionCount(base, RAAS_V1_APP_ID);
    if (count == null) {
      console.warn(`⚠ Could not verify function count from ${base}/v0/gql`);
    } else if (count !== RAAS_V1_EXPECTED_FUNCTION_COUNT) {
      console.error(
        `✗ ${RAAS_V1_APP_ID} registered ${count} functions, expected ${RAAS_V1_EXPECTED_FUNCTION_COUNT}. ` +
          `Check STUB_AGENTS and make sure you registered /api/inngest, not a domain endpoint.`,
      );
      process.exit(1);
    } else {
      console.log(`✓ Verified ${count}/${RAAS_V1_EXPECTED_FUNCTION_COUNT} RAAS-v1 functions registered`);
    }
    console.log("");
    console.log(`Next: send a RESUME_DOWNLOADED event from RAAS or trigger locally:`);
    console.log(`  curl -X POST http://localhost:${port}/api/test/trigger-resume-uploaded`);
  } catch (e) {
    console.error(`✗ Couldn't PUT ${callback}: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();

async function probeFunctionCount(base: string, appId: string): Promise<number | null> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ apps { name functionCount } }" }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { apps?: Array<{ name: string; functionCount: number }> };
    };
    const app = body.data?.apps?.find((a) => a.name === appId);
    return typeof app?.functionCount === "number" ? app.functionCount : null;
  } catch {
    return null;
  }
}
