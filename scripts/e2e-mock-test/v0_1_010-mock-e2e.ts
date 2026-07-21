// v0_1_010 mock end-to-end test
//
// 链路:
//   1. 用 RoboHire /parse-resume 真实响应(秦嘉阔) → AO mapper → CandidateNested + ResumeNested + ExpectationNested
//   2. 模拟 JR(来自 RAAS RaasRequirement shape)
//   3. RoboHire /match-resume 真实响应(秦嘉阔)→ AO mapper → MatchResult
//   4. 5 个 DataObject 全部通过 Allmeta API 写入 → Neo4j
//   5. Allmeta 读回验证
//
// 跑法:
//   cd /Users/yuhancheng/Desktop/agenticOperator
//   ALLMETA_API_TOKEN=dev-ao-allmeta-2026 npx tsx scripts/e2e-mock-test/v0_1_010-mock-e2e.ts

import { writeInstance, getInstance, ping } from '../../lib/allmeta-client';
import {
  toAllmetaCandidate,
  toAllmetaCandidateExpectation,
  toAllmetaResume,
  toAllmetaJobRequisition,
  toAllmetaMatchResult,
} from '../../resume-parser-agent/lib/mappers/ao-to-allmeta';
import { mapRobohireToRaas } from '../../resume-parser-agent/lib/mappers/robohire-to-raas';
import type { RoboHireParsedData } from '../../resume-parser-agent/lib/robohire';
import type { RaasRequirement, RaasMatchResumeData } from '../../resume-parser-agent/lib/raas-api-client';

process.env.ALLMETA_BASE_URL ||= 'http://localhost:3500';
process.env.ALLMETA_DOMAIN ||= 'RAAS-v1';
process.env.ALLMETA_API_KEY ||= 'dev-ao-allmeta-2026';

const log = (label: string, msg: unknown): void => {
  const line = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
  console.log(`── ${label} ──`);
  console.log(line);
  console.log('');
};

// ─────────────────────────────────────────────────────────────
// MOCK 1 — RoboHire /parse-resume 真实响应(秦嘉阔)
// ─────────────────────────────────────────────────────────────
const MOCK_PARSE_RESUME: RoboHireParsedData = {
  name: '秦嘉阔',
  email: '2282515772@qq.com',
  phone: '17839688051',
  location: '北京顺义',
  summary: '本人工作认真负责，沟通能力强，熟悉商务 BD 全流程，具备数据分析与项目协调能力。',
  experience: [
    {
      title: '商务 BD',
      company: '北京翼飞文化传媒',
      startDate: '2025.02',
      endDate: '2025.12',
      description: '负责品牌方对接、合作方案撰写、合同跟进，全年新增合作客户 30+，季度回款增长 25%。',
    },
    {
      title: '商务 BD',
      company: '北京京惠科技',
      startDate: '2024.06',
      endDate: '2025.01',
      description: '日常客户跟进、报价制作、订单跟踪，月均成单率 40%。',
    },
  ],
  education: [
    {
      degree: '本科',
      field: '市场营销',
      institution: '河南某大学',
      graduationYear: '2024',
    },
  ],
  skills: ['Excel', 'PPT', 'PS', '数据分析', '客户沟通', '商务谈判', 'SQL'],
  certifications: ['平面设计师证书'],
  languages: ['普通话(等级证书)'],
} as RoboHireParsedData & {
  github?: string;
  portfolio?: string;
  publications?: unknown[];
  patents?: unknown[];
  awards?: unknown[];
  otherSections?: Record<string, unknown>;
};

(MOCK_PARSE_RESUME as Record<string, unknown>).github = 'https://github.com/qinjiakuo-example';
(MOCK_PARSE_RESUME as Record<string, unknown>).portfolio = '';
(MOCK_PARSE_RESUME as Record<string, unknown>).publications = [];
(MOCK_PARSE_RESUME as Record<string, unknown>).patents = [];
(MOCK_PARSE_RESUME as Record<string, unknown>).awards = [];
(MOCK_PARSE_RESUME as Record<string, unknown>).otherSections = {
  个人信息补充: '民族:汉族;生日:2002-10-10;籍贯:河南省驻马店市',
  求职意向: '商务 BD',
  期望薪资: '6k-8k',
};

// ─────────────────────────────────────────────────────────────
// MOCK 2 — RAAS JR(模拟商务 BD 岗位)
// ─────────────────────────────────────────────────────────────
const MOCK_JR_ID = `mock_jr_v0_1_010_${Date.now()}`;
const MOCK_JR: RaasRequirement = {
  job_requisition_id: MOCK_JR_ID,
  job_requisition_specification_id: 'mock_spec_001',
  client_department_id: 'mock_client_dept_001',
  client_job_id: 'mock_client_job_001',
  client_job_title: '商务 BD（北京）',
  job_responsibility: '负责合作伙伴对接、合同跟进、订单 / 回款全流程、周报数据整理与汇报。',
  job_requirement: '1-3 年商务 / BD / 销售经验,熟练 Excel / PPT,沟通能力强,大专及以上学历。',
  must_have_skills: ['Excel', 'PPT', '商务沟通', '数据分析'],
  nice_to_have_skills: ['SQL', 'BD 经验', 'PS'],
  negative_requirement: '',
  language_requirements: '中文流利',
  city: '北京',
  salary_range: '6k-10k',
  headcount: 2,
  work_years: 1,
  degree_requirement: '大专',
  education_requirement: '全日制',
  interview_mode: '现场面试',
  expected_level: '初级',
  recruitment_type: '社会全职',
} as RaasRequirement;

// ─────────────────────────────────────────────────────────────
// MOCK 3 — RoboHire /match-resume 真实响应(秦嘉阔 → 商务 BD,score 91 STRONG_MATCH)
// ─────────────────────────────────────────────────────────────
const MOCK_MATCH_RESPONSE: RaasMatchResumeData = {
  overallMatchScore: { score: 91, grade: 'A', confidence: 'High' },
  overallFit: {
    verdict: 'Strong Match',
    summary:
      '候选人是该岗位的理想人选。其1.5年的BD经验与JD职责完美契合，且具备量化的业绩证明。额外的PS和SQL技能是加分项，学历和居住地（北京）均符合要求。',
    hiringRecommendation: 'Strongly Recommend',
  },
  mustHaveAnalysis: { mustHaveScore: 100, disqualified: false, disqualificationReasons: [] },
  skillMatchScore: { score: 92, credibilityFlags: { hasRedFlags: false } },
  workHistoryStability: { score: 80, pattern: 'Mostly Stable', shortStintCount: 1, averageTenureMonths: 9, currentlyEmployed: true },
  candidatePotential: { riskFactors: ['目前在职时间较短（最近一份工作不满一年）'] },
  transferableSkills: [{ required: '数据汇报', candidateHas: 'SQL + Excel + 数据分析', relevance: '高', valueFactor: 100 }],
  hardRequirementGaps: [],
} as RaasMatchResumeData;

// ─────────────────────────────────────────────────────────────
// E2E Pipeline
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  v0_1_010 mock E2E — AO → Allmeta API → Neo4j');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  // Step 0 — Allmeta health
  const health = await ping();
  log('Step 0 · Allmeta health', health);
  if (!health.ok) {
    console.error('❌ Allmeta studio :3500 not reachable. Abort.');
    process.exit(1);
  }

  // Step 1 — RoboHire parse → AO Nested
  const nested = mapRobohireToRaas(MOCK_PARSE_RESUME);
  log('Step 1 · AO Nested (CandidateNested)', nested.candidate);
  log('Step 1 · AO Nested (CandidateExpectationNested)', nested.candidate_expectation);
  log('Step 1 · AO Nested (ResumeNested, truncated)', {
    summary: nested.resume.summary,
    skills: nested.resume.skills,
    experience: nested.resume.experience?.substring(0, 100) + '...',
    education: nested.resume.education?.substring(0, 100) + '...',
    certifications: nested.resume.certifications,
    languages: nested.resume.languages,
    portfolio: nested.resume.portfolio,
  });

  // Step 2 — IDs
  const candidate_id = `mock_cand_v0_1_010_${Date.now()}`;
  const resume_id = `mock_resume_v0_1_010_${Date.now()}`;
  const client_id = 'mock_client_001';
  const match_id = `cmr_${candidate_id}_${MOCK_JR_ID}`;

  log('Step 2 · IDs', { candidate_id, resume_id, client_id, job_requisition_id: MOCK_JR_ID, match_id });

  // Step 3 — Allmeta payloads
  const candidatePayload = toAllmetaCandidate(nested.candidate, candidate_id);
  const expectationPayload = toAllmetaCandidateExpectation(nested.candidate_expectation, candidate_id);
  const resumePayload = toAllmetaResume(nested.resume, {
    resume_id,
    candidate_id,
    job_requisition_id: MOCK_JR_ID,
  });
  const jrPayload = toAllmetaJobRequisition(MOCK_JR);
  const matchPayload = toAllmetaMatchResult(MOCK_MATCH_RESPONSE, {
    candidate_match_result_id: match_id,
    candidate_id,
    client_id,
    job_requisition_id: MOCK_JR_ID,
  });

  log('Step 3 · Allmeta Candidate payload', candidatePayload);
  log('Step 3 · Allmeta Candidate_Expectation payload', expectationPayload);
  log('Step 3 · Allmeta Resume payload (truncated)', {
    ...resumePayload,
    experience: typeof resumePayload.experience === 'string' ? resumePayload.experience.substring(0, 80) + '...' : resumePayload.experience,
    education: typeof resumePayload.education === 'string' ? resumePayload.education.substring(0, 80) + '...' : resumePayload.education,
  });
  log('Step 3 · Allmeta Job_Requisition payload', jrPayload);
  log('Step 3 · Allmeta Candidate_Match_Result payload', matchPayload);

  // Step 4 — POST to Allmeta in dependency order: JR → Candidate → Expectation → Resume → MatchResult
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Step 4 — Writing to Allmeta');
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    const jrRes = await writeInstance('Job_Requisition', jrPayload);
    log('✅ Wrote :Job_Requisition', jrRes);
  } catch (e) {
    console.error('❌ Job_Requisition write failed:', (e as Error).message, (e as { details?: unknown }).details);
    throw e;
  }

  try {
    const cRes = await writeInstance('Candidate', candidatePayload);
    log('✅ Wrote :Candidate', cRes);
  } catch (e) {
    console.error('❌ Candidate write failed:', (e as Error).message, (e as { details?: unknown }).details);
    throw e;
  }

  try {
    const eRes = await writeInstance('Candidate_Expectation', expectationPayload);
    log('✅ Wrote :Candidate_Expectation', eRes);
  } catch (e) {
    console.error('❌ Candidate_Expectation write failed:', (e as Error).message, (e as { details?: unknown }).details);
    throw e;
  }

  try {
    const rRes = await writeInstance('Resume', resumePayload);
    log('✅ Wrote :Resume', rRes);
  } catch (e) {
    console.error('❌ Resume write failed:', (e as Error).message, (e as { details?: unknown }).details);
    throw e;
  }

  try {
    const mRes = await writeInstance('Candidate_Match_Result', matchPayload);
    log('✅ Wrote :Candidate_Match_Result', mRes);
  } catch (e) {
    console.error('❌ Candidate_Match_Result write failed:', (e as Error).message, (e as { details?: unknown }).details);
    throw e;
  }

  // Step 5 — Read-back
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Step 5 — Read-back verification');
  console.log('═══════════════════════════════════════════════════════\n');

  const back = await getInstance('Candidate', candidate_id);
  log('Read :Candidate back', back);

  const backMR = await getInstance('Candidate_Match_Result', match_id);
  log('Read :Candidate_Match_Result back', backMR);

  console.log('═══════════════════════════════════════════════════════');
  console.log('  ✅ v0_1_010 mock E2E passed');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('Cypher verification:');
  console.log(`  MATCH (c:Candidate {candidate_id: "${candidate_id}", domainId: "RAAS-v1"}) RETURN c`);
  console.log(`  MATCH (mr:Candidate_Match_Result {candidate_match_result_id: "${match_id}"}) RETURN mr`);
}

main().catch((err) => {
  console.error('\n❌ E2E failed:', err);
  process.exit(1);
});
