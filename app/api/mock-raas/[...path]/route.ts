// Mock RAAS API for local E2E testing.
//
// Two layers:
//   1. AI endpoints (parse-resume / generate-jd / match-resume) → **proxy
//      to real RoboHire** so AO agents get real LLM output. Without a real
//      RAAS DB we can't write the canonical RAAS-Postgres rows, but the
//      AI side is the only part of the chain that needs realistic data
//      for our DataObject mappings to look meaningful.
//   2. RAAS DB endpoints (save candidate / save match-results / sync JD /
//      get requirements) → return canned responses with realistic IDs.
//
// Env requirements:
//   ROBOHIRE_BASE_URL=https://api.robohire.io
//   ROBOHIRE_API_KEY=rh_xxx
//
//   RAAS_API_BASE_URL=http://localhost:3002/api/mock-raas npm run dev

import { NextResponse } from 'next/server';

const ROBOHIRE_BASE_URL = process.env.ROBOHIRE_BASE_URL ?? 'https://api.robohire.io';
const ROBOHIRE_API_KEY = process.env.ROBOHIRE_API_KEY ?? '';
const ROBOHIRE_TIMEOUT_MS = Number(process.env.ROBOHIRE_TIMEOUT_MS ?? 120_000);

type Params = { params: Promise<{ path: string[] }> };

async function proxyToRoboHire(
  path: string,
  body: unknown,
  init?: { contentType?: string; rawBody?: BodyInit },
): Promise<Response> {
  const url = `${ROBOHIRE_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'X-API-Key': ROBOHIRE_API_KEY,
  };
  if (init?.contentType) headers['Content-Type'] = init.contentType;
  else headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROBOHIRE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: init?.rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: controller.signal,
    });
    const text = await r.text();
    return new NextResponse(text, {
      status: r.status,
      headers: {
        'Content-Type': r.headers.get('content-type') ?? 'application/json',
        'X-Mock-Source': `robohire-proxy:${path}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function handle(req: Request, params: Params, method: string) {
  const { path } = await params.params;
  const fullPath = '/' + path.join('/');
  const url = new URL(req.url);

  let body: unknown = null;
  if (method !== 'GET') {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  }

  console.log(`[mock-raas] ${method} ${fullPath}`, url.searchParams.toString() || '(no query)');

  // ────────────────────────────────────────────────────────────────
  //  AI endpoints: proxy to real RoboHire (so agents see real data)
  // ────────────────────────────────────────────────────────────────

  if (fullPath.endsWith('/generate-jd') && method === 'POST') {
    if (!ROBOHIRE_API_KEY) {
      return NextResponse.json(
        { ok: false, error: 'mock-raas: ROBOHIRE_API_KEY not set in env' },
        { status: 500 },
      );
    }
    console.log('[mock-raas] → RoboHire /api/v1/jobs/generate-jd');
    return proxyToRoboHire('/api/v1/jobs/generate-jd', body);
  }

  if (fullPath.endsWith('/parse-resume') && method === 'POST') {
    if (!ROBOHIRE_API_KEY) {
      // No key → fall back to canned response.
      return NextResponse.json({
        success: true,
        data: {
          name: 'Mock 候选人 (no RoboHire key)',
          email: 'mock@test.com',
          phone: '13800000000',
          location: '北京',
          summary: 'Mock 简历 — 未配置 ROBOHIRE_API_KEY',
          experience: [],
          education: [],
          skills: ['Java'],
        },
        requestId: `mock_req_${Date.now()}`,
        savedAs: `mock_${Date.now()}.json`,
      });
    }
    // RoboHire /parse-resume expects multipart with a PDF file. We don't
    // have a PDF here (event payload already has parsed text), so we
    // synthesize a structured fallback that matches RoboHire's response
    // shape. Real parse-resume is only useful when the input is an
    // actual PDF buffer — which only the upload-handler step has.
    // For the agent's perspective, the parsed.data already on the event
    // is the SoT; this endpoint only re-emits it back.
    const b = (body as Record<string, unknown>) ?? {};
    const parsed = (b.parsed as Record<string, unknown>)?.data ?? b.data ?? {
      name: 'Mock 候选人 (parse-resume passthrough)',
      email: 'mock@test.com',
      phone: '13800000000',
      summary: 'Mock — parse-resume needs multipart PDF, passed through',
      experience: [],
      education: [],
      skills: [],
    };
    return NextResponse.json({
      success: true,
      data: parsed,
      requestId: `mock_req_${Date.now()}`,
      savedAs: `mock_${Date.now()}.json`,
    });
  }

  if (fullPath.endsWith('/match-resume') && method === 'POST') {
    if (!ROBOHIRE_API_KEY) {
      // No key → canned response with reasonable shape.
      return NextResponse.json({
        success: true,
        data: {
          overallMatchScore: { score: 85, grade: 'A', confidence: 'High' },
          overallFit: { verdict: 'Good Match', summary: 'mock (no RoboHire key)' },
          mustHaveAnalysis: { mustHaveScore: 90, disqualified: false, disqualificationReasons: [] },
          skillMatchScore: { score: 85 },
          workHistoryStability: { score: 80 },
          candidatePotential: { riskFactors: [] },
          transferableSkills: [],
          hardRequirementGaps: [],
        },
        requestId: `mock_match_${Date.now()}`,
      });
    }
    console.log('[mock-raas] → RoboHire /api/v1/match-resume');
    return proxyToRoboHire('/api/v1/match-resume', body);
  }

  // ────────────────────────────────────────────────────────────────
  //  RAAS DB endpoints: canned (no real RAAS-Postgres to read/write)
  // ────────────────────────────────────────────────────────────────

  // ─── save candidate ───
  // raas-api-client reads body.data → must wrap.
  if (fullPath.endsWith('/candidates') && method === 'POST') {
    const b = (body as Record<string, unknown>) ?? {};
    const uploadId = (b.upload_id as string) ?? `upload_${Date.now()}`;
    const safe = uploadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return NextResponse.json({
      success: true,
      data: {
        candidate_id: `cand_${safe}`,
        resume_id: `resume_${safe}`,
        candidate_expectation_id: `ce_${safe}`,
        is_new_candidate: true,
        is_new_resume: true,
        upload_id: uploadId,
      },
      requestId: `mock_req_${Date.now()}`,
    });
  }

  // ─── save match-results ───
  if (fullPath.endsWith('/match-results') && method === 'POST') {
    const b = (body as Record<string, unknown>) ?? {};
    const jrid = (b.job_requisition_id as string) ?? `jr_${Date.now()}`;
    const cid = (b.candidate_id as string) ?? `cand_${Date.now()}`;
    return NextResponse.json({
      success: true,
      data: {
        match_result_id: `mr_${cid}_${jrid}_${Date.now()}`,
        ok: true,
      },
      requestId: `mock_match_save_${Date.now()}`,
    });
  }

  // ─── jd/sync-generated ───
  if (fullPath.endsWith('/jd/sync-generated') && method === 'POST') {
    const b = (body as Record<string, unknown>) ?? {};
    const jrid = (b.job_requisition_id as string) ?? `jr_${Date.now()}`;
    return NextResponse.json({
      success: true,
      data: {
        synced: true,
        jd_id: `jd_${jrid}_${Date.now()}`,
        job_posting_id: `jp_${jrid}`,
      },
      requestId: `mock_sync_${Date.now()}`,
    });
  }

  // ─── requirements/agent-view (F2 — note SINGULAR `agent-view`,
  //     matches lib/raas-api-client.ts getRequirementsAgentView).
  //     Also accept legacy `/requirements/agents/view` so older test
  //     scripts don't break.
  if (
    (fullPath.includes('/requirements/agent-view') ||
      fullPath.includes('/requirements/agents/view')) &&
    method === 'GET'
  ) {
    // Endpoint shape per partner spec: top-level { items, page, page_size,
    // total, total_pages } — NOT wrapped in .data.
    return NextResponse.json({
      items: [
        {
          job_requisition_id: 'mock-jr-001',
          job_requisition_specification_id: 'mock-spec-001',
          client_id: 'mock-client-001',
          client_job_title: 'Mock Java 高级研发',
          job_responsibility: '负责后端开发',
          job_requirement: '5 年 Java 经验',
          must_have_skills: ['Java', 'MySQL'],
          nice_to_have_skills: ['Redis'],
          city: '北京',
          salary_range: '30k-50k',
          headcount: 1,
          work_years: 5,
          degree_requirement: '本科',
          recruitment_type: '社招',
          status: 'recruiting',
        },
      ],
      page: 1,
      page_size: 20,
      total: 1,
      total_pages: 1,
    });
  }

  // ─── F1: /candidates/:cid/resumes/:rid/parsed — thin-event back-pull ───
  //     Added 2026-05-19: mock returns a minimal RoboHire-shape parsed body
  //     so ruleCheckAgent's fetch-parsed step doesn't 404 in mock mode.
  if (
    fullPath.match(/\/candidates\/[^/]+\/resumes\/[^/]+\/parsed$/) &&
    method === 'GET'
  ) {
    const parts = fullPath.split('/');
    const ridIdx = parts.indexOf('resumes');
    const cidIdx = parts.indexOf('candidates');
    const candidateId = cidIdx >= 0 ? parts[cidIdx + 1] : 'mock-cand';
    const resumeId = ridIdx >= 0 ? parts[ridIdx + 1] : 'mock-res';
    return NextResponse.json({
      candidate_id: candidateId,
      resume_id: resumeId,
      data: {
        name: `Mock 候选人 ${candidateId.slice(0, 8)}`,
        email: 'mock@test.com',
        phone: '13800000000',
        location: '北京',
        summary: 'Mock 简历 — F1 back-pull 返回(mock-raas 占位数据)',
        experience: [
          {
            title: '高级 Java 工程师',
            company: 'Mock 公司',
            startDate: '2020-01',
            endDate: '2025-01',
            description: 'Mock 工作描述,5 年 Java + Spring + MySQL 经验。',
          },
        ],
        education: [
          {
            degree: '本科',
            field: '计算机科学',
            institution: 'Mock 大学',
            graduationYear: '2019',
          },
        ],
        skills: ['Java', 'Spring Boot', 'MySQL', 'Redis'],
        certifications: [],
        languages: ['普通话', 'English'],
      },
      candidate_snapshot: { candidate_id: candidateId, mock: true },
      resume_meta: { resume_id: resumeId, mock: true },
      requestId: `mock_parsed_${Date.now()}`,
    });
  }

  // ─── requirements/:id ───
  if (fullPath.match(/\/requirements\/[^/]+$/) && method === 'GET') {
    const id = fullPath.split('/').pop()!;
    return NextResponse.json({
      requirement: {
        job_requisition_id: id,
        job_requisition_specification_id: `spec_${id}`,
        client_id: 'mock-client-001',
        client_department_id: 'mock-dept-001',
        sd_org_name: '字节跳动 · 基础架构部',
        client_job_title: '高级 Java 后端工程师',
        job_responsibility:
          '负责字节跳动核心业务后端服务的设计与开发,优化高并发场景下的稳定性与性能,与算法、前端协同推进新功能落地',
        job_requirement:
          '5 年以上 Java 后端开发经验;熟悉 Spring Boot、MySQL、Redis、Kafka、分布式系统;有大流量服务设计经验',
        must_have_skills: ['Java', 'Spring Boot', 'MySQL', 'Redis', 'Kafka'],
        nice_to_have_skills: ['Dubbo', 'JVM 调优', '分布式事务'],
        negative_requirement: '',
        language_requirements: '中文 / 英文阅读',
        city: '北京',
        salary_range: '35k-60k',
        headcount: 2,
        work_years: 5,
        degree_requirement: '本科',
        education_requirement: '统招本科',
        recruitment_type: '社招',
        expected_level: '高级',
        interview_mode: '线下',
      },
      specification: { status: 'pending_generate', recruiter_employee_id: '0000199059' },
    });
  }

  // ─── resumes/uploads/:id/raw — tiny fake PDF ───
  if (fullPath.match(/\/resumes\/uploads\/.+\/raw$/) && method === 'GET') {
    const tinyPdf =
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\nxref\n0 1\n0000000000 65535 f\ntrailer<</Size 1>>\nstartxref\n0\n%%EOF\n';
    return new Response(tinyPdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(tinyPdf.length),
        'X-Mock-Source': 'mock-raas',
      },
    });
  }

  console.warn(`[mock-raas] UNHANDLED ${method} ${fullPath}`);
  return NextResponse.json(
    { ok: false, error: 'mock-not-implemented', path: fullPath, method },
    { status: 404 },
  );
}

export async function GET(req: Request, params: Params) {
  return handle(req, params, 'GET');
}
export async function POST(req: Request, params: Params) {
  return handle(req, params, 'POST');
}
export async function PUT(req: Request, params: Params) {
  return handle(req, params, 'PUT');
}
export async function PATCH(req: Request, params: Params) {
  return handle(req, params, 'PATCH');
}
export async function DELETE(req: Request, params: Params) {
  return handle(req, params, 'DELETE');
}
