// Write Resume instance to Neo4j via allmeta ontology API.
//
// Canonical schema (neo4j_data/objects_v0_1_015.json). Allmeta 严格校验:
//   resume_id, candidate_id, job_requisition_id (List<String>),
//   sourcing_channel_id, experience, projects, education, languages,
//   file_path, is_original, skills (List<String>), highlight_keywords,
//   recommendation_reason, project_description_validity, certifications,
//   portfolio, language, employee_id, created_time, updated_time,
//   publications, patents, awards, summary

import {
  safeWriteInstance,
  compact,
  nonEmptyString,
  asStringArray,
  type WriteResult,
} from './_helpers';

export type WriteResumeInput = {
  resume_id: string;
  candidate_id: string;
  job_requisition_id?: string | null;
  employee_id?: string | null;
  /** Partner MinIO object_key. */
  file_path?: string | null;
  /** RoboHire parse-resume `data` object (or partner pre-parsed JSON). */
  parsed: Record<string, unknown>;
};

function flattenSkillsToStringList(s: unknown): string[] {
  if (!s) return [];
  if (Array.isArray(s)) return asStringArray(s);
  if (typeof s === 'object') {
    const acc: string[] = [];
    const seen = new Set<string>();
    for (const v of Object.values(s as Record<string, unknown>)) {
      const flat = Array.isArray(v) ? v : [v];
      for (const item of flat) {
        if (typeof item === 'string' && item.trim() && !seen.has(item.trim())) {
          seen.add(item.trim());
          acc.push(item.trim());
        }
      }
    }
    return acc;
  }
  return [];
}

/** Allmeta Resume.experience / projects / education / languages 全是 String,
 *  RoboHire 返回的是 List<JSON>。Stringify 后传(超长截断). */
function jsonOrEmpty(v: unknown, maxChars = 100_000): string {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, maxChars);
  try {
    return JSON.stringify(v).slice(0, maxChars);
  } catch {
    return '';
  }
}

export async function writeResumeInstance(input: WriteResumeInput): Promise<WriteResult> {
  const p = input.parsed;
  const now = new Date().toISOString();
  const payload = compact({
    resume_id: input.resume_id,
    candidate_id: input.candidate_id,
    job_requisition_id: input.job_requisition_id ? [input.job_requisition_id] : [],
    experience: jsonOrEmpty(p.experience ?? p.workExperience),
    projects: jsonOrEmpty(p.projects ?? p.projectExperience),
    education: jsonOrEmpty(p.education ?? p.educationHistory),
    languages: jsonOrEmpty(p.languages),
    file_path: nonEmptyString(input.file_path),
    is_original: true,
    skills: flattenSkillsToStringList(p.skills),
    certifications: jsonOrEmpty(p.certifications),
    portfolio: jsonOrEmpty(p.portfolio),
    publications: jsonOrEmpty(p.publications),
    patents: jsonOrEmpty(p.patents),
    awards: jsonOrEmpty(p.awards),
    summary: nonEmptyString(p.summary),
    employee_id: nonEmptyString(input.employee_id),
    created_time: now,
    updated_time: now,
  });

  return safeWriteInstance('Resume', payload);
}
