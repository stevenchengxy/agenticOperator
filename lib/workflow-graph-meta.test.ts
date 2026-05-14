import { describe, it, expect } from 'vitest';
import { NODES, EDGES, nodeById, GRAPH_VIEWBOX, GRAPH_WIDTH, GRAPH_HEIGHT } from './workflow-graph-meta';

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
    expect(NODES).toHaveLength(23);
  });

  it('has 28 edges matching real AGENT_MAP event flow', () => {
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
    const expectedHitl = ['JDReviewer', 'ManualPublish', 'ResumeFixer', 'ManualEntry', 'MatchReviewer', 'PackageFiller', 'PackageReviewer'];
    for (const title of hitlNodeTitles) {
      expect(expectedHitl, `unexpected HITL node: ${title}`).toContain(title);
    }
  });

  it('matcher node fans out to 3 edges (need_interview, no_interview, failed)', () => {
    const fromMatcher = EDGES.filter(e => e.from === 'matcher');
    expect(fromMatcher).toHaveLength(3);
    const events = fromMatcher.map(e => e.eventName);
    expect(events).toContain('MATCH_PASSED_NEED_INTERVIEW');
    expect(events).toContain('MATCH_PASSED_NO_INTERVIEW');
    expect(events).toContain('MATCH_FAILED');
  });
});
