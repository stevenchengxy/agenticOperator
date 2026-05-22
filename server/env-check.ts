// Boot-time env validation.
//
// Catches the most common partner-deploy mistakes (forgot to copy .env.example,
// pasted placeholders verbatim, etc.) before they manifest as cryptic errors
// deep inside an agent run.
//
// Called by:
//   - scripts/check-env.mjs  (preflight before `npm run setup`)
//   - server/init.ts:bootOnce (first request to /api/inngest)
//
// Philosophy: warn loudly on missing OPTIONAL vars, FAIL HARD on missing
// REQUIRED vars. Required = "without this, the app cannot serve a single
// useful request". Everything else (Inngest, Allmeta, MinIO, RoboHire,
// Postgres) degrades gracefully when missing — its specific code path
// throws on first call instead of crashing boot.

export type EnvCheckResult = {
  ok: boolean;
  required: { name: string; present: boolean; reason: string }[];
  recommended: { name: string; present: boolean; reason: string }[];
};

const REQUIRED = [
  {
    name: "DATABASE_URL",
    reason: "SQLite path for AO's operational state (Prisma).",
  },
] as const;

const RECOMMENDED = [
  {
    name: "INNGEST_BASE_URL",
    reason: "Inngest dev/shared server URL. Without it, event-driven flows are inert.",
  },
  {
    name: "NEXT_PUBLIC_INNGEST_URL",
    reason: "Browser-side Inngest URL (dashboard links). Set equal to INNGEST_BASE_URL.",
  },
  {
    name: "ALLMETA_BASE_URL",
    reason: "Allmeta Studio (Neo4j HTTP layer). Rule-check + entity names degrade without it.",
  },
  {
    name: "AI_API_KEY",
    reason: "LLM gateway key (or OPENAI_API_KEY). Without either, all LLM calls throw.",
    altOf: "OPENAI_API_KEY",
  },
  {
    name: "RAAS_POSTGRES_URL",
    reason: "Partner Postgres dual-write target. Save-candidate / match-result writes fail without it.",
  },
  {
    name: "MINIO_ENDPOINT",
    reason: "Resume binary fetch target. Resume parser stalls without it.",
  },
  {
    name: "ROBOHIRE_API_KEY",
    reason: "RoboHire resume parser. /parse-resume + /match-resume fail without it.",
  },
] as const;

// Placeholder values from .env.example that should never make it to prod.
const PLACEHOLDER_MARKERS = [
  "replace-with",
  "replace_with",
  "<shared-inngest",
  "<this-machine",
  "<minio-host>",
  "<partner-host>",
  "/absolute/path/to/",
  "sk-replace-with",
  "rh_replace_with",
];

function looksPlaceholder(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((m) => v.includes(m.toLowerCase()));
}

export function checkEnv(): EnvCheckResult {
  const required = REQUIRED.map((r) => {
    const raw = process.env[r.name];
    const present = !!raw && !looksPlaceholder(raw);
    return { name: r.name, present, reason: r.reason };
  });

  const recommended = RECOMMENDED.map((r) => {
    const raw = process.env[r.name];
    const altRaw =
      "altOf" in r && r.altOf ? process.env[r.altOf] : undefined;
    const present =
      (!!raw && !looksPlaceholder(raw)) ||
      (!!altRaw && !looksPlaceholder(altRaw));
    const displayName =
      "altOf" in r && r.altOf ? `${r.name} (or ${r.altOf})` : r.name;
    return { name: displayName, present, reason: r.reason };
  });

  const ok = required.every((r) => r.present);
  return { ok, required, recommended };
}

/** Print a colored table to stderr. Returns true if all REQUIRED vars present. */
export function printEnvCheck(result: EnvCheckResult): void {
  const reset = "\x1b[0m";
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";
  const green = "\x1b[32m";
  const dim = "\x1b[2m";

  const tick = `${green}✓${reset}`;
  const cross = `${red}✗${reset}`;
  const warn = `${yellow}!${reset}`;

  console.error(`\n${dim}── env check ──────────────────────────────${reset}`);
  console.error(`${dim}REQUIRED${reset}`);
  for (const r of result.required) {
    const icon = r.present ? tick : cross;
    console.error(`  ${icon} ${r.name}${r.present ? "" : `  ${dim}${r.reason}${reset}`}`);
  }
  console.error(`${dim}RECOMMENDED${reset}`);
  for (const r of result.recommended) {
    const icon = r.present ? tick : warn;
    console.error(`  ${icon} ${r.name}${r.present ? "" : `  ${dim}${r.reason}${reset}`}`);
  }
  if (!result.ok) {
    console.error(`\n${red}✗ Required env vars missing or set to placeholder values.${reset}`);
    console.error(`${dim}  Fix .env.local and re-run. See .env.example for the full template.${reset}\n`);
  } else {
    console.error(`${green}✓ All required env vars present.${reset}\n`);
  }
}

/** Throws on missing REQUIRED vars. Used by server boot. */
export function assertRequiredEnv(): void {
  const result = checkEnv();
  if (!result.ok) {
    const missing = result.required.filter((r) => !r.present).map((r) => r.name);
    throw new Error(
      `Required env vars missing or placeholder-valued: ${missing.join(", ")}. ` +
        `Edit .env.local — see .env.example for the template.`,
    );
  }
}
