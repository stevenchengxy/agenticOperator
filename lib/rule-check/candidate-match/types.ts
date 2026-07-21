// Shared types for candidate identity / ownership matching.

import type { MatchField } from './rules-data';

/** A candidate record, with the fields the identity rules compare. Field names mirror
 *  the resume parse output (server/inngest/client.ts ResumeNested.education_history:
 *  institution→school, field→major, degree, graduationYear) + partner-pg candidate
 *  columns (name, mobile→phone, email, gender). */
export interface CandidateRecord {
  candidate_id: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  gender?: string | null;
  school?: string | null;
  major?: string | null;
  degree?: string | null;
  graduationYear?: string | null;
}

/** Read a candidate field's raw value by MatchField key. */
export function fieldRawValue(rec: CandidateRecord, field: MatchField): string | null | undefined {
  switch (field) {
    case 'phone':
      return rec.phone;
    case 'name':
      return rec.name;
    case 'email':
      return rec.email;
    case 'gender':
      return rec.gender;
    case 'school':
      return rec.school;
    case 'major':
      return rec.major;
    case 'degree':
      return rec.degree;
    case 'graduationYear':
      return rec.graduationYear;
  }
}
