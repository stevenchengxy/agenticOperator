// 把 3 对象嵌套压成 plain text，喂给 RoboHire /match-resume 的 resume 字段
// (v0_1_010 终稿 — 跟 docs/data/objects_v0_1_010.json 字段名对齐)

import type { ResumeProcessedData } from '../inngest/client';

export function flattenResumeForMatch(data: ResumeProcessedData): string {
  const { candidate, candidate_expectation, resume } = data;
  const lines: string[] = [];

  if ('name' in candidate && candidate.name) lines.push(`姓名 / Name: ${candidate.name}`);
  if ('email' in candidate && candidate.email) lines.push(`Email: ${candidate.email}`);
  if ('phone' in candidate && candidate.phone) lines.push(`Phone: ${candidate.phone}`);
  if ('address' in candidate && candidate.address) lines.push(`Address: ${candidate.address}`);
  if ('highest_acquired_degree' in candidate && candidate.highest_acquired_degree)
    lines.push(`Highest Degree: ${candidate.highest_acquired_degree}`);
  if ('work_years' in candidate && candidate.work_years != null)
    lines.push(`Work Years: ${candidate.work_years}`);
  if ('github' in candidate && candidate.github) lines.push(`GitHub: ${candidate.github}`);
  if ('ethnicity' in candidate && candidate.ethnicity) lines.push(`民族: ${candidate.ethnicity}`);
  if ('native_place' in candidate && candidate.native_place)
    lines.push(`籍贯: ${candidate.native_place}`);

  if ('skills' in resume && resume.skills.length > 0) {
    lines.push(`Skills: ${resume.skills.join(', ')}`);
  }

  if ('summary' in resume && resume.summary) {
    lines.push('');
    lines.push('Summary:');
    lines.push(resume.summary);
  }

  // experience 现在是 String(JSON.stringified Object[]),反序列化展开
  if ('experience' in resume && resume.experience) {
    lines.push('');
    lines.push('Work Experience:');
    try {
      const exps = JSON.parse(resume.experience) as Array<{
        title?: string;
        company?: string;
        startDate?: string;
        endDate?: string;
        description?: string;
      }>;
      for (const w of exps) {
        const range = `${w.startDate ?? '?'} – ${w.endDate ?? 'present'}`;
        lines.push(`- ${w.title ?? ''} at ${w.company ?? ''} (${range})`);
        if (w.description) lines.push(`  ${w.description}`);
      }
    } catch {
      lines.push(resume.experience); // 不是 JSON 就直接当文本
    }
  }

  if ('education' in resume && resume.education) {
    lines.push('');
    lines.push('Education:');
    try {
      const edus = JSON.parse(resume.education) as Array<{
        degree?: string;
        field?: string;
        institution?: string;
        graduationYear?: string;
      }>;
      for (const e of edus) {
        lines.push(
          `- ${e.degree ?? ''} in ${e.field ?? ''}, ${e.institution ?? ''} (${e.graduationYear ?? ''})`,
        );
      }
    } catch {
      lines.push(resume.education);
    }
  }

  if ('projects' in resume && resume.projects) {
    lines.push('');
    lines.push('Projects:');
    lines.push(resume.projects);
  }

  if ('certifications' in resume && resume.certifications) {
    lines.push('');
    lines.push('Certifications:');
    lines.push(resume.certifications);
  }

  if ('languages' in resume && resume.languages) {
    lines.push('');
    lines.push('Languages:');
    lines.push(resume.languages);
  }

  if (
    'expected_positions' in candidate_expectation &&
    (candidate_expectation.expected_positions ||
      candidate_expectation.expected_locations ||
      candidate_expectation.expected_salary_range)
  ) {
    lines.push('');
    lines.push('Expectations:');
    if (candidate_expectation.expected_positions)
      lines.push(`- Positions: ${candidate_expectation.expected_positions}`);
    if (candidate_expectation.expected_locations)
      lines.push(`- Locations: ${candidate_expectation.expected_locations}`);
    if (candidate_expectation.expected_salary_range)
      lines.push(`- Salary: ${candidate_expectation.expected_salary_range}`);
    if (candidate_expectation.expected_work_mode)
      lines.push(`- Work Mode: ${candidate_expectation.expected_work_mode}`);
  }

  return lines.join('\n').trim();
}
