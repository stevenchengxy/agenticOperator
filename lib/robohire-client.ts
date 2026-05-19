// AO ↔ RoboHire direct client.
//
// AO 不再通过 RAAS API Server 的 transparent-proxy 端点(/api/v1/parse-resume,
// /api/v1/match-resume) 调 RoboHire,改成直连 https://api.robohire.io。
//
// 仅 RoboHire-能力直连;持久化端点(/candidates, /match-results, /jd/sync-generated)
// 仍走 RAAS API Server,因为它们写 Postgres,RAAS 是 source of truth。
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md §3。

const DEFAULT_TIMEOUT_MS = 120_000;

function config(): { baseUrl: string; apiKey: string; timeoutMs: number } {
  const baseUrl = process.env.ROBOHIRE_API_BASE_URL?.trim();
  const apiKey = process.env.ROBOHIRE_API_KEY?.trim();
  if (!baseUrl) throw new RobohireApiError(0, 'CLIENT', 'ROBOHIRE_API_BASE_URL not set');
  if (!apiKey) throw new RobohireApiError(0, 'CLIENT', 'ROBOHIRE_API_KEY not set');
  const timeoutMs = Number(process.env.ROBOHIRE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return { baseUrl, apiKey, timeoutMs };
}

export class RobohireApiError extends Error {
  constructor(
    public httpStatus: number,
    public code: 'CLIENT' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'SERVER' | 'NETWORK',
    message: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'RobohireApiError';
  }
  /** 4xx (except 429) — caller should NonRetriable. */
  get isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500 && this.httpStatus !== 429;
  }
}

function statusToCode(status: number): RobohireApiError['code'] {
  if (status === 402) return 'QUOTA_EXHAUSTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'CLIENT';
  return 'SERVER';
}

export type CommonOpts = { traceId?: string; timeoutMs?: number };

// ─── parse-resume ───────────────────────────────────────────────

export type RobohireParseResumeData = {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: Array<{
    title?: string; company?: string; location?: string;
    startDate?: string; endDate?: string;
    description?: string; highlights?: string[];
  }>;
  education?: Array<{
    degree?: string; field?: string; institution?: string; graduationYear?: string;
  }>;
  skills?: string[];
  certifications?: string[];
  languages?: Array<{ language?: string; proficiency?: string }>;
  [k: string]: unknown;
};

export type RobohireParseResumeResponse = {
  data: RobohireParseResumeData;
  cached: boolean;
  documentId?: string;
  savedAs?: string;
  requestId: string;
};

export async function parseResumeDirect(
  pdf: Buffer,
  filename: string,
  opts: CommonOpts = {},
): Promise<RobohireParseResumeResponse> {
  const { baseUrl, apiKey, timeoutMs } = config();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/parse-resume`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
    });
  } catch (e) {
    throw new RobohireApiError(0, 'NETWORK', `parse-resume fetch failed: ${(e as Error).message}`);
  }

  return handleJsonResponse<RobohireParseResumeResponse>(res, 'parse-resume');
}

// ─── match-resume ───────────────────────────────────────────────

export type RobohireMatchResumeInput = {
  resume: string;
  jd: string;
  candidatePreferences?: string;
  jobMetadata?: string;
};

export type RobohireMatchResumeData = {
  matchScore: number;
  recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
  summary: string;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
  [k: string]: unknown;
};

export type RobohireMatchResumeResponse = {
  data: RobohireMatchResumeData;
  requestId: string;
  savedAs?: string;
};

export async function matchResumeDirect(
  input: RobohireMatchResumeInput,
  opts: CommonOpts = {},
): Promise<RobohireMatchResumeResponse> {
  const { baseUrl, apiKey, timeoutMs } = config();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/match-resume`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
    });
  } catch (e) {
    throw new RobohireApiError(0, 'NETWORK', `match-resume fetch failed: ${(e as Error).message}`);
  }

  return handleJsonResponse<RobohireMatchResumeResponse>(res, 'match-resume');
}

// ─── shared response handler ────────────────────────────────────

async function handleJsonResponse<T>(res: Response, op: string): Promise<T> {
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const code = statusToCode(res.status);
    const errMsg = body?.error ?? `${op} ${res.status} ${res.statusText}`;
    const requestId = body?.requestId;
    throw new RobohireApiError(res.status, code, errMsg, requestId);
  }

  if (!body || body.success === false) {
    throw new RobohireApiError(
      res.status,
      'SERVER',
      `${op} returned success=false: ${body?.error ?? 'unknown'}`,
      body?.requestId,
    );
  }

  return body as T;
}
