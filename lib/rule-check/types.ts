// Rule check production module — shared types.
//
// 来源:scripts/rule-check-poc/types.ts(经过 binary PASS/FAIL 简化)
// 边界:这是 matchResumeAgent 在调 RAAS /match-resume 之前的预筛 LLM 评判,
//      不替代 Robohire 的深度打分。

export type Severity = 'terminal' | 'needs_human' | 'flag_only';

export interface Rule {
  id: string;
  specificScenarioStage: string;
  businessLogicRuleName: string;
  applicableClient: '通用' | string;
  applicableDepartment: string;
  submissionCriteria: string;
  standardizedLogicRule: string;
  relatedEntities: string[];
  businessBackgroundReason: string;
  ruleSource: string;
  executor: 'Agent' | 'Human';

  /** 由 severity-infer 注入(ontology 暂无显式 gating_severity 字段)。 */
  severity: Severity;
}

export interface OntologyDims {
  client_id: string;
  business_group: string | null;
  studio: string | null;
}

export interface ClassifiedRules {
  general: Rule[];
  client_level: Rule[];
  department_level: Rule[];
  by_severity: {
    terminal: Rule[];
    needs_human: Rule[];
    flag_only: Rule[];
  };
}

// ─── 5-block input shape (与 docs/yeyang-prompt-adapter-onboarding.md §3.3 对齐) ───

export interface RuleCheckRuntimeContext {
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  employee_id: string;
  filename?: string;
  received_at?: string;
  trace_id?: string | null;
}

export interface RuleCheckInput {
  runtime_context: RuleCheckRuntimeContext;
  resume: Record<string, unknown>;
  job_requisition: Record<string, unknown> & { job_requisition_id: string };
  job_requisition_specification?: Record<string, unknown> | null;
  hsm_feedback?: Record<string, unknown> | null;
}

// ─── LLM output (binary PASS/FAIL,无中间态;2026-05-12 简化) ───
//
// 用户明确:决策只有"成功/失败"两种,成功 → emit RULE_CHECK_PASSED,
// 失败 → emit RULE_CHECK_FAILED。不再要 REVIEW / PAUSE / KEEP / DROP 中间态。

export interface RuleFlag {
  rule_id: string;
  rule_name: string;
  applicable_client: string;
  severity: Severity;
  applicable: boolean;
  /**
   * 新 schema(2026-05-12 后,二元):'PASS' | 'FAIL' | 'NOT_APPLICABLE'。
   * 兼容旧 schema 偶尔出现的 'REVIEW' — wrapper 层把 REVIEW 折叠为 FAIL。
   */
  result: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'REVIEW';
  evidence?: string;
  next_action?: string;
}

export interface LlmRuleCheckOutput {
  candidate_id?: string;
  job_requisition_id?: string;
  client_id?: string;
  /**
   * 新 schema(2026-05-12 后,二元):'PASS' | 'FAIL'。
   * 兼容旧 schema('KEEP' / 'DROP' / 'PAUSE')— LLM 偶尔写老值,wrapper 层 fold。
   */
  overall_decision: 'PASS' | 'FAIL' | 'KEEP' | 'DROP' | 'PAUSE';
  /** 失败原因列表(rule_id:short_code)。PASS 时为空数组。 */
  failure_reasons?: string[];
  /** @deprecated 旧 schema 兼容字段。新 schema 用 failure_reasons。 */
  drop_reasons?: string[];
  /** @deprecated 旧 schema 兼容字段。新 schema 用 failure_reasons。 */
  pause_reasons?: string[];
  rule_flags?: RuleFlag[];
  resume_augmentation?: string;
  notifications?: Array<{
    recipient: string;
    channel: string;
    rule_id: string;
    message: string;
  }>;
}

// ─── 给上游 matchResumeAgent 的最终决策(二元化) ───

export interface RuleCheckVerdict {
  /** 二元决策:PASS 推进到 matchResume,FAIL 中止 + emit RULE_CHECK_FAILED。 */
  decision: 'PASS' | 'FAIL';
  /**
   * LLM 原始输出的 overall_decision。
   * 新 schema(2026-05-12 后):'PASS' | 'FAIL'。
   * 老 schema 历史值('KEEP'/'DROP'/'PAUSE')作为兼容保留 — 实际用户已不再要中间态。
   * 'UNKNOWN' = LLM 输出解析失败。
   */
  llm_decision: 'PASS' | 'FAIL' | 'KEEP' | 'DROP' | 'PAUSE' | 'UNKNOWN';
  /** FAIL 的原因列表(rule_id:short_code 形式)。PASS 时为空。 */
  failure_reasons: string[];
  /** 命中(applicable=true 且 result∈{FAIL,REVIEW})的规则 flag。 */
  hit_flags: RuleFlag[];
  /**
   * LLM 输出的 markdown 段(`resume_augmentation` 字段),Kenny §3 关键:
   * 这段在 matchResumeAgent KEEP 路径会被注入到 Robohire `/match-resume`
   * 的 resume 字段顶部,让 Robohire 看到我们 ontology 规则的预判结果。
   * 例:
   *   "## Rule Check Annotations\n\n
   *    - [10-25 ✓] 华为冷冻期已过(work_history[2]: 华为, 离职 ...)\n
   *    - [10-43 ⚠] IEG 工作室回流标记 ..."
   * 字段语义:LLM 输出且非空 → 注入;为空或缺 → 不注入,resume 原样发。
   */
  resume_augmentation?: string;
  /** 全量 LLM raw output(JSON 解析后)。null = 解析失败。 */
  llm_output: LlmRuleCheckOutput | null;
  /** 观测/审计字段。 */
  audit: {
    rules_evaluated: number;
    rules_total_in_ontology: number;
    dims: OntologyDims;
    llm_model: string;
    llm_duration_ms: number;
    llm_prompt_tokens?: number;
    llm_completion_tokens?: number;
    raw_text_preview: string;
    /** LLM 原始响应全文(给审计界面看)。空字符串 = 调用失败。 */
    llm_raw_text?: string;
    /** 喂给 LLM 的 user prompt 全文(markdown,~20K 字符)。 */
    user_prompt?: string;
    /** 喂给 LLM 的 system prompt 全文。 */
    system_prompt?: string;
    parse_error?: string;
    /**
     * Phase 1:partial resume projection 实际用的字段名列表。
     * null = projection 关闭(整段发);[] = 没字段(理论上不可能,name 兜底)。
     */
    partial_resume_fields?: string[] | null;
    /**
     * Rule 列表来源。三态优先级:
     *   "neo4j-direct"  → 直接从本地 Neo4j Cypher 查(优先,跟 schema 同步)
     *   "ontology-api"  → 叶洋 Ontology API live 调
     *   "json-fallback" → 静态 rules.json
     *   "unknown"       → 未走 Phase 2+ 路径(例如 yeyang-runner 直用静态 snapshot)
     */
    rule_source?: 'neo4j-direct' | 'ontology-api' | 'json-fallback' | 'unknown';
    /**
     * 被 applyClientFilter 过滤掉的规则列表(没进 user_prompt 的)。
     * 前端 drawer 在 User Prompt 之前展示,证明 "ontology N 条全部审视过,其中 M 条
     * 因 client/department 不匹配本 audit 被跳过"。
     */
    filtered_out_rules?: Array<{
      rule_id: string;
      rule_name: string;
      applicable_client: string;
      applicable_department: string;
      executor: string;
      reason: string; // 一句话:为什么被过滤掉
    }>;
  };
}
