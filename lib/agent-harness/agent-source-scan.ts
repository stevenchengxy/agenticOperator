// Pure source scanner — reverse-engineer the tools a real agent uses by reading its
// .ts source. Standalone (no registry/selection imports) so both the registry and
// the gold standard can use it without an import cycle.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** lib modules that ARE the recruitment tool surface → normalized namespace, so a
 *  real agent's `import { matchResumeDirect } from '@/lib/robohire-client'` and a
 *  generated agent's bound `robohire.matchResume` both reduce to the `robohire`
 *  namespace and compare. */
const TOOL_MODULES: Array<[RegExp, string]> = [
  [/robohire/i, "robohire"],
  [/partner-?pg/i, "partnerpg"],
  [/minio/i, "minio"],
  [/allmeta|ontology/i, "ontology"],
  [/candidate-?lock/i, "candidatelock"],
];

/** Candidate source paths for a real agent (they live in server/inngest/agents). */
function sourceCandidates(inngestId: string, short: string): string[] {
  const dir = join(process.cwd(), "server", "inngest", "agents");
  const kebabShort = short.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  return [
    join(dir, `${inngestId}.ts`),
    join(dir, `${inngestId.replace(/-agent$/, "")}-agent.ts`),
    join(dir, `${kebabShort}-agent.ts`),
    join(dir, `${kebabShort}.ts`),
  ];
}

/** Scan a real agent's source for the tools it uses: named imports from tool-bearing
 *  lib modules + any namespaced tool calls. Returns `<namespace>.<fn>` identifiers.
 *  Graceful when the source can't be resolved (returns []). */
export function extractAgentTools(inngestId: string, short: string): string[] {
  for (const path of sourceCandidates(inngestId, short)) {
    let src: string;
    try { src = readFileSync(path, "utf8"); } catch { continue; }
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    const importRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = importRe.exec(src))) {
      const ns = TOOL_MODULES.find(([re]) => re.test(m![2]))?.[1];
      if (!ns) continue;
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name) found.add(`${ns}.${name}`);
      }
    }
    const nsRe = /\b(robohire|partnerpg|minio|ontology|candidatelock)\.([a-zA-Z][a-zA-Z0-9]*)/gi;
    while ((m = nsRe.exec(src))) found.add(`${m[1].toLowerCase()}.${m[2]}`);
    return [...found].sort();
  }
  return [];
}
