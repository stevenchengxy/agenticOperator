import { describe, it, expect } from 'vitest';
import { NODES, EDGES, nodeById, GRAPH_VIEWBOX, GRAPH_WIDTH, GRAPH_HEIGHT, CANONICAL_WORKFLOW } from './workflow-graph-meta';

describe('workflow-graph-meta', () => {
  it('viewBox is 1920x720 (expanded real-agent layout)', () => {
    expect(GRAPH_VIEWBOX).toBe('0 0 1920 720');
    expect(GRAPH_WIDTH).toBe(1920);
    expect(GRAPH_HEIGHT).toBe(720);
  });

  it('all edge endpoints resolve to a real node', () => {
    const ids = new Set(NODES.map(n => n.id));
    for (const e of EDGES) {
      expect(ids.has(e.from), `edge ${e.from}->${e.to}: from missing`).toBe(true);
      expect(ids.has(e.to),   `edge ${e.from}->${e.to}: to missing`).toBe(true);
    }
  });

  it('every node has unique id, in-bounds x/y', () => {
    const seen = new Set<string>();
    for (const n of NODES) {
      expect(seen.has(n.id), `duplicate id ${n.id}`).toBe(false);
      seen.add(n.id);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(GRAPH_WIDTH);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(GRAPH_HEIGHT);
    }
  });

  it('nodeById returns the node or undefined', () => {
    expect(nodeById('jdGenerator')?.title).toBeDefined();
    expect(nodeById('does-not-exist')).toBeUndefined();
  });

  it('has 23 nodes (22 real agents + 1 trigger)', () => {
    // 22 from canonical JSON + 1 synthetic trig = 23.
    // reClarifier (3-2) added per canonical JSON; MatchReviewer removed (not in spec).
    expect(NODES).toHaveLength(23);
  });

  it('has 28 edges derived from canonical JSON event flow', () => {
    // Auto-built from triggered_event → trigger mappings in workflow-canonical.json.
    // MATCH_FAILED is terminal in the canonical spec (no downstream consumer), so
    // matcher fans to 2 edges instead of the previous 3 (which included MatchReviewer).
    expect(EDGES).toHaveLength(28);
  });

  it('every non-dashed edge has an eventName populated', () => {
    const solidEdges = EDGES.filter(e => !e.dashed);
    for (const e of solidEdges) {
      expect(
        e.eventName && e.eventName.length > 0,
        `solid edge ${e.from}->${e.to} missing eventName`
      ).toBe(true);
    }
  });

  it('every dashed edge also has an eventName (exception paths are named too)', () => {
    const dashedEdges = EDGES.filter(e => e.dashed);
    for (const e of dashedEdges) {
      expect(
        e.eventName && e.eventName.length > 0,
        `dashed edge ${e.from}->${e.to} missing eventName`
      ).toBe(true);
    }
  });

  it('resumeParser node exists with correct title (title IS canonical agent name)', () => {
    const parse = nodeById('resumeParser');
    expect(parse).toBeDefined();
    expect(parse?.title).toBe('ResumeParser');
    // agentName override not needed when title matches canonical short exactly
    expect(parse?.agentName).toBeUndefined();
  });

  it('all HITL-kind nodes belong to known HITL agents', () => {
    const hitlNodeTitles = NODES.filter(n => n.kind === 'hitl').map(n => n.title);
    // Updated per canonical JSON:
    // - ReClarifier (3-2) added: HITL, CLARIFICATION_INCOMPLETE → CLARIFICATION_RETRY
    // - ResumeCollector (8) is HITL: canonical actor=['Human'] (recruiter downloads manually)
    // - AIInterviewer (11-2) is HITL: canonical actor=['Human'] (candidate self-serve)
    // - MatchReviewer removed: not in canonical workflow spec; MATCH_FAILED is terminal
    const expectedHitl = [
      'JDReviewer', 'ResumeCollector', 'ReClarifier',
      'ManualPublish', 'ResumeFixer', 'AIInterviewer',
      'ManualEntry', 'PackageFiller', 'PackageReviewer',
    ];
    for (const title of hitlNodeTitles) {
      expect(expectedHitl, `unexpected HITL node: ${title}`).toContain(title);
    }
  });

  it('matcher node fans out to 2 edges (MATCH_FAILED is terminal in canonical spec)', () => {
    // MATCH_FAILED has no consumer in the canonical workflow JSON.
    // MatchReviewer was removed as it does not appear in the authoritative spec.
    const fromMatcher = EDGES.filter(e => e.from === 'matcher');
    expect(fromMatcher).toHaveLength(2);
    const events = fromMatcher.map(e => e.eventName);
    expect(events).toContain('MATCH_PASSED_NEED_INTERVIEW');
    expect(events).toContain('MATCH_PASSED_NO_INTERVIEW');
    // MATCH_FAILED is terminal — no edge for it in the graph
    expect(events).not.toContain('MATCH_FAILED');
  });

  it('reClarifier node exists (3-2 per canonical JSON)', () => {
    const node = nodeById('reClarifier');
    expect(node).toBeDefined();
    expect(node?.wsId).toBe('3-2');
    expect(node?.kind).toBe('hitl');
    expect(node?.deployment).toBe('conceptual');
    // Edge: clarifier → reClarifier (CLARIFICATION_INCOMPLETE)
    const edge = EDGES.find(e => e.from === 'clarifier' && e.to === 'reClarifier');
    expect(edge).toBeDefined();
    expect(edge?.eventName).toBe('CLARIFICATION_INCOMPLETE');
  });

  it('canonical JSON is loaded with all 22 workflow nodes', () => {
    expect(CANONICAL_WORKFLOW).toHaveLength(22);
    // Every NODE_LAYOUT wsId (except trig) should resolve in CANONICAL_WORKFLOW
    const canonicalIds = new Set(CANONICAL_WORKFLOW.map(n => n.id));
    const nonTrigNodes = NODES.filter(n => n.wsId !== 'trig');
    for (const n of nonTrigNodes) {
      expect(canonicalIds.has(n.wsId), `wsId ${n.wsId} (${n.id}) not in canonical JSON`).toBe(true);
    }
  });

  it('deployed nodes are exactly the 3 RPA-owned wsIds', () => {
    const deployed = NODES.filter(n => n.deployment === 'deployed');
    expect(deployed).toHaveLength(3);
    const wsIds = deployed.map(n => n.wsId).sort();
    expect(wsIds).toEqual(['10', '4', '9-1']);
  });
});
