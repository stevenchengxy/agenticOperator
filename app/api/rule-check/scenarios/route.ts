import { NextResponse } from 'next/server';
import { loadScenarios } from '@/server/rule-check/scenarios-loader';

export async function GET() {
  const scenarios = loadScenarios();
  return NextResponse.json({
    scenarios: scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      candidate_id: s.candidate_id,
      resume_id: s.resume_id,
      job_requisition_id: s.job_requisition_id,
      expected: s.expected,
    })),
  });
}
