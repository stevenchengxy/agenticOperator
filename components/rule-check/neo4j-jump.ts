export type NodeKind = 'candidate' | 'resume' | 'jd' | 'application' | 'blacklist' | 'employment' | 'subgraph';

function escapeCypherString(s: string): string {
  // Escape single quotes by backslash and strip control chars (defense-in-depth
  // since IDs come from neo4j/the fixture loader, not external input).
  return s.replace(/'/g, "\\'").replace(/[\x00-\x1f]/g, '');
}

function cypherForNode(kind: NodeKind, id: string): string {
  const e = escapeCypherString(id);
  switch (kind) {
    case 'candidate':
      return `MATCH (c:Candidate {candidate_id: '${e}'}) RETURN c`;
    case 'resume':
      return `MATCH (r:Resume {resume_id: '${e}'}) RETURN r`;
    case 'jd':
      return `MATCH (j:Job_Requisition {job_requisition_id: '${e}'}) RETURN j`;
    case 'application':
      return `MATCH (a:Application {application_id: '${e}'}) RETURN a`;
    case 'blacklist':
      return `MATCH (b:Blacklist {blacklist_id: '${e}'}) RETURN b`;
    case 'employment':
      return `MATCH (e:Employment {employment_id: '${e}'}) RETURN e`;
    case 'subgraph':
      return `MATCH (c:Candidate {candidate_id: '${e}'})-[r*1..2]-(n) RETURN c, r, n LIMIT 50`;
  }
}

export function buildNeo4jBrowserUrl(
  base: string | undefined,
  kind: NodeKind,
  id: string,
): string | null {
  if (!base) return null;
  const cypher = cypherForNode(kind, id);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}cmd=edit&arg=${encodeURIComponent(cypher)}`;
}
