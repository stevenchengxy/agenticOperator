// 开发态读取兜底:partner-pg(同事的远程库)连不上时,透明地改用本地镜像库。
// 纯函数 + 判定,放在 client.ts 之外好单测。生产不配 RAAS_MIRROR_PG_URL → 镜像为
// null → 这里永远直抛 partner 的错,行为与改造前完全一致(不影响 agent 逻辑)。

/** pg / node 网络层「连不上」的错误码。业务错(语法/约束/空值)不在内。 */
const CONN_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET',
  // partner-pg LAN box 关机/不可达时 pg 会抛这些(之前漏了 → 不走镜像兜底)。
  'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EAI_AGAIN',
]);

/** 只有「连不上 partner」才触发兜底;SQL 业务错必须原样冒泡,绝不偷偷换库。 */
export function isConnFailure(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (CONN_CODES.has(code)) return true;
  const msg = typeof e?.message === 'string' ? e.message : '';
  // node-postgres Pool 的连接超时/断连不带 ETIMEDOUT 字样,而是这两条 pg-pool 专属文案 ——
  // 漏匹配会导致 partner-pg 不可达时不走本地镜像兜底。
  return (
    /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EHOSTDOWN|ENETUNREACH|ENETDOWN|EPIPE|EAI_AGAIN)\b/.test(msg) ||
    /Connection terminated|connection timeout|timeout expired/i.test(msg)
  );
}

/**
 * 跑 primary(partner-pg);仅当它「连不上」且有 mirror 时,改跑 mirror。
 * - primary 成功 → 直接返回,不碰 mirror。
 * - primary 连接失败 + mirror 存在 → 跑 mirror(兜底)。
 * - primary 业务错 → 原样抛。
 * - 无 mirror → 任何错都原样抛。
 */
export async function runWithMirrorFallback<T>(
  primary: () => Promise<T>,
  mirror: (() => Promise<T>) | null,
): Promise<T> {
  try {
    return await primary();
  } catch (err) {
    if (mirror && isConnFailure(err)) {
      return await mirror();
    }
    throw err;
  }
}
