// Neo4j → partner-Postgres read fallback (2026-05-26).
//
// AO dual-writes every entity to Neo4j (Allmeta ontology) AND partner Postgres
// (RAAS legacy DB). Reads go to Neo4j first; on a MISS (null / []), we fall back
// to Postgres so a Neo4j write lag/failure doesn't starve the agents.
//
// CORRECTNESS NOTE — why only Job_Requisition is registered:
//   The ontology field names and partner-pg column names DIVERGE for several
//   entities (see docs/ao-allmeta-field-alignment-table.md — ~21 naming
//   mismatches: experience_years↔work_years, skills_extracted↔skill_tags,
//   job_position_id↔job_requisition_id, …). A fallback that returns wrongly-named
//   fields would silently feed the LLM rule evaluator bad data. So we ONLY
//   register entities whose pg row is field-compatible with the ontology node
//   for the fields agents read, AND that have a single-PK pg reader matching the
//   `getInstance(label, value)` signature.
//
//   - Job_Requisition ✅ — pg `job_requisition` core fields are 1:1 with the
//     ontology node (job_requisition_id / job_responsibility / job_requirement /
//     must_have_skills / work_years / degree_requirement / …), and
//     getRequirementDetail(jrid) is a clean single-key reader.
//   - Resume / Candidate / Application / Candidate_Match_Result ❌ NOT YET —
//     they need composite-key readers (e.g. getParsedResume(candidate_id,
//     resume_id)) and/or verified pg→ontology field mappers. Adding each is a
//     deliberate, mapping-verified step — register here once that's done.

import { isPartnerPgConfigured } from '@/lib/partner-pg/client';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';

/** A single-PK pg resolver: given an instance PK value, return a row shaped like
 *  the ontology node (field-name compatible), or null when pg has no row. */
type InstanceFallback = (value: string) => Promise<Record<string, unknown> | null>;

const INSTANCE_FALLBACKS: Record<string, InstanceFallback> = {
  Job_Requisition: async (value) => {
    const d = await getRequirementDetail(value);
    return d ? (d as unknown as Record<string, unknown>) : null;
  },
};

/** Whether a Neo4j-miss fallback exists for this ontology label. */
export function hasInstanceFallback(label: string): boolean {
  return Object.prototype.hasOwnProperty.call(INSTANCE_FALLBACKS, label);
}

/**
 * Resolve a single instance from partner-pg when Neo4j missed.
 * Returns null when: pg not configured, label has no registered fallback, or
 * pg has no matching row. Never throws — fallback failures degrade to the miss.
 */
export async function getInstanceFallback(
  label: string,
  value: string,
): Promise<Record<string, unknown> | null> {
  const resolver = INSTANCE_FALLBACKS[label];
  if (!resolver) return null;
  if (!isPartnerPgConfigured()) return null;
  try {
    return await resolver(value);
  } catch {
    return null;
  }
}
