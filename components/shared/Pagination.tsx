"use client";

import React from "react";
import { useApp } from "@/lib/i18n";
import { Btn } from "./atoms";

const DEFAULT_SIZES = [20, 50, 100] as const;

type PageItem = number | "gap-left" | "gap-right";

export function paginationPageItems(page: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (page <= 4) return [1, 2, 3, 4, 5, "gap-right", totalPages];
  if (page >= totalPages - 3) {
    return [1, "gap-left", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "gap-left", page - 1, page, page + 1, "gap-right", totalPages];
}

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  rowCount,
  loading = false,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_SIZES,
  compact = false,
}: {
  page: number;
  pageSize: number;
  total: number | null;
  totalPages: number | null;
  rowCount: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  compact?: boolean;
}) {
  const { t } = useApp();
  const knownPages = totalPages ?? Math.max(page, rowCount === pageSize ? page + 1 : page);
  const hasPrevious = page > 1;
  const hasNext = totalPages != null ? page < totalPages : rowCount === pageSize;
  const first = rowCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = rowCount === 0 ? 0 : first + rowCount - 1;

  return (
    <div
      className="flex items-center gap-2 border-t border-line bg-surface text-ink-3"
      style={{ padding: compact ? "7px 10px" : "9px 12px", fontSize: 11.5 }}
      aria-label={t("pagination_label")}
    >
      <span className="tabular-nums whitespace-nowrap">
        {total == null
          ? t("pagination_range_unknown")
              .replace("{from}", String(first))
              .replace("{to}", String(last))
          : t("pagination_range")
              .replace("{from}", String(first))
              .replace("{to}", String(last))
              .replace("{total}", String(total))}
      </span>

      {!compact && onPageSizeChange && (
        <label className="ml-2 flex items-center gap-1.5 whitespace-nowrap">
          <span>{t("pagination_per_page")}</span>
          <select
            className="h-6 rounded border border-line bg-bg px-1.5 text-ink-2"
            value={pageSize}
            disabled={loading}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
      )}

      <span className="flex-1" />
      <span className="tabular-nums whitespace-nowrap">
        {t("pagination_page")
          .replace("{page}", String(page))
          .replace("{pages}", totalPages == null ? `${knownPages}+` : String(knownPages))}
      </span>
      <Btn
        size="sm"
        variant="ghost"
        disabled={!hasPrevious || loading}
        onClick={() => onPageChange(page - 1)}
        aria-label={t("pagination_previous")}
        title={t("pagination_previous")}
      >
        ←{compact ? "" : ` ${t("pagination_previous")}`}
      </Btn>
      {!compact && totalPages != null && totalPages > 1 && (
        <div className="flex items-center gap-0.5" role="group" aria-label={t("pagination_pages")}>
          {paginationPageItems(page, totalPages).map((item) =>
            typeof item === "number" ? (
              <button
                key={item}
                type="button"
                disabled={loading}
                aria-current={item === page ? "page" : undefined}
                aria-label={t("pagination_go_to_page").replace("{page}", String(item))}
                title={t("pagination_go_to_page").replace("{page}", String(item))}
                onClick={() => onPageChange(item)}
                className="h-6 min-w-6 rounded px-1.5 tabular-nums transition-colors disabled:opacity-50"
                style={{
                  color: item === page ? "var(--c-accent)" : "var(--c-ink-2)",
                  background: item === page ? "var(--c-accent-bg)" : "transparent",
                  fontWeight: item === page ? 650 : 450,
                }}
              >
                {item}
              </button>
            ) : (
              <span key={item} className="w-4 text-center text-ink-4" aria-hidden>…</span>
            ),
          )}
        </div>
      )}
      <Btn
        size="sm"
        variant="ghost"
        disabled={!hasNext || loading}
        onClick={() => onPageChange(page + 1)}
        aria-label={t("pagination_next")}
        title={t("pagination_next")}
      >
        {compact ? "" : `${t("pagination_next")} `}→
      </Btn>
    </div>
  );
}
