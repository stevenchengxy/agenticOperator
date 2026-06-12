// Ontology version registry for the Agent Execution API.
//
// The partner requires version pinning: an execution must declare which rule
// snapshot it runs against, and an unknown version must HARD-FAIL (never silent
// fallback). AO's live engine reads LATEST from Neo4j, so this registry layers
// version awareness ON TOP without touching the engine:
//   - validates the requested version against the known on-disk snapshots
//     (neo4j_data/招聘- v1/rules_v0_1_*.json) — unknown → ONTOLOGY_VERSION_UNAVAILABLE
//   - exposes ruleCount + per-rule text fingerprints (sha256 of standardizedLogicRule)
//     so the partner can verify "which version of the rule the agent saw"
//
// MVP boundary (guide §10-⑥): the decision itself executes against LIVE Neo4j.
// When the requested version == the live published version, results are faithful;
// otherwise meta.ontologyLoaded.liveConsistency surfaces the divergence. True
// per-version execution pinning is a follow-up that needs the version-registration
// flow agreed with the partner — it does NOT belong in the production engine.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const SNAPSHOT_DIR = join(process.cwd(), 'neo4j_data', '招聘- v1');

interface SnapshotRule {
  id: string;
  standardizedLogicRule?: string;
  [k: string]: unknown;
}

export interface LoadedVersion {
  version: string; // e.g. "rules_v0_1_002"
  metadataVersion: string; // e.g. "0.2"
  ruleCount: number;
  /** ruleId → standardizedLogicRule (for fingerprinting). */
  rulesById: Map<string, SnapshotRule>;
}

const cache = new Map<string, LoadedVersion | null>();

function snapshotFile(version: string): string {
  return join(SNAPSHOT_DIR, `${version}.json`);
}

/** The set of pinnable versions (derived from on-disk snapshots). */
export function listVersions(): string[] {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  return readdirSync(SNAPSHOT_DIR)
    .filter((f) => /^rules_v\d+_\d+_\d+\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

/** Load a pinned version's rules, or null if the version is unknown/unreadable. */
export function loadVersion(version: string): LoadedVersion | null {
  if (cache.has(version)) return cache.get(version) ?? null;
  const file = snapshotFile(version);
  if (!/^rules_v\d+_\d+_\d+$/.test(version) || !existsSync(file)) {
    cache.set(version, null);
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      metadata?: { version?: string };
      rules?: SnapshotRule[];
    };
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    const rulesById = new Map<string, SnapshotRule>();
    for (const r of rules) if (typeof r.id === 'string') rulesById.set(r.id, r);
    const loaded: LoadedVersion = {
      version,
      metadataVersion: parsed.metadata?.version ?? 'unknown',
      ruleCount: rules.length,
      rulesById,
    };
    cache.set(version, loaded);
    return loaded;
  } catch {
    cache.set(version, null);
    return null;
  }
}

/** sha256 of the rule's standardizedLogicRule full text in the given version. */
export function ruleTextSha256(version: string, ruleId: string): string | null {
  const v = loadVersion(version);
  const text = v?.rulesById.get(ruleId)?.standardizedLogicRule;
  if (typeof text !== 'string') return null;
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Normalize partner domain aliases to AO's recruitment ontology id. */
export function normalizeDomain(domain: string): string {
  const d = (domain ?? '').trim();
  if (d === 'RAAS-v1' || d === 'raas' || d === '' || d === '招聘-v1') return '招聘-v1';
  return d;
}
