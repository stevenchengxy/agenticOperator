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
