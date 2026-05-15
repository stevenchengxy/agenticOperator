// RoboHire /parse-resume 输出 → CandidateNested / CandidateExpectationNested / ResumeNested
// (v0_1_010 终稿 — 对齐 docs/data/objects_v0_1_010.json)
//
// 字段名直接跟 RoboHire vendor + Allmeta DataObject 一致。缺失字段一律 null/[] — 不虚构。

import type {
  CandidateExpectationNested,
  CandidateNested,
  ResumeNested,
} from '../inngest/client';
import type { RoboHireParsedData, RoboHireParsedExperience } from '../robohire';

const DEGREE_RANK: Record<string, number> = {
  Doctorate: 5,
  PhD: 5,
  博士: 5,
  Master: 4,
  Masters: 4,
  硕士: 4,
  Bachelor: 3,
  本科: 3,
  Associate: 2,
  专科: 2,
  大专: 2,
  Diploma: 1,
  HighSchool: 1,
  高中: 1,
};

function rankDegree(degree?: string): number {
  if (!degree) return 0;
  for (const [k, v] of Object.entries(DEGREE_RANK)) {
    if (degree.includes(k)) return v;
  }
  return 0;
}

function pickHighestDegree(edu: RoboHireParsedData['education']): string | null {
  if (!edu || edu.length === 0) return null;
  let best: { degree?: string; rank: number } = { rank: 0 };
  for (const e of edu) {
    const r = rankDegree(e.degree);
    if (r > best.rank) best = { degree: e.degree, rank: r };
  }
  return best.degree ?? edu[0]?.degree ?? null;
}

function calculateWorkYears(exp: RoboHireParsedExperience[] | undefined): number | null {
  if (!exp || exp.length === 0) return null;
  let totalMonths = 0;
  const now = new Date();

  for (const e of exp) {
    const start = parseDate(e.startDate);
    if (!start) continue;
    const endRaw = (e.endDate ?? '').toLowerCase();
    const end =
      endRaw === 'present' ||
      endRaw === 'current' ||
      endRaw === '' ||
      endRaw.includes('至今') ||
      endRaw.includes('现在')
        ? now
        : parseDate(e.endDate) ?? now;
    const months =
      (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    if (months > 0) totalMonths += months;
  }

  return totalMonths > 0 ? Math.round((totalMonths / 12) * 10) / 10 : null;
}

function parseDate(s?: string): Date | null {
  if (!s) return null;
  const m = s.match(/(\d{4})[-/](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, 1);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function cleanPhone(s?: string): string | null {
  if (!s) return null;
  const cleaned = s.replace(/[\s\-()+]/g, '').replace(/^86/, '');
  return cleaned || null;
}

// otherSections.个人信息补充 形如 "民族:汉族;生日:2002-10-10;籍贯:河南省驻马店市" — 解析派生字段
function parsePersonalInfo(text?: string): {
  ethnicity?: string;
  birth_date?: string;
  native_place?: string;
  gender?: string;
  address?: string;
} {
  if (!text || typeof text !== 'string') return {};
  const out: Record<string, string> = {};
  for (const seg of text.split(/[;；]/)) {
    const m = seg.match(/^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim();
    if (k.includes('民族')) out.ethnicity = v;
    else if (k.includes('生日') || k.includes('出生')) out.birth_date = v;
    else if (k.includes('籍贯')) out.native_place = v;
    else if (k.includes('性别')) out.gender = v;
    else if (k.includes('现居') || k.includes('地址')) out.address = v;
  }
  return out;
}

export type MappingResult = {
  candidate: CandidateNested;
  candidate_expectation: CandidateExpectationNested;
  resume: ResumeNested;
};

export function mapRobohireToRaas(parsed: RoboHireParsedData): MappingResult {
  const skills = parsed.skills ?? [];
  const otherSections = (parsed as Record<string, unknown>).otherSections as
    | Record<string, unknown>
    | undefined;
  const personal = parsePersonalInfo(otherSections?.['个人信息补充'] as string | undefined);

  const candidate: CandidateNested = {
    name: parsed.name?.trim() || null,
    phone: cleanPhone(parsed.phone),
    email: parsed.email?.trim() || null,
    gender: personal.gender ?? null,
    birth_date: personal.birth_date ?? null,
    address: personal.address ?? parsed.location?.trim() ?? null,
    highest_acquired_degree: pickHighestDegree(parsed.education),
    work_years: calculateWorkYears(parsed.experience),
    github: (parsed as Record<string, unknown>).github?.toString().trim() || null,
    ethnicity: personal.ethnicity ?? null,
    native_place: personal.native_place ?? null,
  };

  const expectedPosition = otherSections?.['求职意向'] as string | undefined;
  const expectedSalary = otherSections?.['期望薪资'] as string | undefined;

  const candidate_expectation: CandidateExpectationNested = {
    expected_positions: expectedPosition?.trim() || null,
    expected_locations: null,
    expected_industries: null,
    expected_salary_range: expectedSalary?.trim() || null,
    expected_work_mode: null,
  };

  const resume: ResumeNested = {
    summary: parsed.summary?.trim() || null,
    skills,
    experience:
      parsed.experience && parsed.experience.length > 0
        ? JSON.stringify(
            parsed.experience.map((e) => ({
              title: e.title,
              company: e.company,
              startDate: e.startDate,
              endDate: e.endDate,
              description: e.description,
            })),
          )
        : null,
    education:
      parsed.education && parsed.education.length > 0 ? JSON.stringify(parsed.education) : null,
    projects:
      Array.isArray((parsed as Record<string, unknown>).projects) &&
      ((parsed as Record<string, unknown>).projects as unknown[]).length > 0
        ? JSON.stringify((parsed as Record<string, unknown>).projects)
        : null,
    certifications:
      Array.isArray(parsed.certifications) && parsed.certifications.length > 0
        ? JSON.stringify(parsed.certifications)
        : null,
    languages:
      Array.isArray(parsed.languages) && parsed.languages.length > 0
        ? JSON.stringify(parsed.languages)
        : null,
    portfolio: (parsed as Record<string, unknown>).portfolio?.toString().trim() || null,
    publications:
      Array.isArray((parsed as Record<string, unknown>).publications) &&
      ((parsed as Record<string, unknown>).publications as unknown[]).length > 0
        ? JSON.stringify((parsed as Record<string, unknown>).publications)
        : null,
    patents:
      Array.isArray((parsed as Record<string, unknown>).patents) &&
      ((parsed as Record<string, unknown>).patents as unknown[]).length > 0
        ? JSON.stringify((parsed as Record<string, unknown>).patents)
        : null,
    awards:
      Array.isArray((parsed as Record<string, unknown>).awards) &&
      ((parsed as Record<string, unknown>).awards as unknown[]).length > 0
        ? JSON.stringify((parsed as Record<string, unknown>).awards)
        : null,
  };

  return { candidate, candidate_expectation, resume };
}

// 健全性检查 — 解析结果至少要能识别候选人
export function hasStructuredResumePayload(parsed: MappingResult): boolean {
  const c = parsed.candidate;
  const r = parsed.resume;
  const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

  return Boolean(
    nonEmpty(c.name) ||
      nonEmpty(c.phone) ||
      nonEmpty(c.email) ||
      r.skills.length > 0 ||
      nonEmpty(r.experience),
  );
}
