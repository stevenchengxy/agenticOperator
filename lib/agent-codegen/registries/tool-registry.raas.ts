// Phase 1b seed of the AO RAAS tool registry. Each entry is a wrapper
// the LLM is allowed to import + call when filling step bodies.
//
// MAINTENANCE:
//   - Adding a new hand-written `@/lib/*` helper that codegen should be
//     able to call? Add a row here.
//   - Phase 2 lib codegen (research doc §B.6) will auto-append entries
//     for libs it generates — keyed off `generatedByLibVersion`.
//
// This is intentionally hand-curated (not auto-scanned). The LLM is
// strictly bounded to call only what appears here, so curating well is
// the operator's lever for keeping generated agents on-rails.

export type ToolRegistryEntry = {
  /** Lookup key used in AgentSpec.steps[].callsLib. */
  id: string;
  /** Import source path (TS — use @/ alias). */
  importFrom: string;
  /** Named export to import. */
  importName: string;
  /** TS-style signature for the LLM prompt. */
  signature: string;
  /** One-line behavior summary. */
  summary: string;
  /** 'read-only' | 'writes <thing>' | 'external HTTP' — informs error handling guidance. */
  sideEffects: string;
};

export const TOOL_REGISTRY_RAAS: ReadonlyArray<ToolRegistryEntry> = [
  {
    id: 'partner-pg.getRequirement',
    importFrom: '@/lib/partner-pg/requirements',
    importName: 'getRequirementDetail',
    signature: 'getRequirementDetail(id: string): Promise<Requirement>',
    summary: 'Pull one requirement snapshot from partner Postgres (read-only).',
    sideEffects: 'read-only',
  },
  {
    id: 'partner-pg.saveCandidate',
    importFrom: '@/lib/partner-pg/candidates',
    importName: 'saveCandidateToPartnerPg',
    signature: 'saveCandidateToPartnerPg(input: SaveCandidateInput): Promise<Candidate>',
    summary: 'Persist a parsed resume into partner Postgres candidates table.',
    sideEffects: 'writes Candidate row',
  },
  {
    id: 'robohire.parseResume',
    importFrom: '@/lib/robohire-client',
    importName: 'parseResumeDirect',
    signature: 'parseResumeDirect(pdf: Buffer): Promise<ParsedResume>',
    summary: 'Direct-call RoboHire to parse a PDF resume.',
    sideEffects: 'external HTTP; may throw RobohireApiError',
  },
  {
    id: 'robohire.generateJd',
    importFrom: '@/lib/robohire-client',
    importName: 'generateJdDirect',
    signature: 'generateJdDirect(input: JdGenInput): Promise<JdGeneratedPayload>',
    summary: 'Direct-call RoboHire to synthesize a JD from a requirement.',
    sideEffects: 'external HTTP; may throw RobohireApiError',
  },
  {
    id: 'inngest.send',
    importFrom: '@/server/inngest/client',
    importName: 'inngest',
    signature: 'inngest.send({ name: string, data: unknown }): Promise<void>',
    summary: 'Emit a downstream event so the next agent in the workflow picks it up.',
    sideEffects: 'writes EventInstance + fans out to subscribers',
  },
  {
    id: 'logger.event',
    importFrom: '@/server/agent-logger',
    importName: 'createAgentLogger',
    signature: 'logger.event(name: string, data?: Record<string, unknown>): void',
    summary: 'Structured log line via the agent logger (preferred over console.log).',
    sideEffects: 'writes AgentRunLog',
  },
];

export function findTool(id: string): ToolRegistryEntry | undefined {
  return TOOL_REGISTRY_RAAS.find((t) => t.id === id);
}
