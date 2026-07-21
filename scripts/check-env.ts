// Standalone env-check runner.
//
// Invoked by `npm run setup` (scripts/setup.mjs) and by anyone who wants a
// quick "are my env vars OK?" answer without booting the full Next server.
// Loads .env.local first so it works the same way as Next would at runtime.

import { config } from "dotenv";
import path from "node:path";
import { checkEnv, printEnvCheck } from "../server/env-check";

config({ path: path.resolve(process.cwd(), ".env.local") });
config({ path: path.resolve(process.cwd(), ".env") });

const result = checkEnv();
printEnvCheck(result);
process.exit(result.ok ? 0 : 1);
