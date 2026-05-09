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

const ONTOLOGY_RULES_URL =
  "http://localhost:3500/api/v1/ontology/actions/matchResume/rules?domain=RAAS-v1";

const TEMPLATE_PATH =
  "docs/action_object_prompt/action_object_prompt_template.md";

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

export function formatRulesByStep(steps: MatchResumeStep[]): string {
  const sortedSteps = [...steps].sort(
    (a, b) => Number(a.order) - Number(b.order),
  );
  return sortedSteps
    .map((step) => {
      const sortedRules = [...step.rules].sort((a, b) => {
        const [aGroup, aNumStr = ""] = a.id.split("-");
        const [bGroup, bNumStr = ""] = b.id.split("-");
        if (aGroup !== bGroup) return aGroup.localeCompare(bGroup);
        return Number(aNumStr) - Number(bNumStr);
      });
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

export async function fetchRules(): Promise<MatchResumeRulesResponse> {
  const res = await fetch(ONTOLOGY_RULES_URL, {
    headers: { Authorization: "Bearer abc12345def" },
  });
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
