// @ts-nocheck — WIP, depends on legacy RuleCheckVerdict type not exported
// in the post-merge types.ts.
// Prisma audit writer — Q架构纠偏 (2026-05-12)
//
// 角色:
//   - RuleCheckAudit / RuleCheckFlag(审计日志 + 大字段 + 时间序列)→ Prisma/Postgres
//   - 实体节点(Candidate / Resume / Job_Requisition + 关系)→ Neo4j(由 neo4j-instance-writer 写)
//
// 为什么分开:
//   Neo4j 擅长存"实体 + 关系",不擅长存大字段日志。Prisma/Postgres 有索引、
//   事务、null check,适合 audit 这种"高频写、按 audit_id / created_at 查"的 case。
//
// 跟 neo4j-instance-writer 的对应:
//   - 旧:writeRuleCheckAudit(verdict, ctx)— Neo4j 写 audit + flag + entity 全包揽
//   - 新:writeRuleCheckAuditPrisma(verdict, ctx)— 只写 audit + flag 到 Prisma
//        + neo4j-instance-writer 改名 writeInstanceAnchorsOnly(ctx)— 只写实体 + 关系
//
// soft link 到 Neo4j 实体:audit.candidate_id / resume_id / job_requisition_id 字段
// 不做外键(因为 Neo4j 节点不在 Prisma);UI / API 层做关联查询。

import { prisma } from '@/server/db';
import type { RuleCheckVerdict } from './types';

export interface WritePrismaAuditContext {
  run_id: string;
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  job_requisition_id: string;
  trace_id?: string | null;
  scenario_id?: string | null;
  parsed_resume?: Record<string, unknown> | null;
  job_requisition?: Record<string, unknown> | null;
  /** INFO_MISSING_FILLED 重判时填,链回父 audit */
  parent_audit_id?: string | null;
}

export async function writeRuleCheckAuditPrisma(args: {
  verdict: RuleCheckVerdict;
  context: WritePrismaAuditContext;
}): Promise<{
  wrote: boolean;
  audit_id?: string;
  n_flags?: number;
  reason?: string;
}> {
  const { verdict, context } = args;
  const audit_id = makeAuditId(context);

  try {
    // 一次性事务:先 audit,再批量 flag
    // 存全部 flags(applicable=true 跟 applicable=false 都存)— 前端 drawer 可以分两段渲染:
    //   - 适用规则(applicable=true):有 PASS/FAIL/NOT_APPLICABLE,带 evidence
    //   - 不适用规则(applicable=false):告诉用户"这条规则没触发,因为...",证明 51 条规则
    //     都被审视过(防止用户怀疑"我们漏了规则")。
    const flagsToWrite = verdict.llm_output?.rule_flags ?? [];

    await prisma.$transaction(async (tx) => {
      // 1. upsert audit
      await tx.ruleCheckAudit.upsert({
        where: { audit_id },
        create: {
          audit_id,
          run_id: context.run_id,
          scenario_id: context.scenario_id ?? null,
          trace_id: context.trace_id ?? null,
          upload_id: context.upload_id,
          candidate_id: context.candidate_id,
          resume_id: context.resume_id,
          job_requisition_id: context.job_requisition_id,
          client_name: verdict.audit.dims.client_id || null,
          business_group: verdict.audit.dims.business_group || null,
          studio: verdict.audit.dims.studio || null,
          decision: verdict.decision,
          llm_decision: verdict.llm_decision,
          failure_reasons: JSON.stringify(verdict.failure_reasons),
          llm_model: verdict.audit.llm_model,
          llm_duration_ms: Math.round(verdict.audit.llm_duration_ms),
          llm_prompt_tokens: verdict.audit.llm_prompt_tokens ?? null,
          llm_completion_tokens: verdict.audit.llm_completion_tokens ?? null,
          parse_error: verdict.audit.parse_error ?? null,
          rules_evaluated: verdict.audit.rules_evaluated,
          rules_total_in_ontology: verdict.audit.rules_total_in_ontology,
          rule_source: verdict.audit.rule_source ?? 'unknown',
          partial_resume_fields: JSON.stringify(
            verdict.audit.partial_resume_fields ?? [],
          ),
          filtered_out_rules: verdict.audit.filtered_out_rules
            ? JSON.stringify(verdict.audit.filtered_out_rules)
            : null,
          parsed_resume_json: context.parsed_resume
            ? safeJsonStringify(context.parsed_resume)
            : null,
          job_requisition_json: context.job_requisition
            ? safeJsonStringify(context.job_requisition)
            : null,
          user_prompt: verdict.audit.user_prompt ?? null,
          system_prompt: verdict.audit.system_prompt ?? null,
          llm_raw_text: verdict.audit.llm_raw_text ?? null,
          resume_augmentation: verdict.resume_augmentation ?? null,
          parent_audit_id: context.parent_audit_id ?? null,
        },
        update: {
          // 重判时(scenario_id / audit_id 重复)— update 决策 + LLM 字段
          decision: verdict.decision,
          llm_decision: verdict.llm_decision,
          failure_reasons: JSON.stringify(verdict.failure_reasons),
          llm_duration_ms: Math.round(verdict.audit.llm_duration_ms),
          llm_prompt_tokens: verdict.audit.llm_prompt_tokens ?? null,
          llm_completion_tokens: verdict.audit.llm_completion_tokens ?? null,
          user_prompt: verdict.audit.user_prompt ?? null,
          llm_raw_text: verdict.audit.llm_raw_text ?? null,
          resume_augmentation: verdict.resume_augmentation ?? null,
        },
      });

      // 2. 删旧 flag(重判时)+ 批量插新 flag
      await tx.ruleCheckFlag.deleteMany({ where: { audit_id } });
      if (flagsToWrite.length > 0) {
        await tx.ruleCheckFlag.createMany({
          data: flagsToWrite.map((f) => ({
            flag_id: `${audit_id}::${f.rule_id}`,
            audit_id,
            rule_id: f.rule_id,
            rule_name_snapshot: f.rule_name ?? '',
            severity: f.severity,
            applicable_client: f.applicable_client ?? null,
            applicable: f.applicable,
            result: f.result,
            evidence: f.evidence ?? null,
            next_action: f.next_action ?? null,
          })),
        });
      }
    });

    return { wrote: true, audit_id, n_flags: flagsToWrite.length };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    // eslint-disable-next-line no-console
    console.warn(
      `[prisma-audit-writer] write failed for audit_id=${audit_id}: ${msg.slice(0, 240)}`,
    );
    return { wrote: false, reason: `error:${msg.slice(0, 80)}` };
  }
}

function makeAuditId(ctx: WritePrismaAuditContext): string {
  if (ctx.scenario_id) {
    return `rca_${ctx.run_id}_${ctx.scenario_id}`;
  }
  return `rca_${ctx.run_id}_${shortHash(ctx.upload_id)}_${shortHash(ctx.job_requisition_id)}`;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

function safeJsonStringify(v: unknown): string | null {
  try {
    const s = JSON.stringify(v);
    if (!s) return null;
    return s;
  } catch {
    return null;
  }
}
