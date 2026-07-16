export type PaginationInfo = {
  page: number;
  pageSize: number;
  total: number | null;
  totalPages: number | null;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

function nonNegativeInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Accepts both the new top-level pagination envelope and older API shapes.
 * During rolling upgrades this lets the UI work against either version:
 *
 *   { page, pageSize, total, totalPages }
 *   { pagination: { ... } }
 *   { meta: { page, pageSize, total, totalPages } }
 */
export function paginationFrom(
  payload: unknown,
  fallback: { page: number; pageSize: number; rowCount: number },
): PaginationInfo {
  const root = record(payload) ?? {};
  const meta = record(root.meta) ?? {};
  const nested = record(root.pagination) ?? record(meta.pagination) ?? {};

  const pick = (key: string): unknown =>
    nested[key] ?? root[key] ?? meta[key];

  const page = positiveInt(pick("page")) ?? fallback.page;
  const pageSize = positiveInt(pick("pageSize")) ?? fallback.pageSize;
  const total = nonNegativeInt(pick("total"));
  const reportedPages = nonNegativeInt(pick("totalPages"));
  const totalPages = reportedPages != null
    ? Math.max(1, reportedPages)
    : total != null
      ? Math.max(1, Math.ceil(total / pageSize))
      : null;

  return { page, pageSize, total, totalPages };
}

/** Adds the new contract plus legacy limit/offset for mixed-version deploys. */
export function setPaginationParams(
  params: URLSearchParams,
  page: number,
  pageSize: number,
): URLSearchParams {
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  params.set("limit", String(pageSize));
  params.set("offset", String((page - 1) * pageSize));
  return params;
}

export function readPage(value: string | null, fallback = 1): number {
  return positiveInt(value) ?? fallback;
}

export function readPageSize(
  value: string | null,
  allowed: readonly number[],
  fallback: number,
): number {
  const parsed = positiveInt(value);
  return parsed != null && allowed.includes(parsed) ? parsed : fallback;
}
