/**
 * Manual runner for `generateMatchResumeRuleCheckPrompt`.
 *
 * Edit the four parameters below, then run:
 *   npx tsx scripts/run-match-resume-prompt.ts
 *
 * Requires the ontology service to be reachable at
 *   http://localhost:3500/api/v1/ontology/actions/matchResume/rules
 * (the URL hardcoded in lib/prompts/match-resume.ts). If it's not running you'll
 * get a fetch error — start it first.
 */

import { generateMatchResumeRuleCheckPrompt } from "../lib/prompts/match-resume";

// ============================================================================
// 参数 — edit these to taste
// ============================================================================

const client_name = "腾讯";
const department = "互动娱乐事业群";

const job_description = {
  job_requisition_id: "JR-2026-001",
  title: "高级后端工程师",
  client: client_name,
  department,
  required_skills: ["Java", "Spring Boot", "MySQL"],
  preferred_skills: ["Kafka", "Redis"],
  min_years_experience: 5,
  education: "本科及以上",
  age_max: 40,
  language_requirement: null,
  gender_requirement: null,
};

const resume = {
  candidate_id: "C-12345",
  name: "Alice",
  date_of_birth: "1990-03-15",
  gender: "女",
  highest_education: {
    school: "复旦大学",
    degree: "本科",
    major: "计算机科学与技术",
    graduation_year: 2012,
    is_full_time: true,
  },
  work_experience: [
    {
      company: "字节跳动",
      title: "后端工程师",
      start_date: "2022-01",
      end_date: "2025-12",
      responsibilities: "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。",
    },
    {
      company: "华为",
      title: "软件工程师",
      start_date: "2014-07",
      end_date: "2021-12",
      responsibilities: "终端业务后端开发与维护。",
    },
  ],
  skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
  language_certifications: [],
  conflict_of_interest_declaration: "无亲属在腾讯任职。",
};

// ============================================================================
// run
// ============================================================================

async function main(): Promise<void> {
  console.log(
    `→ generateMatchResumeRuleCheckPrompt(client_name=${client_name}, department=${department})`,
  );

  const prompt = await generateMatchResumeRuleCheckPrompt(
    client_name,
    department,
    job_description,
    resume,
  );

  console.log("\n========== PROMPT BEGIN ==========\n");
  console.log(prompt);
  console.log("\n========== PROMPT END ==========\n");
  console.log(`(length: ${prompt.length} chars)`);
}

main().catch((err) => {
  console.error("✗ failed:", err);
  process.exit(1);
});
