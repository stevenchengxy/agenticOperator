import { describe, expect, it } from 'vitest';
import { buildNeo4jBrowserUrl } from './neo4j-jump';

describe('buildNeo4jBrowserUrl', () => {
  const BASE = 'http://10.100.0.70:7474/browser/';

  it('returns null when base is undefined', () => {
    expect(buildNeo4jBrowserUrl(undefined, 'candidate', 'C-1')).toBeNull();
  });
  it('returns null when base is empty string', () => {
    expect(buildNeo4jBrowserUrl('', 'candidate', 'C-1')).toBeNull();
  });
  it('candidate cypher with URL-encoded query', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'candidate', 'C-S02-100024');
    expect(url).toBe(
      `${BASE}?cmd=edit&arg=${encodeURIComponent("MATCH (c:Candidate {candidate_id: 'C-S02-100024'}) RETURN c")}`,
    );
  });
  it('resume cypher', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'resume', 'R-1');
    expect(url).toContain(encodeURIComponent("MATCH (r:Resume {resume_id: 'R-1'}) RETURN r"));
  });
  it('jd cypher uses Job_Requisition label', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'jd', 'JR-1');
    expect(url).toContain(encodeURIComponent("MATCH (j:Job_Requisition {job_requisition_id: 'JR-1'}) RETURN j"));
  });
  it('subgraph cypher around a candidate', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'subgraph', 'C-1');
    expect(url).toContain(encodeURIComponent("MATCH (c:Candidate {candidate_id: 'C-1'})-[r*1..2]-(n) RETURN c, r, n LIMIT 50"));
  });
  it('handles base without trailing slash', () => {
    const url = buildNeo4jBrowserUrl('http://x/browser', 'candidate', 'C-1');
    expect(url).toMatch(/^http:\/\/x\/browser\?cmd=edit&arg=/);
  });
  it('escapes single quotes in id', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'candidate', "C-1'; DROP DATABASE //");
    // encodeURIComponent leaves "'" as-is, but encodes "\" → %5C. So an escaped
    // \' in the cypher renders as %5C' in the URL.
    expect(url).toContain("%5C'");
    // Exactly 3 raw quotes: 2 wrapping the cypher string + 1 from the embedded
    // escaped quote (which prints as \' = %5C').
    const m = (url ?? '').match(/'/g) ?? [];
    expect(m.length).toBe(3);
  });
});
