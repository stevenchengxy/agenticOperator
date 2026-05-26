// Function ① — 订阅 RESUME_DOWNLOADED → download PDF → parse → 持久化 → 发 RESUME_PROCESSED
//
// 流程 (per agentic-operator-onboarding v7 §4.8 + ADR-0011 边界):
//   1. RESUME_DOWNLOADED 事件 payload 只带 transport 元数据
//      (upload_id / bucket / object_key / etag / filename / operator_*).
//      raas **不**预先 parse — parse 是 agent 的职责.
//   2. agent → GET /api/v1/resumes/uploads/<upload_id>/raw  (PDF bytes, RAAS MinIO)
//   3. agent → POST {RoboHire}/api/v1/parse-resume   (multipart — 直连 RoboHire, 不走 RAAS proxy)
//   4. agent → POST /api/v1/candidates     (parsed + transport context, 仍走 RAAS, 写 Postgres)
//   5. raas 自动按规则发 RESUME_PROCESSED 给下游 matcher (我们这边
//      也 emit 一份做 dual-track 兜底 — RAAS 那边某些路径还没接 emit).
//
// Backward compat: 如果事件 payload 已经带 parsed.data (legacy 内部
// 路径或 partner 在 emit 前预 parse 过), 直接用事件里的 parsed,
// 跳过 step 2-3.
//
// etag 兜底: 事件里的 etag 可能是 null (RAAS 手动上传链路目前没填),
// agent 在拿到 PDF 字节后用 MD5 算一个本地 etag 作为 saveCandidate
// 的 dedup key.

import { createHash } from 'node:crypto';
import { NonRetriableError } from 'inngest';
import { getResumeBuffer, statResume } from '@/lib/minio';
import {
  saveCandidateToPartnerPg,
  markResumeUploadFailed,
  type SaveCandidateInput,
} from '@/lib/partner-pg/candidates';
import { isPartnerPgConfigured } from '@/lib/partner-pg/client';
import {
  writeCandidateInstance,
  writeResumeInstance,
} from '@/lib/allmeta-writers';
import { parseResumeDirect, RobohireApiError } from '@/lib/robohire-client';
import { inngest, type ResumeProcessedData } from '@/server/inngest/client';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import { prisma } from '@/server/db';

// Local alias mirroring the RoboHire parse-resume `data` shape that we
// historically imported from raas-api-client.ts. After the 2026-05-20
// direct-write migration we use partner-pg + direct RoboHire, so this is
// just a structural alias.
type RaasParseResumeData = Record<string, unknown> & { name?: string | null };

export const resumeParserAgent = inngest.createFunction(
  {
    id: 'resume-parser-agent',
    name: 'Resume Parser Agent',
    retries: 0, // RAAS API 失败不自动重试，避免重复扣配额 / 重写 DB
    triggers: [{ event: 'RESUME_DOWNLOADED' }],
  },
  async ({ event, step, logger, runId }) => {
    // RESUME_DOWNLOADED 兼容两种 shape:
    //   A) RAAS canonical envelope —
    //      { entity_id, entity_type, event_id, payload: { ... }, trace }
    //   B) Flat (legacy / publish-test) —
    //      { upload_id, bucket, object_key, parsed, ... }
    const raw = unwrapDownloadedEnvelope(event.data);
    const fileLogger = createAgentLogger({
      agent: 'resumeParser',
      runId: runId ?? `local-${Date.now()}`,
      traceId: getTraceId(event.data) ?? null,
      anchors: {
        upload_id: typeof raw.upload_id === 'string' ? raw.upload_id : undefined,
        bucket: typeof raw.bucket === 'string' ? raw.bucket : undefined,
        object_key: typeof raw.object_key === 'string' ? raw.object_key : undefined,
      },
    });
    return runWithLogger(fileLogger, async () => {
    fileLogger.event('handler.start', {
      event_name: event.name,
      upload_id: raw.upload_id ?? raw.uploadId,
      bucket: raw.bucket,
      object_key: raw.object_key ?? raw.objectKey,
      filename: raw.filename,
      employee_id: raw.employee_id ?? raw.employeeId ?? raw.operator_employee_id ?? null,
      client_id: raw.client_id ?? null,
      job_requisition_id: raw.job_requisition_id ?? null,
      sourcing_channel_id: raw.sourcing_channel_id ?? raw.sourcingChannelId ?? null,
      hr_folder: raw.hr_folder ?? raw.hrFolder ?? null,
      // Echo the raw event keys so missing fields are diagnosable from logs alone.
      _raw_keys: Object.keys(raw).sort(),
    });

    // 2026-05-26 — STEP 1 完整入参: RAAS → AO 原始 event envelope (RESUME_DOWNLOADED).
    fileLogger.event('handler.raw_input', {
      from: 'RAAS',
      to: 'AO.resumeParser',
      event_name: event.name,
      raw_event_data: event.data,
    });

    // ── 提取 anchor 字段 ──
    const upload_id = raw.upload_id ?? raw.uploadId;
    const bucket = raw.bucket;
    const object_key = raw.object_key ?? raw.objectKey;
    const eventEtag = raw.etag ?? null; // 可能是 null (RAAS 手动上传链路没填)
    const filename = raw.filename;
    const employeeId = raw.employee_id ?? raw.employeeId ?? raw.operator_employee_id ?? null;
    const operator_id = raw.operator_id ?? null;
    const client_id = raw.client_id ?? null;
    const job_requisition_id = raw.job_requisition_id ?? null;
    const mime_type = raw.mime_type ?? raw.contentType ?? 'application/pdf';
    const file_size = raw.size ?? raw.file_size ?? null;
    // RAAS publishes sourcing_channel_id on RESUME_DOWNLOADED — pass it through
    // to partner Postgres so candidate.sourcing_channel_id reflects which
    // channel (BOSS直聘 / 猎聘 / LinkedIn / 人才库-AI / …) sourced the resume.
    // Accept both snake- and camelCase variants for forward compat.
    const sourcing_channel_id =
      typeof raw.sourcing_channel_id === 'string' && raw.sourcing_channel_id.trim()
        ? raw.sourcing_channel_id.trim()
        : typeof raw.sourcingChannelId === 'string' && raw.sourcingChannelId.trim()
          ? raw.sourcingChannelId.trim()
          : null;
    const traceId = getTraceId(event.data);

    if (!upload_id) {
      throw new NonRetriableError(
        `RESUME_DOWNLOADED missing upload_id — cannot anchor saveCandidate. data keys=${Object.keys(raw).join(',')}`,
      );
    }
    if (!bucket || !object_key) {
      throw new NonRetriableError(
        `RESUME_DOWNLOADED missing bucket/object_key — partner-pg saveCandidate 需要这两个字段做 Resume 去重`,
      );
    }
    if (!isPartnerPgConfigured()) {
      throw new NonRetriableError(
        `[resume-persist] RAAS_POSTGRES_URL env 未配置`,
      );
    }

    logger.info(
      `[resume-persist] received RESUME_DOWNLOADED · upload_id=${upload_id} ` +
        `bucket=${bucket} object_key=${object_key} filename=${filename ?? '—'} ` +
        `etag=${eventEtag ?? 'null'}`,
    );

    // ── 读取 parsed.data (legacy 路径: 事件 payload 已带 parsed) ──
    const parsedFromEvent = pickParsedData(raw);

    // ── 取 parsed + etag, 两条路径择一 ──
    let parsed: RaasParseResumeData;
    let robohireRequestId: string | undefined;
    let computedEtag: string | undefined;

    if (parsedFromEvent) {
      // Legacy: 事件已带 parsed.data, 跳过 download + parse.
      parsed = parsedFromEvent;
      logger.info(
        `[resume-persist] legacy path · 事件已带 parsed.data, 跳过 download+parse · ` +
          `name="${parsed.name ?? '?'}"`,
      );
    } else {
      // v7 §4.8 标准路径: 自己拉 PDF 字节 + 自己 parse.
      const stepKey = sanitize(String(upload_id));
      const downloadAndParse = await step.run(`download-and-parse-${stepKey}`, async () => {
        // 1) 直连 MinIO 下载 PDF 字节 (2026-05-20: 不再走 RAAS proxy)
        let pdfBuffer: Buffer;
        let minioContentType: string | null = null;
        try {
          pdfBuffer = await getResumeBuffer(String(bucket), String(object_key));
          try {
            const stat = await statResume(String(bucket), String(object_key));
            minioContentType = stat.contentType;
          } catch {
            // stat failure is non-fatal; we have the bytes
          }
        } catch (e) {
          // MinIO 404 / NoSuchKey → 不重试 (object 不存在,重试没意义)
          const msg = e instanceof Error ? e.message : String(e);
          if (/NoSuchKey|NotFound|404/i.test(msg)) {
            throw new NonRetriableError(
              `MinIO ${bucket}/${object_key} not found: ${msg}`,
            );
          }
          throw e;
        }
        logger.info(
          `[resume-persist] downloaded PDF from MinIO · upload_id=${upload_id} ` +
            `bytes=${pdfBuffer.length} content-type=${minioContentType ?? '—'} ` +
            `filename="${filename ?? '—'}"`,
        );

        // 2) POST /api/v1/parse-resume (multipart) — 直连 RoboHire
        const pdfFilename = (filename as string | undefined) ?? 'resume.pdf';
        let parseRes;
        try {
          parseRes = await parseResumeDirect(pdfBuffer, pdfFilename, { traceId });
        } catch (e) {
          if (e instanceof RobohireApiError && e.isClientError) {
            throw new NonRetriableError(
              `RoboHire POST /parse-resume 4xx: ${e.httpStatus} ${e.code} ${e.message}`,
            );
          }
          throw e;
        }
        logger.info(
          `[resume-persist] RoboHire parse-resume OK · cached=${parseRes.cached} ` +
            `name="${parseRes.data?.name ?? '?'}" requestId=${parseRes.requestId}`,
        );

        // 3) 算 MD5 etag 作为 saveCandidate dedup 兜底.
        //    返回 primitive 给下个 step (Buffer 不能跨 step.run 序列化).
        const md5 = createHash('md5').update(pdfBuffer).digest('hex');

        return {
          // RobohireParseResumeData 与 RaasParseResumeData 形状 1:1 (RAAS 是
          // RoboHire 的 proxy), 但二者 TypeScript 类型不同源 — 这里 cast 一次,
          // 让下游 saveCandidate(SaveCandidateInput.parsed) 类型对齐.
          parsed: parseRes.data as unknown as RaasParseResumeData,
          robohire_request_id: parseRes.requestId,
          computed_etag: md5,
          cached: parseRes.cached,
        };
      });
      parsed = downloadAndParse.parsed;
      robohireRequestId = downloadAndParse.robohire_request_id;
      computedEtag = downloadAndParse.computed_etag;
    }

    // 最终 etag: 事件里的 (string) > 我们算的 MD5 > undefined
    const finalEtag =
      typeof eventEtag === 'string' && eventEtag.trim() ? eventEtag.trim() : computedEtag;

    // ── 直写 Partner Postgres (2026-05-20: 不再走 RAAS API) ──
    const saveResult = await step.run('save-candidate', async () => {
      const input: SaveCandidateInput = {
        upload_id: String(upload_id),
        bucket: String(bucket),
        object_key: String(object_key),
        etag: finalEtag,
        size: typeof file_size === 'number' ? file_size : null,
        filename: filename ?? undefined,
        employee_id: employeeId ?? undefined,
        client_id: client_id ?? undefined,
        job_requisition_id: job_requisition_id ?? undefined,
        sourcing_channel_id: sourcing_channel_id ?? undefined,
        parsed: { data: parsed as Record<string, unknown> },
      };

      try {
        const r = await saveCandidateToPartnerPg(input);
        logger.info(
          `[resume-persist] ✅ partner-pg saveCandidate OK · candidate_id=${r.candidate_id} ` +
            `resume_id=${r.resume_id} application_id=${r.application_id ?? '—'} ` +
            `candidate_created=${r.candidate_created} resume_created=${r.resume_created}`,
        );
        fileLogger.event('save-candidate.ok', {
          from: 'AO.resumeParser',
          to: '候选人数据库',
          upload_id,
          candidate_id: r.candidate_id,
          resume_id: r.resume_id,
          application_id: r.application_id,
          candidate_created: r.candidate_created,
          resume_created: r.resume_created,
          full_input_to_save: input,        // 完整传给 saveCandidateToPartnerPg 的入参
          full_robohire_parsed: parsed,     // 完整 RoboHire parse-resume 输出
        });
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Mark the upload as failed in partner's state-machine table so RAAS
        // sees a terminal error instead of an indefinite 'pending'. Non-fatal
        // — if this write itself fails, swallow and re-throw the original.
        try {
          await markResumeUploadFailed(String(upload_id), msg);
        } catch (markErr) {
          logger.warn(
            `[resume-persist] markResumeUploadFailed failed: ${(markErr as Error).message}`,
          );
        }
        fileLogger.event('save-candidate.failed', { upload_id, error: msg });
        throw e;
      }
    });

    // ── 5b. 写 Neo4j Candidate + Resume + Application instances via allmeta ──
    const stepKeyForNeo4j = sanitize(String(upload_id));
    await step.run(`write-candidate-neo4j-${stepKeyForNeo4j}`, async () => {
      const r = await writeCandidateInstance({
        candidate_id: saveResult.candidate_id,
        employee_id: employeeId,
        parsed: parsed as unknown as Record<string, unknown>,
      });
      if (r.ok) {
        logger.info(`[resume-persist] ✓ allmeta wrote Candidate ${saveResult.candidate_id}`);
        if (r.nameWasPlaceholder) {
          logger.warn(
            `[resume-persist] name parse miss → fallback '未命名候选人' candidate_id=${saveResult.candidate_id} parsed_name_raw=${JSON.stringify(r.parsedNameRaw)}`,
          );
          // Fire-and-forget observability event — never break the agent run
          prisma.agentActivity.create({
            data: {
              runId: runId ?? null,
              nodeId: '9-1',
              agentName: 'ResumeParser',
              type: 'warn',
              narrative: `候选人名字解析失败 → fallback '未命名候选人' (candidate_id=${saveResult.candidate_id})`,
              metadata: JSON.stringify({
                kind: 'name_parse_miss',
                candidate_id: saveResult.candidate_id,
                parsed_name_raw: r.parsedNameRaw,
              }),
            },
          }).catch(() => { /* never break the agent run on observability */ });
        }
      } else {
        logger.warn(`[resume-persist] allmeta Candidate write failed: ${r.error}`);
      }
      return r;
    });
    await step.run(`write-resume-neo4j-${stepKeyForNeo4j}`, async () => {
      const r = await writeResumeInstance({
        resume_id: saveResult.resume_id,
        candidate_id: saveResult.candidate_id,
        job_requisition_id: job_requisition_id ?? null,
        employee_id: employeeId,
        file_path: object_key,
        parsed: parsed as unknown as Record<string, unknown>,
      });
      if (r.ok) logger.info(`[resume-persist] ✓ allmeta wrote Resume ${saveResult.resume_id}`);
      else logger.warn(`[resume-persist] allmeta Resume write failed: ${r.error}`);
      return r;
    });
    // Application instance write removed (2026-05-21) — RAAS owns Application
    // creation in both partner Postgres and ontology Neo4j now. AO's role is
    // only to surface application_id in downstream events when it's already
    // there; we never mint or write Application rows.

    // ── emit RESUME_PROCESSED 触发下游 matcher ──
    // Note: 在 v7 §4.8 下,RAAS 自己在 saveCandidate 后也会按规则发
    // RESUME_PROCESSED 给下游 matching 流程. 我们这里 dual-track 也
    // emit 一份做兜底 — 因为 partner 那边的 auto-emit 不一定全路径覆盖.
    // 等 partner 那边稳定后可以去掉这个 emit (TODO @ partner verify).
    const processedPayload: ResumeProcessedData = {
      // 透传 transport 字段供下游使用
      bucket,
      objectKey: object_key,
      filename: (filename ?? 'resume.pdf').trim(),
      hrFolder: raw.hr_folder ?? raw.hrFolder ?? null,
      employeeId,
      etag: finalEtag ?? null,
      size: typeof file_size === 'number' ? file_size : null,
      sourceEventName: raw.source_event_name ?? raw.sourceEventName ?? null,
      receivedAt: raw.received_at ?? raw.receivedAt ?? new Date().toISOString(),
      // 给 matcher 用的 anchor
      upload_id,
      employee_id: employeeId ?? undefined,
      // parsed.data 透传 (matcher 仍可以用作 resume text 来源)
      parsed: { data: parsed as unknown as Record<string, unknown> },
      // 持久化的产物 — 让下游知道 candidate_id 已经存在
      candidate_id: saveResult.candidate_id,
      resume_id: saveResult.resume_id,
      // 透传上传时关联的岗位 — matchResumeAgent 据此决定"单岗位精准匹配"
      // 还是"上传者名下全部 recruiting 岗位扫描"。
      job_requisition_id: job_requisition_id ?? null,
      // 透传 RAAS 上游传来的 sourcing_channel_id / client_id,partner / 重新订阅方都需要
      sourcing_channel_id: sourcing_channel_id ?? null,
      client_id: client_id ?? null,
      // 老的 4 对象嵌套字段保留为空 (RAAS 不再要求 agent 转结构)
      candidate: {} as ResumeProcessedData['candidate'],
      candidate_expectation: {} as ResumeProcessedData['candidate_expectation'],
      resume: {} as ResumeProcessedData['resume'],
      runtime: {} as ResumeProcessedData['runtime'],
      parsedAt: new Date().toISOString(),
      parserVersion: 'v7-pull-model@2026-05-08',
    };

    // 2026-05-21: explicit upload_id pass-through audit so logs prove every
    // RESUME_PROCESSED emit carries upload_id (partner / RAAS subscribers
    // anchor on this field).
    fileLogger.event('emit.resume-processed', {
      from: 'AO.resumeParser',
      to: 'AO.ruleCheck + RAAS (Inngest event RESUME_PROCESSED)',
      upload_id,
      candidate_id: saveResult.candidate_id,
      resume_id: saveResult.resume_id,
      application_id: saveResult.application_id,
      job_requisition_id: job_requisition_id ?? null,
      sourcing_channel_id: sourcing_channel_id ?? null,
      client_id: client_id ?? null,
      filename: (filename ?? 'resume.pdf').trim(),
      bucket,
      object_key,
      full_payload: processedPayload,    // 完整 emit payload (含 parsed.data, snapshot 等)
    });
    await step.sendEvent('emit-resume-processed', {
      name: 'RESUME_PROCESSED',
      data: processedPayload,
    });

    logger.info(
      `[resume-persist] ✅ emitted RESUME_PROCESSED · upload_id=${upload_id} ` +
        `candidate_id=${saveResult.candidate_id}`,
    );
    fileLogger.event('handler.done', {
      from: 'AO.resumeParser',
      to: '(handler return)',
      upload_id,
      candidate_id: saveResult.candidate_id,
      resume_id: saveResult.resume_id,
      application_id: saveResult.application_id,
      is_new_candidate: saveResult.candidate_created,
      is_new_resume: saveResult.resume_created,
      robohire_request_id: robohireRequestId,
    });

    return {
      ok: true,
      upload_id,
      candidate_id: saveResult.candidate_id,
      candidate_name: parsed.name ?? null,
      resume_id: saveResult.resume_id,
      application_id: saveResult.application_id,
      is_new_candidate: saveResult.candidate_created,
      is_new_resume: saveResult.resume_created,
    };
    }); // runWithLogger
  },
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Unwrap RAAS-canonical envelope shape to flat fields.
 *
 * Envelope: { entity_id, entity_type, event_id, payload: {...}, trace }
 * Flat:     { bucket, objectKey, ... }
 */
function unwrapDownloadedEnvelope(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, any>;
  if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) {
    return {
      ...(r.payload as Record<string, any>),
      _envelope_entity_id: r.entity_id,
      _envelope_entity_type: r.entity_type,
      _envelope_event_id: r.event_id,
      _envelope_trace: r.trace,
    };
  }
  return r;
}

/**
 * 多种 shape 兼容地提取 RoboHire parsed.data:
 *   A) raw.parsed.data         — 标准 (RoboHire data spread under .parsed)
 *   B) raw.parsed              — RoboHire data 直接放在 .parsed
 *   C) raw.parsed_data         — snake_case 变体
 *   D) raw.parser.data         — 偶发的 .parser 包装
 */
function pickParsedData(raw: Record<string, any>): RaasParseResumeData | null {
  if (raw.parsed && typeof raw.parsed === 'object') {
    if (raw.parsed.data && typeof raw.parsed.data === 'object') {
      return raw.parsed.data as RaasParseResumeData;
    }
    // 直接是 parsed object 本身
    if (typeof raw.parsed.name === 'string' || Array.isArray(raw.parsed.experience)) {
      return raw.parsed as RaasParseResumeData;
    }
  }
  if (raw.parsed_data && typeof raw.parsed_data === 'object') {
    return raw.parsed_data as RaasParseResumeData;
  }
  if (raw.parser && typeof raw.parser === 'object' && raw.parser.data) {
    return raw.parser.data as RaasParseResumeData;
  }
  return null;
}

/** 提取 trace_id 给 RAAS API X-Trace-Id header 用 */
function getTraceId(eventData: unknown): string | undefined {
  if (!eventData || typeof eventData !== 'object') return undefined;
  const r = eventData as Record<string, any>;
  const t = r.trace;
  if (t && typeof t === 'object' && typeof t.trace_id === 'string' && t.trace_id) {
    return t.trace_id;
  }
  return undefined;
}

/**
 * 给 step.run 用的 step key sanitizer — Inngest step key 只能是
 * [A-Za-z0-9-_], 上传 id 里的 UUID 自带连字符没问题, 但兜底兼容.
 */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'unknown';
}
