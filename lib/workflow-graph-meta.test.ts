import { describe, it, expect } from 'vitest';
import { NODES, EDGES, nodeById, GRAPH_VIEWBOX } from './workflow-graph-meta';

describe('workflow-graph-meta', () => {
  it('viewBox matches the historical 1620x560 used by /workflow', () => {
    expect(GRAPH_VIEWBOX).toBe('0 0 1620 560');
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
      expect(n.x).toBeLessThanOrEqual(1620);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(560);
    }
  });

  it('nodeById returns the node or undefined', () => {
    expect(nodeById('jd')?.title).toBeDefined();
    expect(nodeById('does-not-exist')).toBeUndefined();
  });

  it('parse node carries an explicit agentName to handle title/agent-short divergence', () => {
    const parse = nodeById('parse');
    expect(parse).toBeDefined();
    expect(parse?.agentName).toBe('ResumeParser');
  });
});
