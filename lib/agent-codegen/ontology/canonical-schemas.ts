// Canonical AllmetaOntology entity schemas — static snapshot.
//
// Source of truth: `neo4j_data/objects_v0_1_015.json` (per the banner
// comments in lib/allmeta-writers/<entity>.ts). These are the EXACT
// field names allmeta accepts; sending anything else causes the writer
// to silently filter or — if you bypass the writer — get the whole row
// rejected by the ontology API.
//
// Codegen LLM looks these up when filling step bodies that call any
// writeXInstance, so generated code uses canonical names instead of
// guessing from parsed-resume / raw event payloads.
//
// MAINTENANCE: when allmeta_v0_1_016+ ships, re-extract from the source
// JSON. Until then this is the authoritative codegen view.

export type FieldType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'List<string>'
  | 'List<integer>';

export type CanonicalField = {
  name: string;
  type: FieldType;
  /** True iff omission causes server-side rejection — only set when explicit in the banner. */
  required?: boolean;
  /** PK convention marker; codegen prompt highlights this so the LLM derives it deterministically. */
  pk?: boolean;
  /** Cross-entity FK reference; helps the LLM see relationships. */
  fk?: string;
  /** Optional one-line note (e.g. "default placeholder applied if missing"). */
  note?: string;
};

export type CanonicalEntity = {
  /** Allmeta ontology label, used as the API endpoint path component. */
  name: string;
  fields: CanonicalField[];
  /** Sub-tools that write this entity from AO. */
  writers: string[];
  /** Free-text guidance baked into the prompt. */
  guidance?: string;
};

// ────────────────────────────────────────────────────────────────────────
// Entity definitions
// ────────────────────────────────────────────────────────────────────────

export const CANONICAL_ENTITIES: ReadonlyArray<CanonicalEntity> = [
  {
    name: 'Job_Requisition',
    writers: ['allmeta.writeJobRequisition'],
    guidance:
      'Mirror a partner_pg job_requisition row. Source object is the requirement detail from getRequirementDetail() — pass the WHOLE requirement under `input.requirement`; the writer normalizes nested arrays / nullable fields internally.',
    fields: [
      { name: 'job_requisition_id', type: 'string', pk: true, required: true },
      { name: 'job_requisition_specification_id', type: 'string' },
      { name: 'csi_department_id', type: 'string' },
      { name: 'client_department_id', type: 'string' },
      { name: 'standard_job_role_id', type: 'string' },
      { name: 'evaluation_model_id', type: 'string' },
      { name: 'client_job_id', type: 'string' },
      { name: 'client_job_temp_id', type: 'string' },
      { name: 'client_job_title', type: 'string' },
      { name: 'client_job_type', type: 'string' },
      { name: 'job_responsibility', type: 'string' },
      { name: 'job_requirement', type: 'string' },
      { name: 'job_type', type: 'string' },
      { name: 'recruitment_type', type: 'string' },
      { name: 'work_years', type: 'integer' },
      { name: 'gender', type: 'string' },
      { name: 'age_range', type: 'string' },
      { name: 'degree_requirement', type: 'string' },
      { name: 'education_requirement', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'work_address', type: 'List<string>' },
      { name: 'salary_range', type: 'string' },
      { name: 'must_have_skills', type: 'List<string>' },
      { name: 'nice_to_have_skills', type: 'List<string>' },
      { name: 'language_requirements', type: 'string' },
      { name: 'negative_requirement', type: 'string' },
      { name: 'headcount', type: 'integer' },
      { name: 'hc_status', type: 'string' },
      { name: 'fill_difficulty', type: 'string' },
      { name: 'urgency_level', type: 'string' },
      { name: 'open_date', type: 'date' },
      { name: 'required_arrival_date', type: 'date' },
      { name: 'work_schedule_type', type: 'string' },
      { name: 'require_foreigner', type: 'boolean' },
      { name: 'clarify_questions', type: 'List<string>' },
      { name: 'recruitment_strategies', type: 'string' },
      { name: 'interview_mode', type: 'string' },
      { name: 'interview_process', type: 'string' },
      { name: 'expected_level', type: 'string' },
    ],
  },

  {
    name: 'Job_Posting',
    writers: ['allmeta.writeJobPosting'],
    guidance:
      'Mirror a partner_pg job_posting row created by syncJdToPartnerPg. PK is job_posting_id; carries the JD content + sourcing channels.',
    fields: [
      { name: 'job_posting_id', type: 'string', pk: true, required: true },
      { name: 'job_requisition_id', type: 'List<string>', fk: 'Job_Requisition' },
      { name: 'sourcing_channel_id', type: 'List<string>', fk: 'Sourcing_Channel' },
      { name: 'recruiter_employee_id', type: 'string', fk: 'Employee' },
      { name: 'title', type: 'string' },
      { name: 'responsibility', type: 'string' },
      { name: 'requirement', type: 'string' },
      { name: 'key_words', type: 'List<string>' },
      { name: 'type', type: 'string' },
      { name: 'recruitment_type', type: 'string' },
      { name: 'work_years', type: 'integer' },
      { name: 'age_range', type: 'string' },
      { name: 'degree_requirement', type: 'string' },
      { name: 'education_requirement', type: 'string' },
      { name: 'city', type: 'List<string>' },
      { name: 'work_address', type: 'List<string>' },
      { name: 'salary_range', type: 'string' },
      { name: 'publish_time', type: 'timestamp' },
      { name: 'publish_status', type: 'string' },
    ],
  },

  {
    name: 'Candidate',
    writers: ['allmeta.writeCandidate'],
    guidance:
      'Codegen MUST call writeCandidateInstance({ candidate_id, parsed: parsedResume.data }) — pass the WHOLE parsed-resume object under `parsed`, the writer normalizes field names internally (name / phone / address / work_years). Do NOT manually map each canonical field — too easy to typo.',
    fields: [
      { name: 'candidate_id', type: 'string', pk: true, required: true },
      { name: 'employee_id', type: 'string' },
      { name: 'is_locked', type: 'boolean' },
      { name: 'lock_start_time', type: 'timestamp' },
      { name: 'referrer_employee_id', type: 'string' },
      { name: 'id_number', type: 'string' },
      { name: 'name', type: 'string', note: "default '未命名候选人' if parser missed" },
      { name: 'nationality', type: 'string' },
      { name: 'gender', type: 'string' },
      { name: 'birth_date', type: 'date' },
      { name: 'phone', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'address', type: 'string' },
      { name: 'highest_acquired_degree', type: 'string' },
      { name: 'unified_enrollment', type: 'string' },
      { name: 'work_years', type: 'float' },
      { name: 'flight_risk_level', type: 'string' },
      { name: 'max_salary_limit', type: 'float' },
      { name: 'status', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'blacklist_status', type: 'string' },
      { name: 'marital_status', type: 'string' },
      { name: 'conflict_of_interest_declaration', type: 'string' },
      { name: 'conflict_clearance_deadline', type: 'date' },
      { name: 'gap_reason', type: 'string' },
      { name: 'previous_level', type: 'string' },
      { name: 'expected_degree', type: 'string' },
      { name: 'expected_graduation_date', type: 'date' },
      { name: 'github', type: 'string' },
      { name: 'ethnicity', type: 'string' },
      { name: 'native_place', type: 'string' },
    ],
  },

  {
    name: 'Resume',
    writers: ['allmeta.writeResume'],
    guidance:
      'PK convention: resume_id = `resume_${upload_id}` (or stable hash of parsed_resume_json). Pass parsed-resume sub-fields directly; writer handles List<string> coercion.',
    fields: [
      { name: 'resume_id', type: 'string', pk: true, required: true },
      { name: 'candidate_id', type: 'string', fk: 'Candidate', required: true },
      { name: 'job_requisition_id', type: 'List<string>', fk: 'Job_Requisition' },
      { name: 'sourcing_channel_id', type: 'string', fk: 'Sourcing_Channel' },
      { name: 'experience', type: 'string' },
      { name: 'projects', type: 'string' },
      { name: 'education', type: 'string' },
      { name: 'languages', type: 'string' },
      { name: 'file_path', type: 'string' },
      { name: 'is_original', type: 'boolean' },
      { name: 'skills', type: 'List<string>' },
      { name: 'highlight_keywords', type: 'string' },
      { name: 'recommendation_reason', type: 'string' },
      { name: 'project_description_validity', type: 'string' },
      { name: 'certifications', type: 'string' },
      { name: 'portfolio', type: 'string' },
      { name: 'language', type: 'string' },
      { name: 'employee_id', type: 'string' },
      { name: 'created_time', type: 'timestamp' },
      { name: 'updated_time', type: 'timestamp' },
      { name: 'publications', type: 'string' },
      { name: 'patents', type: 'string' },
      { name: 'awards', type: 'string' },
      { name: 'summary', type: 'string' },
    ],
  },

  {
    name: 'Candidate_Match_Result',
    writers: ['allmeta.writeCandidateMatchResult'],
    guidance:
      "Two-phase write: ruleCheckAgent writes rule_check_* first; matchResumeAgent fills overall_* on the SAME PK (`cmr_<candidate>_<jr>`) — allmeta upserts. Always derive PK from candidate_id + job_requisition_id to enable upsert.",
    fields: [
      { name: 'candidate_match_result_id', type: 'string', pk: true, required: true, note: 'cmr_<candidate>_<jr>' },
      { name: 'client_id', type: 'string' },
      { name: 'candidate_id', type: 'string', fk: 'Candidate' },
      { name: 'job_position_id', type: 'string', fk: 'Job_Requisition' },
      { name: 'overall_match_score', type: 'float' },
      { name: 'overall_fit_verdict', type: 'string', note: "'匹配' | '不匹配'" },
      { name: 'overall_fit_summary', type: 'string' },
      { name: 'overall_match_grade', type: 'string' },
      { name: 'rule_check_result', type: 'string', note: "'pass' | 'fail'" },
      { name: 'rule_check_reason', type: 'string' },
    ],
  },

  {
    name: 'Communication_Log',
    writers: ['allmeta.writeCommunicationLog'],
    guidance:
      'PK convention: communication_log_id = `comm_${candidate_id}_${Date.now()}`. Used by interviewInviterAgent to log the invite email / link.',
    fields: [
      { name: 'communication_log_id', type: 'string', pk: true, required: true, note: 'comm_<candidate>_<ts>' },
      { name: 'application_id', type: 'string', fk: 'Application' },
      { name: 'message_sender', type: 'string' },
      { name: 'message_receiver', type: 'string' },
      { name: 'interaction_type', type: 'string', note: "e.g. '面试邀请'" },
      { name: 'message_content', type: 'string' },
      { name: 'content_summary', type: 'string' },
      { name: 'timestamp', type: 'timestamp' },
    ],
  },

  {
    name: 'Interview_Record',
    writers: ['allmeta.writeInterviewRecord'],
    guidance:
      'Written by interviewInviterAgent as a "skeleton" — start_time / notes / result left null at invite-time; downstream agents upsert on the same PK after the interview actually happens. PK: ir_<candidate>_<jr>.',
    fields: [
      { name: 'interview_record_id', type: 'string', pk: true, required: true, note: 'ir_<candidate>_<jr>' },
      { name: 'interview_model_id', type: 'string' },
      { name: 'application_id', type: 'string', fk: 'Application' },
      { name: 'interviewer_employee_id', type: 'string', fk: 'Employee' },
      { name: 'interview_type', type: 'string', note: "'video' | 'onsite' | 'phone'" },
      { name: 'interview_round', type: 'integer' },
      { name: 'start_time', type: 'timestamp' },
      { name: 'end_time', type: 'timestamp' },
      { name: 'duration_minutes', type: 'integer' },
      { name: 'interview_mode', type: 'string' },
      { name: 'recording_url', type: 'string', note: 'invite login URL stashed here at invite-time' },
      { name: 'raw_interview_notes', type: 'string' },
      { name: 'candidate_behavior_notes', type: 'string' },
      { name: 'tech_gaps_identified', type: 'List<string>' },
      { name: 'golden_30_call_status', type: 'boolean' },
      { name: 'interview_result', type: 'string' },
    ],
  },

  {
    name: 'Application',
    writers: ['allmeta.writeApplication'],
    guidance:
      'Tri-link: candidate + resume + requisition. AO writes the link triple + initial stage; HSM/dispatcher fills the rest (~25 fields total) downstream.',
    fields: [
      { name: 'application_id', type: 'string', pk: true, required: true },
      { name: 'client_id', type: 'string' },
      { name: 'candidate_id', type: 'string', fk: 'Candidate', required: true },
      { name: 'resume_id', type: 'string', fk: 'Resume' },
      { name: 'job_requisition_id', type: 'string', fk: 'Job_Requisition', required: true },
      { name: 'sourcing_channel_id', type: 'string', fk: 'Sourcing_Channel' },
      { name: 'stage', type: 'string' },
      { name: 'sub_stage', type: 'string' },
      { name: 'application_status', type: 'string' },
      { name: 'created_time', type: 'timestamp' },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────
// Lookups
// ────────────────────────────────────────────────────────────────────────

const BY_NAME = new Map(CANONICAL_ENTITIES.map((e) => [e.name, e]));

export function findCanonicalEntity(name: string): CanonicalEntity | undefined {
  return BY_NAME.get(name);
}

export function canonicalFieldNames(entityName: string): Set<string> {
  const e = BY_NAME.get(entityName);
  return new Set(e ? e.fields.map((f) => f.name) : []);
}

/** Format a canonical entity as a prompt-ready block for the LLM. */
export function formatCanonicalForPrompt(entityName: string): string | null {
  const e = BY_NAME.get(entityName);
  if (!e) return null;
  const lines: string[] = [];
  lines.push(`Canonical ${e.name} fields (from AllmetaOntology v0.1.015):`);
  if (e.guidance) lines.push(`  Guidance: ${e.guidance}`);
  for (const f of e.fields) {
    const markers = [
      f.pk ? 'PK' : null,
      f.required ? 'required' : null,
      f.fk ? `FK→${f.fk}` : null,
    ]
      .filter((x): x is string => !!x)
      .join(', ');
    const tail = [markers, f.note].filter(Boolean).join(' · ');
    lines.push(`    ${f.name.padEnd(36)} ${f.type.padEnd(14)}${tail ? '  ' + tail : ''}`);
  }
  lines.push(
    '  STRICT: allmeta rejects unknown fields. The writeXInstance functions normalize internally — operator-supplied keys outside this list are silently dropped.',
  );
  return lines.join('\n');
}
