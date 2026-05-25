# Codegen Eval Harness

Measures how close the codegen pipeline gets to the 5 hand-written production
agents. Used to decide which tuning levers (from the [end-to-end use case
doc](../../../docs/2026-05-25-codegen-end-to-end-use-cases.md) Part 4) are
actually worth implementing.

## Usage

```bash
# Run all 5 fixtures (≈ 5 × 60-90s = 5-8 minutes of LLM calls)
npm run codegen:eval

# Run one fixture
npm run codegen:eval -- --fixture=create-jd-agent

# Show fixture names
npm run codegen:eval -- --list
```

Requires the same LLM env vars as `/api/codegen/generate`:
`AI_BASE_URL + AI_API_KEY` (gateway mode) OR `OPENAI_API_KEY` (direct).
Optional `AI_CODEGEN_MODEL` to swap models.

## What it does

For each fixture:

1. Loads the fixture (form fields + business description prose)
2. Calls `runPipeline()` — same path the UI uses
3. Reads the production file (`server/inngest/agents/<slug>.ts`)
4. Calls `scoreCandidate(production, generated)` from [score.ts](score.ts)
5. Prints a per-dimension breakdown + missing/extra imports + steps

## Score dimensions

| Dimension | Weight | Measures |
|---|---|---|
| imports | 0.20 | `prod-imports ∩ gen-imports` / `prod-imports` |
| steps | 0.20 | `prod-step-ids ∩ gen-step-ids` / `prod-step-ids` (template suffixes stripped) |
| tools | 0.25 | `prod-used-imports ∩ gen-used-imports` / `prod-used-imports` |
| patterns | 0.25 | weighted mean of NonRetriableError + try/catch + logger.* presence ratios |
| loc | 0.10 | 1.0 if generated LOC ≤ 1.5× prod; linear drop to 0 at 4× |

Composite = sum of (dimension × weight). Range 0..1.

Weights are heuristic — change [DEFAULT_WEIGHTS](score.ts) to re-rank.

## What it doesn't measure (yet)

- Runtime correctness — generated agent's actual behavior on real events
- Type compatibility beyond what the in-process compiler already enforces
- Diff readability or maintainability

These need a real eval-UI (Bundle E) + event replay sandbox. Out of scope for the MVP harness.

## When to run

- Before tuning prompts / few-shot / templates — establish baseline
- After tuning — verify the score moved the right direction
- Before claiming a tuning lever in [the use case doc Part 4](../../../docs/2026-05-25-codegen-end-to-end-use-cases.md) is "done"

## Where to add new fixtures

Append entries to [fixtures.ts](fixtures.ts). Each new fixture is one round of
`prod → form + business-description → pipeline → score` measurement.
