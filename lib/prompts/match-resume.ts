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
  "http://localhost:3500/api/v1/ontology/actions/matchResume/rules";

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
