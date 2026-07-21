import {
  isRaasV1FunctionId,
  raasV1FunctionSlug,
  RAAS_V1_FUNCTION_IDS,
  type RaasV1FunctionId,
} from "@/lib/raas-v1-inngest";
import { isAgentPaused } from "@/lib/agent-pause-guard";

type InngestFunctionLike = {
  opts?: { id?: string };
  id?: (prefix?: string) => string;
};

type LoggerLike = {
  warn?: (message: string) => void;
  info?: (message: string) => void;
};

export function inngestFunctionId(fn: unknown): string {
  const f = fn as InngestFunctionLike;
  return f.opts?.id ?? (typeof f.id === "function" ? f.id() : "");
}

export function assertRaasV1FunctionSet(functions: readonly unknown[]): void {
  const actual = functions.map(inngestFunctionId).filter(Boolean);
  const expected = [...RAAS_V1_FUNCTION_IDS];
  const extra = actual.filter((id) => !isRaasV1FunctionId(id));
  const missing = expected.filter((id) => !actual.includes(id));
  const duplicates = actual.filter((id, idx) => actual.indexOf(id) !== idx);

  if (extra.length || missing.length || duplicates.length || actual.length !== expected.length) {
    throw new Error(
      [
        "RAAS-v1 Inngest manifest mismatch.",
        `expected=[${expected.join(",")}]`,
        `actual=[${actual.join(",")}]`,
        extra.length ? `extra=[${extra.join(",")}]` : null,
        missing.length ? `missing=[${missing.join(",")}]` : null,
        duplicates.length ? `duplicates=[${duplicates.join(",")}]` : null,
      ].filter(Boolean).join(" "),
    );
  }
}

export async function skipIfRaasV1Paused(
  functionId: RaasV1FunctionId,
  logger?: LoggerLike,
): Promise<{ ok: true; paused: true; slug: string; functionId: RaasV1FunctionId } | null> {
  const slug = raasV1FunctionSlug(functionId);
  if (!(await isAgentPaused(slug))) return null;
  logger?.warn?.(`[inngest] ${slug} is offline; skipping stale dispatch`);
  return { ok: true, paused: true, slug, functionId };
}
