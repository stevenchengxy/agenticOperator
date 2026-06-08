// POST /api/rule-check-audits/[auditId]/verify
//
// Runs a SECOND, independent LLM to cross-check a rule-check audit's rule
// selection + per-rule verdicts, and returns a multi-dimensional confidence
// score. Pure-LLM: no heuristic fallback — if the gateway isn't configured we
// say so honestly rather than fabricating a verdict.
//
// On-demand only (the drawer fires this when the reviewer clicks 运行交叉验证).

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { chatComplete, isGatewayConfigured } from '@/server/llm/gateway';
import {
  extractRawFlagsByRuleId,
  mergeFlagsWithRawFallback,
  type RuleCheckFlagRow,
} from '@/app/api/rule-check-audits/[auditId]/route';
import {
  composeVerifyPrompt,
  parseVerification,
  pickVerifierModel,
  VERIFY_SYSTEM_PROMPT,
  VerificationParseError,
  type RuleSelectionVerification,
  type VerifyFlag,
} from '@/lib/rule-check/verify-prompt';
import { ontologyAuditDetail } from '@/lib/rule-check/ontology-audit-source';
import {
  composeEnergyVerifyPrompt,
  ENERGY_VERIFY_SYSTEM_PROMPT,
} from '@/lib/rule-check/energy-verify-prompt';

export const dynamic = 'force-dynamic';

export type RuleCheckVerifyResponse =
  | {
      ok: true;
      verification: RuleSelectionVerification;
      primary_model: string;
      verifier_model: string;
      duration_ms: number;
      prompt_tokens?: number;
      completion_tokens?: number;
    }
  | {
      ok: false;
      // 'not_applicable' = a deterministic (non-LLM) rule-check audit, e.g. the
      // energy validateConstraints/triageScheme agents — there is no primary-LLM
      // judgment to cross-validate, so the second-opinion panel is N/A, not an error.
      reason: 'not_found' | 'gateway_unavailable' | 'parse_error' | 'llm_error' | 'error' | 'not_applicable';
      error?: string;
    };

function parseJsonObject(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseArray<T>(v: string | null): T[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ auditId: string }> },
) {
  const { auditId } = await ctx.params;

  // Non-recruitment audits live in OntologyRuleCheck and are produced by
  // DETERMINISTIC rule-check agents (energy validateConstraints / triageScheme /
  // …). The numeric judgment stays AUTHORITATIVE — here we run a SECOND,
  // independent LLM purely as an ADVISORY cross-check of the rule selection +
  // per-rule verdicts (it never overrides the deterministic decision). Handled
  // BEFORE the recruitment lookup (which would otherwise 404). NOTE: this path
  // is energy/ontology-only and is deliberately separate from the recruitment
  // rule-check agent — different store (OntologyRuleCheck), different prompt.
  const ontoDetail = await ontologyAuditDetail(auditId).catch(() => null);
  if (ontoDetail) {
    if (!isGatewayConfigured()) {
      return NextResponse.json<RuleCheckVerifyResponse>({
        ok: false,
        reason: 'gateway_unavailable',
      });
    }
    const energyFlags: VerifyFlag[] = ontoDetail.flags.map((f) => ({
      rule_id: f.rule_id,
      rule_name_snapshot: f.rule_name_snapshot,
      severity: f.severity,
      applicable: f.applicable,
      result: f.result,
      evidence: f.evidence ?? '',
      next_action: f.next_action ?? '',
    }));
    if (energyFlags.length === 0) {
      // No evaluated rules → nothing to cross-check.
      return NextResponse.json<RuleCheckVerifyResponse>({ ok: false, reason: 'not_applicable' });
    }
    const redline =
      ontoDetail.llm_decision === 'VIOLATED' ||
      ontoDetail.llm_decision === 'RISK-FIRST' ||
      energyFlags.some((f) => f.severity === 'terminal' && f.result === 'FAIL');
    const userPrompt = composeEnergyVerifyPrompt({
      stage: ontoDetail.client_name,
      domain: ontoDetail.business_group ?? '',
      decision: ontoDetail.llm_decision,
      dsNo: ontoDetail.job_requisition_id,
      redline,
      selection: ontoDetail.selection,
      flags: energyFlags,
      failure_reasons: ontoDetail.failure_reasons,
    });
    const energyVerifierModel = pickVerifierModel('');
    let energyLlm;
    try {
      energyLlm = await chatComplete({
        system: ENERGY_VERIFY_SYSTEM_PROMPT,
        user: userPrompt,
        model: energyVerifierModel,
        maxTokens: 12000,
        toolName: 'RuleCheck.energyVerify',
      });
    } catch (e) {
      return NextResponse.json<RuleCheckVerifyResponse>({
        ok: false,
        reason: 'llm_error',
        error: (e as Error).message.slice(0, 300),
      });
    }
    let energyVerification: RuleSelectionVerification;
    try {
      energyVerification = parseVerification(energyLlm.text, energyFlags);
    } catch (e) {
      if (e instanceof VerificationParseError) {
        return NextResponse.json<RuleCheckVerifyResponse>({
          ok: false,
          reason: 'parse_error',
          error: e.message.slice(0, 300),
        });
      }
      throw e;
    }
    return NextResponse.json<RuleCheckVerifyResponse>({
      ok: true,
      verification: energyVerification,
      primary_model: '确定性规则引擎',
      verifier_model: energyLlm.modelUsed,
      duration_ms: energyLlm.durationMs,
      prompt_tokens: energyLlm.usage?.promptTokens,
      completion_tokens: energyLlm.usage?.completionTokens,
    });
  }

  if (!isGatewayConfigured()) {
    return NextResponse.json<RuleCheckVerifyResponse>({
      ok: false,
      reason: 'gateway_unavailable',
    });
  }

  try {
    const audit = await prisma.ruleCheckAudit.findUnique({
      where: { audit_id: auditId },
      include: { flags: true },
    });
    if (!audit) {
      return NextResponse.json<RuleCheckVerifyResponse>({ ok: false, reason: 'not_found' });
    }

    // Same flag resolution as the detail route: the RuleCheckFlag table is
    // often empty (early writer dropped rows), so recover the full evaluation
    // set from llm_raw_text. Without this the verifier sees 0 rules and
    // wrongly concludes "nothing was evaluated".
    const dbFlags: RuleCheckFlagRow[] = audit.flags.map((f) => ({
      flag_id: f.flag_id,
      rule_id: f.rule_id,
      rule_name_snapshot: f.rule_name_snapshot,
      severity: f.severity,
      applicable: f.applicable,
      result: f.result,
      evidence: f.evidence ?? '',
      next_action: f.next_action ?? '',
    }));
    const merged = mergeFlagsWithRawFallback(
      dbFlags,
      extractRawFlagsByRuleId(audit.llm_raw_text),
      audit.audit_id,
    );
    const flags: VerifyFlag[] = merged.map((f) => ({
      rule_id: f.rule_id,
      rule_name_snapshot: f.rule_name_snapshot,
      severity: f.severity,
      applicable: f.applicable,
      result: f.result,
      evidence: f.evidence ?? '',
      next_action: f.next_action ?? '',
    }));

    const userPrompt = composeVerifyPrompt({
      decision: audit.decision,
      failure_reasons: parseArray<string>(audit.failure_reasons),
      client_name: audit.client_name ?? '',
      business_group: audit.business_group,
      user_prompt: audit.user_prompt,
      resume: parseJsonObject(audit.parsed_resume_json),
      jr: parseJsonObject(audit.job_requisition_json),
      flags,
      rule_provenance: parseArray<{
        rule_id: string;
        tier: string;
        included: boolean;
        reason: string;
      }>(audit.rule_provenance),
      filtered_out_rules: parseArray<{
        rule_id: string;
        rule_name: string;
        applicable_client: string;
        applicable_department: string;
        executor: string;
        reason: string;
      }>(audit.filtered_out_rules),
    });

    const verifierModel = pickVerifierModel(audit.llm_model);

    let llm;
    try {
      llm = await chatComplete({
        system: VERIFY_SYSTEM_PROMPT,
        user: userPrompt,
        model: verifierModel,
        // No explicit temperature: gpt-5.x verifier requires temperature=1, and
        // the gateway auto-picks that when temperature is omitted (passing 0.2
        // would be rejected). Per-rule reasoning + dims needs a big token budget.
        maxTokens: 12000,
        toolName: 'RuleCheck.verify',
      });
    } catch (e) {
      return NextResponse.json<RuleCheckVerifyResponse>({
        ok: false,
        reason: 'llm_error',
        error: (e as Error).message.slice(0, 300),
      });
    }

    let verification: RuleSelectionVerification;
    try {
      verification = parseVerification(llm.text, flags);
    } catch (e) {
      if (e instanceof VerificationParseError) {
        return NextResponse.json<RuleCheckVerifyResponse>({
          ok: false,
          reason: 'parse_error',
          error: e.message.slice(0, 300),
        });
      }
      throw e;
    }

    return NextResponse.json<RuleCheckVerifyResponse>({
      ok: true,
      verification,
      primary_model: audit.llm_model,
      verifier_model: llm.modelUsed,
      duration_ms: llm.durationMs,
      prompt_tokens: llm.usage?.promptTokens,
      completion_tokens: llm.usage?.completionTokens,
    });
  } catch (e) {
    return NextResponse.json<RuleCheckVerifyResponse>({
      ok: false,
      reason: 'error',
      error: (e as Error).message.slice(0, 300),
    });
  }
}
