// lib/partner-pg/_robohire-normalize.ts
//
// Port of raas_v4's RoboHire response normalization used by the legacy
// `ingestSingleMatch` service. Reference:
//   raas_v4/backend/apps/api/src/modules/matching/match-result-ingest.service.ts
//
// Why we need this: RoboHire's real /match-resume response nests the score
// under `data.overallMatchScore.score` (not flat `matchScore`), and ships
// skill / experience / summary fields under `mustHaveAnalysis` +
// `niceToHaveAnalysis` + `overallMatchScore.breakdown`. The old AO writer
// read everything from flat top-level keys → every column landed NULL.
//
// `resolveMatchPayload(raw)` returns a normalized `inner` shape with the
// fields downstream code expects (matchScore, matchAnalysis.technicalSkills,
// matchAnalysis.experienceLevel, mustHaveAnalysis, niceToHaveAnalysis,
// summary, recommendation, grade) regardless of which shape RoboHire
// returned.

// ──────────────────────────────────────────────────────────────────────
// Shape detection + normalization
// ──────────────────────────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;

function isShapeD(raw: AnyRecord): boolean {
  const mh = (raw as any)?.mustHaveAnalysis;
  return (
    mh &&
    typeof mh === 'object' &&
    (typeof mh.mustHaveScore === 'number' || mh.candidateEvaluation != null)
  );
}

function buildShapeDInner(raw: AnyRecord): AnyRecord {
  const r = raw as any;
  const mh = r?.mustHaveAnalysis ?? {};
  const nh = r?.niceToHaveAnalysis ?? {};
  const mhEval = mh.candidateEvaluation ?? {};
  const nhEval = nh.candidateEvaluation ?? {};

  const overall = r?.overallMatchScore ?? {};
  const overallScore = typeof overall.score === 'number' ? overall.score : null;
  const overallGrade = typeof overall.grade === 'string' ? overall.grade : null;
  const breakdown = overall.breakdown ?? null;

  const mhScore = typeof mh.mustHaveScore === 'number' ? mh.mustHaveScore : null;
  const nhScore = typeof nh.niceToHaveScore === 'number' ? nh.niceToHaveScore : null;
  const disqualified = mh.disqualified === true;

  // Per raas_v4: prefer overall.score; fall back to weighted mh*0.7 + nh*0.3.
  const matchScore =
    overallScore != null
      ? overallScore
      : mhScore != null && nhScore != null
        ? Math.round(mhScore * 0.7 + nhScore * 0.3)
        : (mhScore ?? nhScore ?? null);

  const skillScore =
    typeof breakdown?.skillMatchScore === 'number' ? breakdown.skillMatchScore : matchScore;
  const experienceScoreFromBreakdown =
    typeof breakdown?.experienceScore === 'number' ? breakdown.experienceScore : matchScore;

  const matchedSkillsMust: string[] = Array.isArray(mhEval.matchedSkills)
    ? (mhEval.matchedSkills as unknown[])
        .map((s) => (typeof s === 'string' ? s : (s as any)?.skill))
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const matchedSkillsNice: string[] = Array.isArray(nhEval.matchedSkills)
    ? (nhEval.matchedSkills as unknown[]).filter(
        (s): s is string => typeof s === 'string' && s.length > 0,
      )
    : [];
  const matchedSkills = [...new Set([...matchedSkillsMust, ...matchedSkillsNice])];

  const missingSkills: string[] = Array.isArray(mhEval.missingSkills)
    ? (mhEval.missingSkills as unknown[])
        .map((s) => (typeof s === 'string' ? s : (s as any)?.skill))
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];

  const matchedExperiences: string[] = Array.isArray(mhEval.matchedExperiences)
    ? (mhEval.matchedExperiences as unknown[])
        .map((e) =>
          typeof e === 'string' ? e : ((e as any)?.candidateEvidence ?? (e as any)?.experience),
        )
        .filter((e): e is string => typeof e === 'string' && e.length > 0)
    : [];
  const experienceAssessment =
    matchedExperiences.length > 0 ? matchedExperiences.join('；') : null;

  const summaryParts: string[] = [];
  if (typeof mh.gapAnalysis === 'string' && mh.gapAnalysis.length > 0)
    summaryParts.push(mh.gapAnalysis);
  if (typeof nh.competitiveAdvantage === 'string' && nh.competitiveAdvantage.length > 0)
    summaryParts.push(nh.competitiveAdvantage);
  const summary = summaryParts.length > 0 ? summaryParts.join('\n\n') : null;

  let recommendation: string | null = null;
  if (disqualified) recommendation = 'REJECT';
  else if (matchScore != null) {
    if (matchScore >= 85) recommendation = 'STRONG_MATCH';
    else if (matchScore >= 70) recommendation = 'GOOD_MATCH';
    else if (matchScore >= 50) recommendation = 'PARTIAL_MATCH';
    else recommendation = 'WEAK_MATCH';
  }

  return {
    matchScore,
    matchAnalysis: {
      technicalSkills: { score: skillScore, matchedSkills, missingSkills },
      experienceLevel: { score: experienceScoreFromBreakdown, assessment: experienceAssessment },
    },
    mustHaveAnalysis: mh,
    niceToHaveAnalysis: nh,
    overallMatchScore: r?.overallMatchScore ?? null,
    grade: overallGrade,
    summary,
    recommendation,
  };
}

export type ResolvedMatchPayload = {
  inner: AnyRecord;
  isNewShape: boolean;
};

/**
 * Detect which RoboHire response shape we got and return a normalized
 * `inner` blob with `matchScore` / `matchAnalysis` / etc. set correctly.
 *
 * Shapes covered (in order of detection):
 *   1. `{ data: { matchScore | matchAnalysis } }` envelope → use `data`
 *   2. Top-level `{ matchScore | matchAnalysis }` already-normalized
 *   3. RoboHire raw: `{ mustHaveAnalysis, niceToHaveAnalysis, overallMatchScore }` → buildShapeDInner
 *   4. Legacy payloads (`{ total_weighted_score, matched_reason_highlights }`) → pass through
 */
export function resolveMatchPayload(raw: AnyRecord | null | undefined): ResolvedMatchPayload {
  const r = (raw ?? {}) as any;
  if (r?.data != null && (typeof r.data.matchScore === 'number' || r.data.matchAnalysis != null)) {
    return { inner: r.data as AnyRecord, isNewShape: true };
  }
  if (typeof r?.matchScore === 'number' || r?.matchAnalysis != null) {
    return { inner: r as AnyRecord, isNewShape: true };
  }
  if (isShapeD(r)) {
    return { inner: buildShapeDInner(r), isNewShape: true };
  }
  return { inner: r as AnyRecord, isNewShape: false };
}

// ──────────────────────────────────────────────────────────────────────
// Field extractors used by both runtime_state + main table writes
// ──────────────────────────────────────────────────────────────────────

export type NormalizedFields = {
  matchingScore: number | null;
  skillsScore: number | null;
  experienceScore: number | null;
  experienceAssessment: string | null;
  matchedSkills: string[] | null;
  missingSkills: string[] | null;
  mustHaveAnalysis: unknown;
  niceToHaveAnalysis: unknown;
  advantages: string[];
  disadvantages: string[];
  aiSummary: string | null;
  finalRecommendation: string | null;
  /** Original raw envelope kept verbatim for raw_llm_response forensics. */
  raw: AnyRecord;
};

/**
 * Flatten the normalized `inner` payload into the column-shaped fields the
 * partner Postgres tables (`candidate_match_result_runtime_state`) expect.
 *
 * For legacy / unknown shapes (`isNewShape === false`) we fall back to the
 * top-level `payload.*` keys the partner once accepted directly.
 */
export function extractNormalizedFields(
  payload: AnyRecord,
  { inner, isNewShape }: ResolvedMatchPayload,
): NormalizedFields {
  if (isNewShape) {
    const tech = (inner.matchAnalysis as any)?.technicalSkills;
    const expLevel = (inner.matchAnalysis as any)?.experienceLevel;
    const matchedSkills: string[] | null = Array.isArray(tech?.matchedSkills)
      ? (tech.matchedSkills as string[])
      : null;
    const missingSkills: string[] | null = Array.isArray(tech?.missingSkills)
      ? (tech.missingSkills as string[])
      : null;
    return {
      matchingScore: typeof inner.matchScore === 'number' ? (inner.matchScore as number) : null,
      skillsScore: typeof tech?.score === 'number' ? (tech.score as number) : null,
      experienceScore: typeof expLevel?.score === 'number' ? (expLevel.score as number) : null,
      experienceAssessment:
        typeof expLevel?.assessment === 'string' ? (expLevel.assessment as string) : null,
      matchedSkills,
      missingSkills,
      mustHaveAnalysis: inner.mustHaveAnalysis ?? null,
      niceToHaveAnalysis: inner.niceToHaveAnalysis ?? null,
      advantages: matchedSkills ?? [],
      disadvantages: missingSkills ?? [],
      aiSummary: typeof inner.summary === 'string' ? (inner.summary as string) : null,
      finalRecommendation:
        typeof inner.recommendation === 'string' ? (inner.recommendation as string) : null,
      raw: payload,
    };
  }

  const p = payload as any;
  return {
    matchingScore:
      typeof p.total_weighted_score === 'number'
        ? (p.total_weighted_score as number)
        : typeof p.matching_score === 'number'
          ? (p.matching_score as number)
          : null,
    skillsScore: typeof p.skills_score === 'number' ? (p.skills_score as number) : null,
    experienceScore: null,
    experienceAssessment: null,
    matchedSkills: null,
    missingSkills: null,
    mustHaveAnalysis: null,
    niceToHaveAnalysis: null,
    advantages: Array.isArray(p.matched_reason_highlights)
      ? (p.matched_reason_highlights as string[])
      : Array.isArray(p.advantages)
        ? (p.advantages as string[])
        : [],
    disadvantages: Array.isArray(p.disadvantages) ? (p.disadvantages as string[]) : [],
    aiSummary: typeof p.ai_summary === 'string' ? (p.ai_summary as string) : null,
    finalRecommendation:
      typeof p.final_recommendation === 'string' ? (p.final_recommendation as string) : null,
    raw: payload,
  };
}

/**
 * Six-dimension scores used by the MatchPool surface
 * (`candidate_match_result.dimension_scores`). Tries multiple sources:
 *   1. explicit `payload.dimension_scores`
 *   2. `overallMatchScore.breakdown` from RoboHire raw
 *   3. inner `matchAnalysis.{technicalSkills,experienceLevel,…}.score`
 */
export function buildDimensionScores(
  payload: AnyRecord,
  { inner, isNewShape }: ResolvedMatchPayload,
): Record<string, number> | null {
  const p = payload as any;
  const raw: Record<string, unknown> | null = (() => {
    if (p?.dimension_scores && typeof p.dimension_scores === 'object') {
      return p.dimension_scores as Record<string, unknown>;
    }
    const breakdown =
      p?.overallMatchScore?.breakdown ?? (inner as any)?.overallMatchScore?.breakdown;
    if (breakdown && typeof breakdown === 'object') {
      const out: Record<string, unknown> = {};
      if (typeof breakdown.skillMatchScore === 'number') out.skill = breakdown.skillMatchScore;
      if (typeof breakdown.experienceScore === 'number') out.experience = breakdown.experienceScore;
      if (typeof breakdown.potentialScore === 'number') out.potential = breakdown.potentialScore;
      if (Object.keys(out).length > 0) return out;
    }
    if (isNewShape && (inner as any)?.matchAnalysis && typeof inner.matchAnalysis === 'object') {
      const a = (inner as any).matchAnalysis;
      return {
        skill: a?.technicalSkills?.score,
        experience: a?.experienceLevel?.score,
        domain: a?.domainKnowledge?.score,
        soft: a?.softSkills?.score,
        education: a?.education?.score,
        stability: a?.stability?.score,
      } as Record<string, unknown>;
    }
    return null;
  })();
  if (!raw) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Core tags shown on the row card. Prefers explicit payload.core_tags, else first 6 matched skills. */
export function buildCoreTags(payload: AnyRecord, matchedSkills: string[] | null): string[] {
  const p = payload as any;
  if (Array.isArray(p?.core_tags)) {
    return (p.core_tags as unknown[]).filter(
      (t): t is string => typeof t === 'string' && t.length > 0,
    );
  }
  if (Array.isArray(matchedSkills)) return matchedSkills.slice(0, 6);
  return [];
}

// ──────────────────────────────────────────────────────────────────────
// Anti-regression — skip when a re-run would clobber a richer existing row
// ──────────────────────────────────────────────────────────────────────

type RichnessRow = {
  total_weighted_score?: unknown;
  skills_score?: unknown;
  experience_score?: unknown;
  experience_assessment?: unknown;
  matched_skills?: unknown;
  missing_skills?: unknown;
  must_have_analysis?: unknown;
  nice_to_have_analysis?: unknown;
  advantages?: unknown;
  disadvantages?: unknown;
  ai_summary?: unknown;
  final_recommendation?: unknown;
};

/**
 * Weight an existing or incoming runtime_state row by how many meaningful
 * fields it carries. Re-run upserts that drop richness (e.g. a retry that
 * lost LLM output) get skipped rather than clobbering a good row.
 */
export function richnessScore(row: RichnessRow | null | undefined): number {
  if (!row || typeof row !== 'object') return 0;
  let s = 0;
  if (row.total_weighted_score != null) s += 3;
  if (row.skills_score != null) s += 1;
  if (row.experience_score != null) s += 1;
  if (typeof row.experience_assessment === 'string' && row.experience_assessment.length > 0) s += 1;
  if (Array.isArray(row.matched_skills) && row.matched_skills.length > 0) s += 1;
  if (Array.isArray(row.missing_skills) && row.missing_skills.length > 0) s += 1;
  if (row.must_have_analysis != null) s += 2;
  if (row.nice_to_have_analysis != null) s += 2;
  if (Array.isArray(row.advantages) && row.advantages.length > 0) s += 1;
  if (Array.isArray(row.disadvantages) && row.disadvantages.length > 0) s += 1;
  if (typeof row.ai_summary === 'string' && row.ai_summary.length > 0) s += 2;
  if (typeof row.final_recommendation === 'string' && row.final_recommendation.length > 0) s += 1;
  return s;
}
