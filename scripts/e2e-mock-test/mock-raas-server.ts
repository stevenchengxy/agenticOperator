// Mock RAAS API Server — Node built-in http (no extra deps)。
//
// 把 AO 通过 lib/raas-api-client.ts 发出去的 HTTP 调用拦下来,返回 mock 响应。
// 同时把每个调用记录到 __seenCalls,供 verifier 验证(例如 "matchResume 被调
// 时,body.resume 头部是否含 ## Rule Check Annotations")。
//
// 不需要新 deps —— Node http 模块够用。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { candidateById, jdById } from './fixtures/scenarios';

// ─── 全局调用日志(test 跑完后 verifier 读) ───

export interface SeenCall {
  method: string;
  path: string;
  url: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  ts: number;
  /** 响应状态码 + 我们返回的 body(快照,verifier 用) */
  response: { status: number; body: unknown };
}

const __seenCalls: SeenCall[] = [];

export function getSeenCalls(): SeenCall[] {
  return [...__seenCalls];
}

export function clearSeenCalls() {
  __seenCalls.length = 0;
}

// ─── 当前 active scenario(测试时通过 setActiveScenario 切换) ───
//
// 用全局变量是因为 mock 服务是单进程长连接,test driver 跑 N 个 scenario
// 时需要告诉 mock "现在用哪个 candidate / JD fixture 来响应"。
// 不优雅,但够用。

interface ActiveContext {
  candidate_id: string;
  jd_id: string;
}

let __active: ActiveContext | null = null;

export function setActiveScenario(ctx: ActiveContext) {
  __active = ctx;
}

function getActive(): ActiveContext {
  if (!__active) {
    throw new Error('[mock-raas] no active scenario — call setActiveScenario() first');
  }
  return __active;
}

// ─── HTTP helpers ───

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => (buf += chunk));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * 真实 raas API 响应格式:`{ data, requestId, _traceId }`。
 * raas-api-client 大部分函数都 spread `body.data`。
 * 用这个 helper 包裹 mock 响应,避免 candidate_id / resume_id 等 spread 不出来。
 */
function envelope<T>(data: T, requestId = `req_${Math.random().toString(36).slice(2, 10)}`) {
  return { data, requestId, _traceId: null };
}

function record(req: IncomingMessage, body: unknown, response: SeenCall['response']) {
  __seenCalls.push({
    method: req.method ?? 'GET',
    path: (req.url ?? '/').split('?')[0]!,
    url: req.url ?? '/',
    body,
    headers: { ...req.headers },
    ts: Date.now(),
    response,
  });
}

// ─── Mock data builders ───

/**
 * Build mock parse-resume response = use the candidate fixture's parsed data
 * verbatim (production 中由 Robohire /parse-resume 输出 RaasParseResumeData,
 * 我们的 fixture 字段命名跟它对齐)。
 */
function mockParseResumeResponse(candidate_id: string) {
  const c = candidateById(candidate_id);
  // RaasParseResumeData shape:{ cached, data, requestId }
  return {
    cached: false,
    data: c.resume,
    requestId: `rh_${randomUUID().slice(0, 8)}`,
  };
}

function mockSaveCandidateResponse() {
  return {
    candidate_id: `C_${randomUUID().slice(0, 8)}`,
    resume_id: `R_${randomUUID().slice(0, 8)}`,
    is_new_candidate: true,
    is_new_resume: true,
    candidate_name: candidateById(getActive().candidate_id).resume.name,
  };
}

function mockRequirementDetailResponse(jr_id?: string) {
  const targetJrId = jr_id ?? getActive().jd_id;
  const j = jdById(targetJrId);
  return {
    requirement: j.jr,
    specification: j.spec ?? null,
  };
}

function mockRequirementsAgentViewResponse() {
  // 默认返回 active scenario 的 JD 作为唯一一条
  const j = jdById(getActive().jd_id);
  return {
    items: [j.jr],
  };
}

function mockMatchResumeResponse(body: { resume: string; jd: string }) {
  // Deterministic stub:matchScore 跟 resumeText.length 挂钩(可重复,跟 augment
  // 注入与否相关,verifier 可分辨)
  const score = ((body.resume?.length ?? 0) % 31) + 60;
  return {
    success: true,
    data: {
      matchScore: score,
      recommendation: score >= 75 ? '推荐' : '待定',
      // 复制 Robohire 真实响应里常见的字段名(camelCase 全套),让 saveMatchResults
      // 上游的 spread 行为得到验证
      overallMatchScore: score,
      skillMatch: score - 5,
      experienceMatch: score - 3,
      candidatePotential: score + 1,
      jdAnalysis: 'mocked JD analysis',
      suggestedInterviewQuestions: ['问题1', '问题2'],
      // 通过 stub 返回是否检测到 augmentation header(简单 substring 探测,
      // 给 verifier 一个 sanity check 信号)
      _stub_detected_augmentation: body.resume?.startsWith('## Rule Check Annotations'),
      _stub_resume_chars: body.resume?.length ?? 0,
    },
    requestId: `rh_match_${randomUUID().slice(0, 8)}`,
    savedAs: `mres_${randomUUID().slice(0, 8)}`,
  };
}

function mockSaveMatchResultsResponse() {
  return {
    ok: true,
    id: `MR_${randomUUID().slice(0, 8)}`,
  };
}

// ─── Router ───

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? '/';
  const path = url.split('?')[0]!;
  const method = req.method ?? 'GET';

  try {
    // Health
    if (path === '/health') {
      const r = { ok: true, ts: Date.now() };
      json(res, 200, r);
      record(req, null, { status: 200, body: r });
      return;
    }

    // GET /api/v1/resumes/uploads/:id/raw → 返回 dummy PDF bytes(简单 ASCII)
    const m1 = path.match(/^\/api\/v1\/resumes\/uploads\/([^/]+)\/raw$/);
    if (m1 && method === 'GET') {
      // production 中 raas-api-client.downloadResumeRaw 期望 binary stream + filename header
      const dummy = Buffer.from('%PDF-1.4\nmock pdf for ' + m1[1] + '\n%%EOF');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="mock-${m1[1]}.pdf"`,
      );
      res.end(dummy);
      record(req, null, { status: 200, body: '<binary pdf>' });
      return;
    }

    // POST /api/v1/parse-resume(multipart) — 我们用 fixture 直接返回
    if (path === '/api/v1/parse-resume' && method === 'POST') {
      // 不解析 multipart body —— 直接拿 active scenario 的 candidate fixture
      const inner = mockParseResumeResponse(getActive().candidate_id);
      const r = envelope(inner);
      json(res, 200, r);
      record(req, '<multipart body skipped>', { status: 200, body: r });
      return;
    }

    // POST /api/v1/candidates
    if (path === '/api/v1/candidates' && method === 'POST') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const inner = mockSaveCandidateResponse();
      const r = envelope(inner);
      json(res, 200, r);
      record(req, body, { status: 200, body: r });
      return;
    }

    // GET /api/v1/requirements/:id  — 注意:这条 endpoint **flat** 响应,
    // 不包 data envelope(raas-api-client.getRequirementDetail 直接读 body.requirement)
    const m2 = path.match(/^\/api\/v1\/requirements\/([^/]+)$/);
    if (m2 && method === 'GET') {
      const jrId = m2[1]!;
      const j = jdById(getActive().jd_id);
      if (j.jr.job_requisition_id !== jrId) {
        // eslint-disable-next-line no-console
        console.warn(
          `[mock-raas] requirement detail asked for ${jrId} but active is ${j.jr.job_requisition_id}; returning active`,
        );
      }
      // FLAT — getRequirementDetail 读 body.requirement / body.specification 等顶层字段
      const r = {
        requirement: j.jr,
        specification: j.spec ?? null,
        siblings: [],
        latest_task: null,
        latest_analysis: null,
        analysis_history: [],
        clarification_rounds: [],
        requestId: `req_${Math.random().toString(36).slice(2, 10)}`,
      };
      json(res, 200, r);
      record(req, null, { status: 200, body: r });
      return;
    }

    // GET /api/v1/requirements/agent-view — 也是 flat
    if (path === '/api/v1/requirements/agent-view' && method === 'GET') {
      const inner = mockRequirementsAgentViewResponse();
      const r = {
        items: inner.items,
        page: 1,
        page_size: 20,
        total: inner.items.length,
        total_pages: 1,
        requestId: `req_${Math.random().toString(36).slice(2, 10)}`,
      };
      json(res, 200, r);
      record(req, null, { status: 200, body: r });
      return;
    }

    // POST /api/v1/match-resume(deterministic stub Robohire)
    if (path === '/api/v1/match-resume' && method === 'POST') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const inner = mockMatchResumeResponse(body);
      const r = envelope(inner);
      json(res, 200, r);
      record(req, body, { status: 200, body: r });
      return;
    }

    // POST /api/v1/match-results
    if (path === '/api/v1/match-results' && method === 'POST') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const inner = mockSaveMatchResultsResponse();
      const r = envelope(inner);
      json(res, 200, r);
      record(req, body, { status: 200, body: r });
      return;
    }

    // POST /api/v1/generate-jd(本测试不跑 JD 生成,但写上以防 agent 误调)
    if (path === '/api/v1/generate-jd' && method === 'POST') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const r = envelope({ mockedJd: 'stub' });
      json(res, 200, r);
      record(req, body, { status: 200, body: r });
      return;
    }

    // POST /api/v1/jd/sync-generated
    if (path === '/api/v1/jd/sync-generated' && method === 'POST') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const r = envelope({ ok: true, jd_id: 'JD_stub' });
      json(res, 200, r);
      record(req, body, { status: 200, body: r });
      return;
    }

    // 未知路径 — 返回 404 但记录
    json(res, 404, { error: 'not_found', path });
    record(req, null, { status: 404, body: { error: 'not_found' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: 'mock_server_error', message: msg });
    record(req, null, { status: 500, body: { error: msg } });
  }
}

// ─── Server lifecycle ───

export interface MockServer {
  port: number;
  close(): Promise<void>;
}

export async function startMockRaasServer(port = 3001): Promise<MockServer> {
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[mock-raas] handler error:', e);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
