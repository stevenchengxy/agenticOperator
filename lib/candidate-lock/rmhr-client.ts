// lib/candidate-lock/rmhr-client.ts
//
// RMHR (Resume-Management / HR) seam — uploads a resume PDF under a recruiter
// email and parses the two-layer envelope response into a LockSnapshot.
//
// Mirrors robohire-client.ts conventions:
//   - FormData + Blob multipart upload
//   - AbortSignal.timeout
//   - logApiCall for independent sink (best-effort, never blocks the call)
//   - RmhrApiError error class with typed code strings

import { logApiCall } from '@/lib/external-api-log';
import type { LockSnapshot } from './types';
import { LockState } from './types';

// ─── Error class ────────────────────────────────────────────────

export class RmhrApiError extends Error {
  constructor(
    public code: 'CLIENT' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'SERVER' | 'NETWORK' | 'BUSINESS',
    message: string,
    public httpStatus = 0,
    public businessCode?: number,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'RmhrApiError';
  }

  /** 4xx (except 429) — caller should NonRetriable. */
  get isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500 && this.httpStatus !== 429;
  }
}

// ─── Config ─────────────────────────────────────────────────────

export function rmhrConfig(): { host: string; apiKey: string; timeoutMs: number } {
  const host = process.env.RMHR_INTERNAL_HOST?.trim();
  const apiKey = process.env.RMHR_INTERNAL_API_KEY?.trim();
  if (!host) throw new RmhrApiError('CLIENT', 'RMHR_INTERNAL_HOST not set');
  if (!apiKey) throw new RmhrApiError('CLIENT', 'RMHR_INTERNAL_API_KEY not set');
  const timeoutMs = Number(process.env.RMHR_TIMEOUT_MS ?? 20_000);
  return { host, apiKey, timeoutMs };
}

// ─── Response parser ────────────────────────────────────────────

/**
 * parseRmhrResponse — pure function over the two-layer RMHR envelope.
 *
 * Outer layer: { code, msg, timestamp, data: { code, msg, success, model } }
 * Inner model field: JSON-encoded string containing the actual resume/lock data.
 *
 * Throws RmhrApiError:
 *   - code='BUSINESS'  when data.code === 1001 (e.g. email not in DB)
 *   - code='SERVER'    when data.code === 1000 but model is missing/unparseable
 *   - code='SERVER'    for any other data.code value
 */
export function parseRmhrResponse(raw: any): LockSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new RmhrApiError('SERVER', 'RMHR response is not an object');
  }

  const data = raw.data;
  if (!data || typeof data !== 'object') {
    throw new RmhrApiError('SERVER', 'RMHR response missing data field');
  }

  const dataCode: number = data.code;

  if (dataCode === 1001) {
    throw new RmhrApiError('BUSINESS', data.msg ?? '招聘邮箱不存在，不入库', 0, 1001);
  }

  if (dataCode === 1000) {
    if (data.model == null) {
      throw new RmhrApiError('SERVER', 'RMHR data.code=1000 but model is null/missing');
    }

    let model: any;
    try {
      model = JSON.parse(data.model as string);
    } catch {
      throw new RmhrApiError('SERVER', 'RMHR data.model is not valid JSON (unparseable)');
    }

    const blacklisted =
      typeof model.message === 'string' && model.message.includes('黑名单');

    return {
      rmhrResumeId: String(model.resumeId),
      lockState: model.lockState as LockState,
      blacklisted,
      lockByEmployeeId: model.lockBy ?? null,
      lockByName: model.lockByName ?? null,
      lockByEmail: model.lockByEmail ?? null,
      lockTime: model.lockTime ?? null,
      message: model.message ?? null,
    };
  }

  // Any other data.code is unexpected
  throw new RmhrApiError(
    'SERVER',
    `RMHR unexpected data.code=${dataCode}: ${data.msg ?? 'unknown'}`,
    0,
    dataCode,
  );
}

// ─── HTTP helper ────────────────────────────────────────────────

function statusToCode(
  status: number,
): 'CLIENT' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'SERVER' {
  if (status === 402) return 'QUOTA_EXHAUSTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'CLIENT';
  return 'SERVER';
}

// ─── Public API call ────────────────────────────────────────────

/**
 * uploadByRecruiterEmail — multipart POST to RMHR internal lock endpoint.
 *
 * Builds a FormData body (file Blob + recruiterEmail + resumeSourceId),
 * authenticates with X-Internal-Api-Key header, respects AbortSignal.timeout,
 * logs via logApiCall (best-effort), and parses the two-layer response.
 */
export async function uploadByRecruiterEmail(
  args: {
    file: Buffer;
    filename: string;
    recruiterEmail: string;
    resumeSourceId: string;
  },
  opts?: { logger?: any },
): Promise<LockSnapshot> {
  const { host, apiKey, timeoutMs } = rmhrConfig();

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(args.file)], { type: 'application/pdf' }),
    args.filename,
  );
  form.append('recruiterEmail', args.recruiterEmail);
  form.append('resumeSourceId', args.resumeSourceId);

  // RMHR_INTERNAL_HOST is the FULL gateway URL, including the
  // `?module=rmhr_internal&httpMethod=post&method=/internal/uploadByRecruiterEmail`
  // query string (per the RMHR v1.2 contract). POST to it verbatim.
  const url = host;
  const requestSummary = {
    filename: args.filename,
    pdf_bytes: args.file.length,
    recruiterEmail: args.recruiterEmail,
    resumeSourceId: args.resumeSourceId,
  };

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Internal-Api-Key': apiKey,
      },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    // Best-effort log — never blocks the error throw
    try {
      logApiCall({
        category: 'rmhr',
        label: 'RMHR.uploadByRecruiterEmail',
        url,
        method: 'POST',
        duration_ms: durationMs,
        request: requestSummary,
        error: (err as Error).message,
      });
    } catch {
      // swallow logging errors
    }
    try {
      opts?.logger?.apiCall?.('RMHR.uploadByRecruiterEmail', {
        url,
        method: 'POST',
        request: requestSummary,
        durationMs,
        error: (err as Error).message,
      });
    } catch {
      // swallow
    }
    throw new RmhrApiError(
      'NETWORK',
      `RMHR uploadByRecruiterEmail fetch failed: ${(err as Error).message}`,
    );
  }

  const durationMs = Date.now() - start;
  const status = res.status;

  // Capture body for logging (clone so we can still parse below)
  const cloned = res.clone();
  let responseBody: unknown = null;
  try {
    responseBody = await cloned.json();
  } catch {
    try {
      responseBody = await cloned.text();
    } catch {
      responseBody = null;
    }
  }

  // Best-effort log
  try {
    logApiCall({
      category: 'rmhr',
      label: 'RMHR.uploadByRecruiterEmail',
      url,
      method: 'POST',
      status,
      duration_ms: durationMs,
      request: requestSummary,
      response: responseBody,
    });
  } catch {
    // swallow
  }
  try {
    opts?.logger?.apiCall?.('RMHR.uploadByRecruiterEmail', {
      url,
      method: 'POST',
      request: requestSummary,
      status,
      durationMs,
      response: responseBody,
    });
  } catch {
    // swallow
  }

  if (!res.ok) {
    const code = statusToCode(status);
    throw new RmhrApiError(
      code,
      `RMHR ${status} ${res.statusText}`,
      status,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new RmhrApiError('SERVER', 'RMHR response body is not valid JSON', status);
  }

  return parseRmhrResponse(json);
}
