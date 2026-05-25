// Type-only module after the 2026-05-25 cleanup: all "open in Neo4j
// Browser" jumps were removed from the UI (user request — no direct
// graph engine entry). The NodeKind enum stays because GraphView and
// CaseDrawer use it as a slot/highlight identifier; the URL builder
// and cypher generator are gone.
export type NodeKind = 'candidate' | 'resume' | 'jd' | 'application' | 'blacklist' | 'employment' | 'subgraph';
