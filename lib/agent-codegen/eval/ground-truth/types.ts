// GroundTruth — declarative description of the expected step sequence,
// emits, and conventions for a generated agent.
//
// The behavioral analyzer parses the generated TS source, extracts what it
// can determine statically (step.run order, tools each step calls, emits
// at the end), and compares the extracted shape to this record.
//
// Records are hand-curated per agent. They're the "test contract" the
// codegen output is expected to satisfy. When the production agent changes
// shape, the corresponding ground-truth record needs an update too.

export type ExpectedStep = {
  /** step.run('id', ...) — template-literal suffixes are stripped before compare. */
  id: string;
  /** Which tool the step is expected to call. Use registry id (e.g. 'partner-pg.getRequirement'). */
  tool?: string;
  /** True iff this step is allowed to be missing from generated (operator-deferred). */
  optional?: boolean;
};

export type ExpectedEmit = {
  /** Event name — must appear in inngest.send({ name }) or step.sendEvent. */
  name: string;
  /** When generated code is expected to choose between alternatives — */
  alternativeOf?: string;
};

export type GroundTruth = {
  /** Matches EvalFixture.name. */
  fixtureName: string;
  /** Production reference file. */
  productionPath: string;
  /** Step sequence the generated agent should produce, in order. */
  expectedSteps: ExpectedStep[];
  /** Events the generated agent should emit at some point. */
  expectedEmits: ExpectedEmit[];
  /** Convention assertions in addition to the structural overlap. */
  conventions: {
    /** Must include `throw new NonRetriableError(...)` somewhere. */
    nonRetriableUsed: boolean;
    /** Must include at least one try/catch block. */
    tryCatchUsed: boolean;
    /** Min number of logger.* calls expected (low bar; mostly catches "no observability"). */
    minLoggerCalls: number;
  };
  /** One-line summary of what 'replacing this agent with the generated code' would require. */
  replacementVerdict: string;
};
