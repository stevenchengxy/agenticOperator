// Vendor copy of lib/ontology-gen/v4/runtime-input.types.ts (AO main).
//
// 这里就地复用,避免跨 Next.js 项目 import 的 bundler 麻烦。
// 字段语义跟主仓那份 1:1,主仓改了这里要同步。

export interface RuntimeClient {
  /** Rendered as `client_name: <name>` in the CLIENT block. */
  name: string;
  /** Rendered as `department: <department>` when present. */
  department?: string;
  [key: string]: unknown;
}

export interface RuntimeJob {
  job_requisition_id: string;
  [field: string]: unknown;
}

export interface RuntimeResume {
  candidate_id: string;
  [field: string]: unknown;
}

export interface MatchResumeRuntimeInput {
  kind: 'matchResume';
  client: RuntimeClient;
  job: RuntimeJob;
  resume: RuntimeResume;
}

export function isMatchResumeRuntimeInput(x: unknown): x is MatchResumeRuntimeInput {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { kind?: unknown }).kind === 'matchResume'
  );
}
