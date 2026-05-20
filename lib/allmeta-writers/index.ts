// Allmeta ontology writers — dual-write companion to partner-pg.
//
// Per 2026-05-20 architecture: after AO writes business entity to partner
// Postgres (via lib/partner-pg/*), we ALSO write the same entity (canonical
// shape) to Neo4j via allmeta ontology API. This keeps the ontology graph
// in sync with the operational DB.
//
// Soft-fail semantics: all writers catch AllmetaApiError + generic Error
// and return `{ ok: false, error }` instead of throwing. Agents log the
// failure but continue — Postgres is the source of truth for now.
//
// Canonical field names: neo4j_data/objects_v0_1_015.json. Only fields
// listed in that schema are sent; extra fields are filtered out.

export { writeJobPostingInstance } from './job-posting';
export { writeJobRequisitionInstance } from './job-requisition';
export { writeCandidateInstance } from './candidate';
export { writeResumeInstance } from './resume';
export { writeApplicationInstance } from './application';
export { writeCandidateMatchResultInstance } from './candidate-match-result';
