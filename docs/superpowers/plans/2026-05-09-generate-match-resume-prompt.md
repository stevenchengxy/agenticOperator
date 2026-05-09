# generateMatchResumeRuleCheckPrompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `generateMatchResumeRuleCheckPrompt(client_name, department, job_description, resume) → Promise<string>` in `lib/prompts/match-resume.ts` — fetches matchResume rules from the ontology service, filters by client/department/executor, formats survivors as Markdown, and substitutes into the existing prompt template.

**Architecture:** One module exposing a public async function plus four pure helpers (`isRuleApplicable`, `filterRules`, `formatRulesByStep`, `substituteTemplate`) and one I/O helper (`fetchRules`). TDD with vitest + `vi.stubGlobal('fetch', ...)`. JSON fixture copied from the docs sample so tests are hermetic.

**Tech Stack:** TypeScript 5, Node ≥22, Next.js 16 (server-side runtime), vitest 4 with `happy-dom` env, `node:fs/promises` for template reads.

**Source spec:** `docs/superpowers/specs/2026-05-09-generate-match-resume-prompt-design.md`

**Branch:** `create-action-prompt` (already created from `steven`).

---

## File map

| Path | Created/modified | Purpose |
|---|---|---|
| `lib/prompts/match-resume.ts` | Create | Types + 5 helpers + public function |
| `lib/prompts/match-resume.test.ts` | Create | Vitest unit + end-to-end tests |
| `lib/prompts/__fixtures__/match-resume-rules.json` | Create | Hermetic test fixture (copy of `docs/action_object_prompt/match_resume_action_and_rules.json`) |

The template at `docs/action_object_prompt/action_object_prompt_template.md` is read at runtime via `fs.readFile`; nothing in the docs tree is modified.

---

## Task 1: Scaffold module + copy fixture

**Files:**
- Create: `lib/prompts/match-resume.ts`
- Create: `lib/prompts/__fixtures__/match-resume-rules.json`

- [ ] **Step 1: Copy the docs sample to the test fixtures directory**

```bash
mkdir -p lib/prompts/__fixtures__
cp docs/action_object_prompt/match_resume_action_and_rules.json \
   lib/prompts/__fixtures__/match-resume-rules.json
```

Expected: file exists; `wc -l lib/prompts/__fixtures__/match-resume-rules.json` should report `2456`.

- [ ] **Step 2: Create `lib/prompts/match-resume.ts` with types, constants, and a public function stub**

Create `lib/prompts/match-resume.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type MatchResumeRule = {
  id: string;
  businessLogicRuleName: string;
  submissionCriteria: string;
  standardizedLogicRule: string;
  executor: string;
  applicableClient: string;
  applicableDepartment: string;
};

export type MatchResumeStep = {
  id: string;
  name: string;
  displayName?: string;
  order: string;
  description: string;
  condition: string;
  rules: MatchResumeRule[];
};

export type MatchResumeRulesResponse = {
  action_steps: MatchResumeStep[];
};

export const ONTOLOGY_RULES_URL =
  "http://localhost:3500/api/v1/ontology/actions/matchResume/rules";

export const TEMPLATE_PATH =
  "docs/action_object_prompt/action_object_prompt_template.md";

export async function generateMatchResumeRuleCheckPrompt(
  _client_name: string,
  _department: string,
  _job_description: string | Record<string, unknown>,
  _resume: string | Record<string, unknown>,
): Promise<string> {
  // Tasks 2–6 will replace this stub with real logic.
  void readFile;
  void resolve;
  throw new Error("not implemented");
}
```

(The `void readFile; void resolve;` lines silence unused-import warnings until Task 6 wires them up — they'll be removed naturally then.)

- [ ] **Step 3: Verify the project still typechecks**

```bash
npx tsc --noEmit
```

Expected: exits 0 with no new errors. (If pre-existing errors elsewhere in the repo are reported, ignore — only `lib/prompts/match-resume.ts` lines should be your concern.)

- [ ] **Step 4: Commit**

```bash
git add lib/prompts/match-resume.ts lib/prompts/__fixtures__/match-resume-rules.json
git commit -m "$(cat <<'EOF'
feat(prompts): scaffold match-resume prompt module + test fixture

Types, constants, and a stubbed public function. Helpers and tests land in
follow-up commits per docs/superpowers/plans/2026-05-09-generate-match-resume-prompt.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: isRuleApplicable + filterRules (TDD)

**Files:**
- Modify: `lib/prompts/match-resume.ts` — add `isRuleApplicable`, `filterRules`
- Create: `lib/prompts/match-resume.test.ts`

- [ ] **Step 1: Write failing tests for `isRuleApplicable` (7 cases) + `filterRules` (1 case)**

Create `lib/prompts/match-resume.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isRuleApplicable,
  filterRules,
  type MatchResumeRule,
  type MatchResumeStep,
} from "./match-resume";

const baseRule = (overrides: Partial<MatchResumeRule> = {}): MatchResumeRule => ({
  id: "10-1",
  businessLogicRuleName: "test",
  submissionCriteria: "sc",
  standardizedLogicRule: "logic",
  executor: "Agent",
  applicableClient: "通用",
  applicableDepartment: "N/A",
  ...overrides,
});

describe("isRuleApplicable", () => {
  it("keeps 通用 client rules regardless of department", () => {
    expect(
      isRuleApplicable(baseRule({ applicableClient: "通用" }), "腾讯", "互娱"),
    ).toBe(true);
  });

  it("keeps matching client + N/A department", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "腾讯", applicableDepartment: "N/A" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(true);
  });

  it("keeps matching client + 通用 department (treated as N/A)", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "腾讯", applicableDepartment: "通用" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(true);
  });

  it("keeps matching client + matching department", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "腾讯", applicableDepartment: "互娱" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(true);
  });

  it("drops matching client + different department", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "腾讯", applicableDepartment: "微信" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(false);
  });

  it("drops different client", () => {
    expect(
      isRuleApplicable(
        baseRule({ applicableClient: "字节", applicableDepartment: "N/A" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(false);
  });

  it("drops Human-executor rules even if client/department match", () => {
    expect(
      isRuleApplicable(
        baseRule({ executor: "Human", applicableClient: "通用" }),
        "腾讯",
        "互娱",
      ),
    ).toBe(false);
  });
});

describe("filterRules", () => {
  it("filters per-step and drops steps with zero surviving rules", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "10::s1",
        name: "S1",
        order: "1",
        description: "d",
        condition: "c",
        rules: [
          baseRule({ id: "10-1", applicableClient: "通用" }),
          baseRule({ id: "10-2", applicableClient: "字节", applicableDepartment: "N/A" }),
        ],
      },
      {
        id: "10::s2",
        name: "S2",
        order: "2",
        description: "d",
        condition: "c",
        rules: [
          baseRule({ id: "10-3", applicableClient: "字节", applicableDepartment: "N/A" }),
        ],
      },
    ];
    const out = filterRules(steps, "腾讯", "互娱");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("10::s1");
    expect(out[0].rules.map((r) => r.id)).toEqual(["10-1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: FAIL — vitest reports `SyntaxError`/import error: `isRuleApplicable` and `filterRules` are not exported from `./match-resume`.

- [ ] **Step 3: Implement `isRuleApplicable` and `filterRules`**

Edit `lib/prompts/match-resume.ts` — append these exports BEFORE the `generateMatchResumeRuleCheckPrompt` function:

```ts
export function isRuleApplicable(
  rule: MatchResumeRule,
  client_name: string,
  department: string,
): boolean {
  if (rule.executor !== "Agent") return false;
  if (rule.applicableClient === "通用") return true;
  if (rule.applicableClient !== client_name) return false;
  if (
    rule.applicableDepartment === "N/A" ||
    rule.applicableDepartment === "通用"
  ) {
    return true;
  }
  return rule.applicableDepartment === department;
}

export function filterRules(
  steps: MatchResumeStep[],
  client_name: string,
  department: string,
): MatchResumeStep[] {
  return steps
    .map((step) => ({
      ...step,
      rules: step.rules.filter((r) =>
        isRuleApplicable(r, client_name, department),
      ),
    }))
    .filter((step) => step.rules.length > 0);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: PASS — 8 tests across `isRuleApplicable` and `filterRules`.

- [ ] **Step 5: Commit**

```bash
git add lib/prompts/match-resume.ts lib/prompts/match-resume.test.ts
git commit -m "$(cat <<'EOF'
feat(prompts): isRuleApplicable + filterRules

Filter predicate: keeps rules where executor=Agent and (applicableClient=通用) or
(applicableClient=client_name and applicableDepartment in {N/A, 通用, department}).
filterRules drops empty steps after filtering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: formatRulesByStep (TDD)

**Files:**
- Modify: `lib/prompts/match-resume.ts` — add `formatRulesByStep`
- Modify: `lib/prompts/match-resume.test.ts` — add tests

- [ ] **Step 1: Add failing tests**

Append to `lib/prompts/match-resume.test.ts`:

```ts
import { formatRulesByStep } from "./match-resume";

describe("formatRulesByStep", () => {
  it("renders Markdown matching rule_structure.md §二 byte-for-byte", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "10::validateRedlineAndBlacklist",
        name: "validateRedlineAndBlacklist",
        order: "1",
        description: "the description",
        condition: "the condition",
        rules: [
          baseRule({
            id: "10-25",
            businessLogicRuleName: "rule one",
            submissionCriteria: "sc one",
            standardizedLogicRule: "logic one",
          }),
          baseRule({
            id: "10-26",
            businessLogicRuleName: "rule two",
            submissionCriteria: "sc two",
            standardizedLogicRule: "logic two",
          }),
        ],
      },
    ];
    const expected = [
      "### Step 1: validateRedlineAndBlacklist",
      "- step_id: 10::validateRedlineAndBlacklist",
      "- enter_condition: the condition",
      "- description: the description",
      "",
      "#### Rule 10-25: rule one",
      "- submissionCriteria: sc one",
      "- logic: logic one",
      "",
      "#### Rule 10-26: rule two",
      "- submissionCriteria: sc two",
      "- logic: logic two",
    ].join("\n");
    expect(formatRulesByStep(steps)).toBe(expected);
  });

  it("orders steps by numeric `order` ascending", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "s2", name: "S2", order: "2",
        description: "d2", condition: "c2",
        rules: [baseRule({ id: "10-2" })],
      },
      {
        id: "s1", name: "S1", order: "1",
        description: "d1", condition: "c1",
        rules: [baseRule({ id: "10-1" })],
      },
    ];
    const out = formatRulesByStep(steps);
    expect(out.indexOf("Step 1:")).toBeLessThan(out.indexOf("Step 2:"));
  });

  it("orders rules within a step by id ascending", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "s1", name: "S1", order: "1",
        description: "d", condition: "c",
        rules: [
          baseRule({ id: "10-2", businessLogicRuleName: "two" }),
          baseRule({ id: "10-1", businessLogicRuleName: "one" }),
        ],
      },
    ];
    const out = formatRulesByStep(steps);
    expect(out.indexOf("Rule 10-1:")).toBeLessThan(out.indexOf("Rule 10-2:"));
  });

  it("preserves verbatim newlines and quotes inside submissionCriteria/logic", () => {
    const steps: MatchResumeStep[] = [
      {
        id: "s1", name: "S1", order: "1",
        description: "d", condition: "c",
        rules: [
          baseRule({
            id: "10-1",
            businessLogicRuleName: "n",
            submissionCriteria: 'line "1"\nline 2',
            standardizedLogicRule: "step a\nstep b",
          }),
        ],
      },
    ];
    const out = formatRulesByStep(steps);
    expect(out).toContain('- submissionCriteria: line "1"\nline 2');
    expect(out).toContain("- logic: step a\nstep b");
  });
});
```

(Note: the `import { formatRulesByStep }` line goes at the top of the file alongside the existing imports — merge it. Same for later tasks.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: FAIL — `formatRulesByStep is not exported`.

- [ ] **Step 3: Implement `formatRulesByStep`**

Append to `lib/prompts/match-resume.ts` BEFORE `generateMatchResumeRuleCheckPrompt`:

```ts
export function formatRulesByStep(steps: MatchResumeStep[]): string {
  const sortedSteps = [...steps].sort(
    (a, b) => Number(a.order) - Number(b.order),
  );
  return sortedSteps
    .map((step) => {
      const sortedRules = [...step.rules].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      const ruleBlocks = sortedRules
        .map(
          (r) =>
            `#### Rule ${r.id}: ${r.businessLogicRuleName}\n` +
            `- submissionCriteria: ${r.submissionCriteria}\n` +
            `- logic: ${r.standardizedLogicRule}`,
        )
        .join("\n\n");
      return (
        `### Step ${step.order}: ${step.name}\n` +
        `- step_id: ${step.id}\n` +
        `- enter_condition: ${step.condition}\n` +
        `- description: ${step.description}\n\n` +
        ruleBlocks
      );
    })
    .join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: PASS — all earlier tests + 4 new `formatRulesByStep` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/prompts/match-resume.ts lib/prompts/match-resume.test.ts
git commit -m "$(cat <<'EOF'
feat(prompts): formatRulesByStep — Markdown per rule_structure.md §二

Steps ordered by numeric order; rules within a step ordered by id (string
ascending). submissionCriteria/logic preserved verbatim including newlines
and quotes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: substituteTemplate (TDD)

**Files:**
- Modify: `lib/prompts/match-resume.ts` — add `substituteTemplate`
- Modify: `lib/prompts/match-resume.test.ts` — add tests

- [ ] **Step 1: Add failing tests**

Append to `lib/prompts/match-resume.test.ts` (and add `substituteTemplate` to the top-of-file import):

```ts
describe("substituteTemplate", () => {
  it("replaces all four placeholders, including multiple occurrences", () => {
    const tmpl =
      "JD={{JOB_DESCRIPTION}} RES={{RESUME}} RBS={{RULES_BY_STEP}} " +
      "D1={{CURRENT_DATE}} D2={{CURRENT_DATE}}";
    const out = substituteTemplate(tmpl, {
      JOB_DESCRIPTION: "jd",
      RESUME: "re",
      RULES_BY_STEP: "rbs",
      CURRENT_DATE: "2026-05-09",
    });
    expect(out).toBe("JD=jd RES=re RBS=rbs D1=2026-05-09 D2=2026-05-09");
  });

  it("does not replace placeholders that aren't in the values map", () => {
    const tmpl = "{{JOB_DESCRIPTION}} {{UNKNOWN}}";
    const out = substituteTemplate(tmpl, {
      JOB_DESCRIPTION: "jd",
      RESUME: "re",
      RULES_BY_STEP: "rbs",
      CURRENT_DATE: "2026-05-09",
    });
    expect(out).toBe("jd {{UNKNOWN}}");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: FAIL — `substituteTemplate is not exported`.

- [ ] **Step 3: Implement `substituteTemplate`**

Append to `lib/prompts/match-resume.ts` BEFORE `generateMatchResumeRuleCheckPrompt`:

```ts
export function substituteTemplate(
  template: string,
  values: {
    JOB_DESCRIPTION: string;
    RESUME: string;
    RULES_BY_STEP: string;
    CURRENT_DATE: string;
  },
): string {
  return template
    .replaceAll("{{JOB_DESCRIPTION}}", values.JOB_DESCRIPTION)
    .replaceAll("{{RESUME}}", values.RESUME)
    .replaceAll("{{RULES_BY_STEP}}", values.RULES_BY_STEP)
    .replaceAll("{{CURRENT_DATE}}", values.CURRENT_DATE);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: PASS — all earlier tests + 2 new `substituteTemplate` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/prompts/match-resume.ts lib/prompts/match-resume.test.ts
git commit -m "$(cat <<'EOF'
feat(prompts): substituteTemplate — replace 4 placeholders via replaceAll

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: fetchRules (TDD)

**Files:**
- Modify: `lib/prompts/match-resume.ts` — add `fetchRules`
- Modify: `lib/prompts/match-resume.test.ts` — add tests

- [ ] **Step 1: Add failing tests**

Append to `lib/prompts/match-resume.test.ts` (and merge `fetchRules` into the top-of-file import; also add `vi`, `beforeEach`, `afterEach` to the vitest import):

```ts
describe("fetchRules", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed response on 200", async () => {
    (fetch as unknown as { mockResolvedValueOnce: Function }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ action_steps: [] }),
    });
    const out = await fetchRules();
    expect(out.action_steps).toEqual([]);
  });

  it("calls the configured ontology URL", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ action_steps: [] }),
    });
    await fetchRules();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3500/api/v1/ontology/actions/matchResume/rules",
    );
  });

  it("throws with status code in message on non-2xx", async () => {
    (fetch as unknown as { mockResolvedValueOnce: Function }).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    await expect(fetchRules()).rejects.toThrow(/500/);
  });

  it("throws when response is missing action_steps", async () => {
    (fetch as unknown as { mockResolvedValueOnce: Function }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ wrong: "shape" }),
    });
    await expect(fetchRules()).rejects.toThrow(/action_steps/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: FAIL — `fetchRules is not exported`.

- [ ] **Step 3: Implement `fetchRules`**

Append to `lib/prompts/match-resume.ts` BEFORE `generateMatchResumeRuleCheckPrompt`:

```ts
export async function fetchRules(): Promise<MatchResumeRulesResponse> {
  const res = await fetch(ONTOLOGY_RULES_URL);
  if (!res.ok) {
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).slice(0, 200);
    } catch {
      // ignore body read failures
    }
    throw new Error(
      `Failed to fetch matchResume rules: GET ${ONTOLOGY_RULES_URL} -> ${res.status}. Body: ${bodySnippet}`,
    );
  }
  const json = (await res.json()) as unknown;
  if (
    !json ||
    typeof json !== "object" ||
    !Array.isArray((json as { action_steps?: unknown }).action_steps)
  ) {
    throw new Error("Unexpected ontology API shape: missing action_steps array.");
  }
  return json as MatchResumeRulesResponse;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: PASS — all earlier tests + 4 new `fetchRules` tests.

- [ ] **Step 5: Commit**

```bash
git add lib/prompts/match-resume.ts lib/prompts/match-resume.test.ts
git commit -m "$(cat <<'EOF'
feat(prompts): fetchRules — ontology API client with shape validation

GET http://localhost:3500/api/v1/ontology/actions/matchResume/rules.
Throws with status + body snippet on non-2xx; throws on malformed shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: generateMatchResumeRuleCheckPrompt (end-to-end, TDD)

**Files:**
- Modify: `lib/prompts/match-resume.ts` — replace stub with real implementation
- Modify: `lib/prompts/match-resume.test.ts` — add end-to-end tests

- [ ] **Step 1: Add failing end-to-end tests**

Append to `lib/prompts/match-resume.test.ts` (merge `generateMatchResumeRuleCheckPrompt` into the top-of-file import):

```ts
describe("generateMatchResumeRuleCheckPrompt (end-to-end)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("produces a fully substituted prompt for 腾讯", async () => {
    const fixtureModule = await import(
      "./__fixtures__/match-resume-rules.json"
    );
    const fixture = fixtureModule.default;
    (fetch as unknown as { mockResolvedValueOnce: Function }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fixture,
    });

    const out = await generateMatchResumeRuleCheckPrompt(
      "腾讯",
      "互动娱乐事业群",
      { title: "Senior Engineer" },
      { name: "Alice" },
    );

    // Step header rendered
    expect(out).toMatch(/### Step 1: validateRedlineAndBlacklist/);
    // 腾讯+通用 rule kept under the equivalence rule
    expect(out).toContain("Rule 10-38");
    // Human-executor rule dropped
    expect(out).not.toContain("Rule 10-19");
    // CURRENT_DATE substituted with today's UTC date
    const today = new Date().toISOString().slice(0, 10);
    expect(out).toContain(today);
    // No unreplaced placeholders remain in the input/inputs sections
    expect(out).not.toContain("{{JOB_DESCRIPTION}}");
    expect(out).not.toContain("{{RESUME}}");
    expect(out).not.toContain("{{RULES_BY_STEP}}");
    expect(out).not.toContain("{{CURRENT_DATE}}");
    // Object inputs serialized as pretty JSON
    expect(out).toContain('"title": "Senior Engineer"');
    expect(out).toContain('"name": "Alice"');
  });

  it("passes string inputs through unchanged", async () => {
    const fixtureModule = await import(
      "./__fixtures__/match-resume-rules.json"
    );
    const fixture = fixtureModule.default;
    (fetch as unknown as { mockResolvedValueOnce: Function }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fixture,
    });

    const out = await generateMatchResumeRuleCheckPrompt(
      "腾讯",
      "互动娱乐事业群",
      "raw JD text",
      "raw resume text",
    );
    expect(out).toContain("raw JD text");
    expect(out).toContain("raw resume text");
  });

  it("throws when no rules survive filtering", async () => {
    (fetch as unknown as { mockResolvedValueOnce: Function }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ action_steps: [] }),
    });
    await expect(
      generateMatchResumeRuleCheckPrompt("nope", "nope", "jd", "resume"),
    ).rejects.toThrow(/No applicable rules/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: FAIL — the public function still throws `not implemented`.

- [ ] **Step 3: Replace the public function stub with the real implementation**

In `lib/prompts/match-resume.ts`, **replace** the entire `generateMatchResumeRuleCheckPrompt` stub (and remove the `void readFile; void resolve;` lines from Task 1) with:

```ts
function stringifyInput(value: string | Record<string, unknown>): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function generateMatchResumeRuleCheckPrompt(
  client_name: string,
  department: string,
  job_description: string | Record<string, unknown>,
  resume: string | Record<string, unknown>,
): Promise<string> {
  const response = await fetchRules();
  const filteredSteps = filterRules(
    response.action_steps,
    client_name,
    department,
  );
  if (filteredSteps.length === 0) {
    throw new Error(
      `No applicable rules for client_name=${client_name} department=${department}`,
    );
  }
  const rulesByStep = formatRulesByStep(filteredSteps);
  const template = await readFile(
    resolve(process.cwd(), TEMPLATE_PATH),
    "utf8",
  );
  return substituteTemplate(template, {
    JOB_DESCRIPTION: stringifyInput(job_description),
    RESUME: stringifyInput(resume),
    RULES_BY_STEP: rulesByStep,
    CURRENT_DATE: todayISODate(),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/prompts/match-resume.test.ts
```

Expected: PASS — every previously passing test plus the 3 new end-to-end tests.

- [ ] **Step 5: Commit**

```bash
git add lib/prompts/match-resume.ts lib/prompts/match-resume.test.ts
git commit -m "$(cat <<'EOF'
feat(prompts): generateMatchResumeRuleCheckPrompt public function

Composes fetchRules → filterRules → formatRulesByStep → substituteTemplate.
String inputs pass through; object inputs are JSON.stringified with 2-space
indent. {{CURRENT_DATE}} filled with today's UTC date (YYYY-MM-DD).
Throws when no rules survive filtering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final verification (typecheck + full test suite + lint)

**Files:** none modified (verification only).

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: every existing test plus the new `lib/prompts/match-resume.test.ts` cases pass. Note any unrelated regressions.

- [ ] **Step 2: Run the production build (typecheck + lint)**

```bash
npm run build
```

Expected: build succeeds. If lint fires on the new file, address each warning before proceeding (no autofix that touches unrelated files).

- [ ] **Step 3: Smoke-check the public function shape via grep**

```bash
grep -n "export async function generateMatchResumeRuleCheckPrompt" lib/prompts/match-resume.ts
grep -n "export function isRuleApplicable\|export function filterRules\|export function formatRulesByStep\|export function substituteTemplate\|export async function fetchRules" lib/prompts/match-resume.ts
```

Expected: all six exports present.

- [ ] **Step 4: If build & tests pass, no commit needed for this task.** If lint required edits, commit them:

```bash
git add lib/prompts/match-resume.ts lib/prompts/match-resume.test.ts
git commit -m "$(cat <<'EOF'
chore(prompts): satisfy lint after match-resume scaffolding

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria

- [ ] `lib/prompts/match-resume.ts` exports `generateMatchResumeRuleCheckPrompt` with the documented signature plus `isRuleApplicable`, `filterRules`, `formatRulesByStep`, `substituteTemplate`, `fetchRules`, and the type/constant exports.
- [ ] `npm test` is green.
- [ ] `npm run build` is green.
- [ ] Branch `create-action-prompt` has 6–7 commits scoped one-per-task, ready for PR back to `steven`.
