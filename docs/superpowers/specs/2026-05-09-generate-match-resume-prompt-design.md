---
title: generateMatchResumeRuleCheckPrompt — design
date: 2026-05-09
branch: create-action-prompt (from steven)
status: approved
---

# generateMatchResumeRuleCheckPrompt — design

## Goal

Add a TypeScript library function that, given `(client_name, department, job_description, resume)`, returns a fully-substituted, LLM-ready prompt string for the `matchResume` action. The function fetches rules from the ontology service, filters them by client/department/executor, formats the survivors as Markdown blocks per `docs/action_object_prompt/rule_structure.md`, and substitutes the result into `docs/action_object_prompt/action_object_prompt_template.md`.

The function is callable from any server-side code in this project (Inngest functions, Route Handlers, scripts).

## Non-goals

- Invoking the LLM (caller's responsibility).
- Persisting the prompt anywhere.
- Wiring this into existing Inngest workflows.
- Environment-based URL config, retries, or timeouts. The URL is hardcoded exactly as the requirement states; tuning can come later.

## File layout

```
lib/prompts/
├── match-resume.ts                 # public function + helpers + types
├── match-resume.test.ts            # vitest unit tests
└── __fixtures__/
    └── match-resume-rules.json     # test fixture (copy of docs sample)
```

`lib/` is the existing home for non-UI shared utilities (`lib/i18n.tsx`, `lib/events-catalog.ts`). The function is server-side because it does Node `fs.readFile` for the templates and a `fetch` to `localhost:3500`; nothing in the implementation is browser-incompatible, but the natural callers are server-side.

## Public API

```ts
export async function generateMatchResumeRuleCheckPrompt(
  client_name: string,
  department: string,
  job_description: string | Record<string, unknown>,
  resume: string | Record<string, unknown>,
): Promise<string>;
```

Positional arguments, matching the requirement verbatim. Returns the fully substituted prompt as a string.

## Internal pipeline

```
fetchRules()
   ↓ MatchResumeRulesResponse
filterRules(steps, client_name, department)
   ↓ Step[]   (steps with 0 surviving rules dropped entirely)
formatRulesByStep(steps)
   ↓ string   (Markdown per rule_structure.md §二)
loadTemplate()
   ↓ string
substituteTemplate(template, { JD, RESUME, RULES_BY_STEP, CURRENT_DATE })
   ↓ string   (final prompt — return value)
```

Each helper is exported for unit testing. `fetchRules` and `loadTemplate` are the only side-effecting helpers; the others are pure.

## Types

```ts
type MatchResumeRule = {
  id: string;
  businessLogicRuleName: string;
  submissionCriteria: string;
  standardizedLogicRule: string;
  executor: string;            // "Agent" | "Human"
  applicableClient: string;    // "通用" | "<client name>"
  applicableDepartment: string; // "N/A" | "通用" | "<dept name>"
  // ...other fields ignored
};

type MatchResumeStep = {
  id: string;
  name: string;
  displayName?: string;
  order: string;       // numeric string in the source JSON ("1", "2", …)
  description: string;
  condition: string;
  rules: MatchResumeRule[];
};

type MatchResumeRulesResponse = {
  action_steps: MatchResumeStep[];
  // other fields from the action object are ignored
};
```

## Filter predicate

A rule is **kept** iff `executor === "Agent"` **and** any of:

1. `applicableClient === "通用"`, OR
2. `applicableClient === client_name` AND `applicableDepartment ∈ {"N/A", "通用"}`, OR
3. `applicableClient === client_name` AND `applicableDepartment === department`.

`通用` at the department level is treated as equivalent to `N/A` (i.e. "applies to all departments at this client") — confirmed during brainstorming. The `executor=Agent` filter is applied because the prompt template explicitly says it operates on Agent-class rules only; injecting Human-class rules would mislead the LLM.

After filtering, any step whose `rules` array is empty is dropped from the output entirely (per `rule_structure.md` §二 关键规则 #4).

## Markdown formatting

Strictly follows `rule_structure.md` §二:

- Steps sorted by `Number(step.order)` ascending.
- Within a step, rules sorted by `rule.id` ascending (string compare with natural-numeric ordering on the trailing number — see Open questions). For now use plain string sort, which gives correct order for the current `<group>-<num>` IDs as long as numbers don't cross magnitudes within a step. If they do, switch to a natural sort.
- Per-step header:
  ```
  ### Step <order>: <name>
  - step_id: <id>
  - enter_condition: <condition>
  - description: <description>
  ```
- Per-rule block (one blank line between rules):
  ```
  #### Rule <rule_id>: <businessLogicRuleName>
  - submissionCriteria: <submissionCriteria>
  - logic: <standardizedLogicRule>
  ```
- Newlines and quotes inside `submissionCriteria` / `standardizedLogicRule` preserved verbatim — no truncation, no rewrite.
- `businessBackgroundReason` excluded (rule_structure.md says optional, default off).
- One blank line between consecutive step blocks.

## Template substitution

Four placeholders, simple `string.replaceAll`:

| Placeholder | Source |
|---|---|
| `{{JOB_DESCRIPTION}}` | `typeof job_description === "string" ? job_description : JSON.stringify(job_description, null, 2)` |
| `{{RESUME}}` | same coercion as above |
| `{{RULES_BY_STEP}}` | output of `formatRulesByStep` |
| `{{CURRENT_DATE}}` | `new Date().toISOString().slice(0, 10)` (UTC date, `YYYY-MM-DD`) |

Both occurrences of `{{CURRENT_DATE}}` in the template (the input section and the example JSON in the output spec) are replaced — `replaceAll` handles both naturally.

## Constants

```ts
const ONTOLOGY_RULES_URL =
  "http://localhost:3500/api/v1/ontology/actions/matchResume/rules";

const TEMPLATE_PATH = "docs/action_object_prompt/action_object_prompt_template.md";
```

`TEMPLATE_PATH` is resolved relative to `process.cwd()` (project root). Both can move to environment variables in a follow-up; for now they match the requirement literally.

## Error handling

| Condition | Behavior |
|---|---|
| `fetch` rejects (network) or returns non-2xx | `throw new Error` with the URL, status code, and a snippet of the response body |
| Response body is not JSON or missing `action_steps` array | `throw new Error("Unexpected ontology API shape: …")` |
| All steps filtered to empty | `throw new Error("No applicable rules for client_name=<x> department=<y>")` — per `rule_structure.md` §二 #5: code falls back, doesn't call LLM |
| Template file unreadable | error from `fs.readFile` bubbles up unchanged |

No retries, no custom timeout, no fallback URL. Callers that need resilience can wrap.

## Tests (vitest)

`lib/prompts/match-resume.test.ts`. `fetch` mocked via `vi.spyOn(globalThis, "fetch")`; the fixture is the JSON copied to `lib/prompts/__fixtures__/match-resume-rules.json` (so the test is hermetic and doesn't depend on `docs/`).

Test cases:

1. **Filter — predicate branches.** Six cases covering: `applicableClient="通用"` → kept; `client+N/A` → kept; `client+通用` → kept (the equivalence rule); `client+<exact dept>` → kept; `client+<other dept>` → dropped; `<other client>+anything` → dropped.
2. **Filter — executor.** A `Human`-executor rule that would otherwise pass the client/department predicate is dropped.
3. **Filter — empty step.** A step that ends up with zero surviving rules is omitted from the output entirely.
4. **Sorting.** Steps emerge in `order` numeric ascending; rules within a step in `id` ascending.
5. **Formatter.** Given a small hand-crafted step, the produced Markdown is byte-equal to an inline-expected string (asserts the exact format from `rule_structure.md` §二).
6. **Substitution.**
   - String `job_description` and `resume` flow through unchanged.
   - Object `job_description` and `resume` are stringified with 2-space indent.
   - `{{CURRENT_DATE}}` is replaced with `YYYY-MM-DD` (assert via regex match).
7. **End-to-end happy path.** Mock fetch with the fixture, call with `client_name="腾讯"`, `department="互动娱乐事业群"` (or any 腾讯 department in the fixture), assert: returned prompt contains `### Step 1: validateRedlineAndBlacklist`, contains `Rule 10-38` (腾讯+通用 — kept under the equivalence rule), excludes `Rule 10-19` (Human executor), excludes any rule with `applicableClient` neither `通用` nor `腾讯`.
8. **End-to-end empty result.** Mock fetch where every rule is dropped after filtering → public function throws the "No applicable rules" error.
9. **Fetch errors.** Mock fetch returning HTTP 500 → throws with the status code in the message.

## Branching

- Source: `steven`
- Working branch: `create-action-prompt`
- PR back to `steven` when done.

## Open questions / deferred decisions

- **Natural sort of rule IDs**: current spec uses plain string sort, which works for current data. If new rule IDs cross orders of magnitude within a step (`10-9` vs `10-10`), upgrade to natural-numeric sort. Not blocking.
- **URL via env var**: deferred. Add `ONTOLOGY_API_BASE_URL` env override only when a non-localhost deployment exists.
- **Token-budget guard**: if combined JD+resume+rules exceeds the model's context window, the function currently returns it anyway. Up to caller to chunk/limit. Not part of this scope.

## Acceptance criteria

- [ ] `lib/prompts/match-resume.ts` exports `generateMatchResumeRuleCheckPrompt` with the documented signature.
- [ ] All vitest cases above pass (`npm test`).
- [ ] `npm run build` succeeds (typecheck + lint).
- [ ] No existing tests regress.
- [ ] Calling the function against a live `localhost:3500` ontology service produces a prompt visually consistent with `rule_structure.md` §三 example.
