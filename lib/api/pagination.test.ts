import { describe, expect, it } from "vitest";
import { paginationFrom, readPage, readPageSize, setPaginationParams } from "./pagination";

describe("pagination compatibility", () => {
  it("reads the canonical top-level envelope", () => {
    expect(paginationFrom(
      { page: 3, pageSize: 20, total: 91, totalPages: 5 },
      { page: 1, pageSize: 50, rowCount: 20 },
    )).toEqual({ page: 3, pageSize: 20, total: 91, totalPages: 5 });
  });

  it("reads nested and meta envelopes during rolling upgrades", () => {
    expect(paginationFrom(
      { meta: { pagination: { page: 2, pageSize: 50, total: 120 } } },
      { page: 1, pageSize: 20, rowCount: 50 },
    )).toEqual({ page: 2, pageSize: 50, total: 120, totalPages: 3 });
  });

  it("adds both canonical and legacy query parameters", () => {
    const params = setPaginationParams(new URLSearchParams(), 4, 25);
    expect(Object.fromEntries(params)).toEqual({
      page: "4",
      pageSize: "25",
      limit: "25",
      offset: "75",
    });
  });

  it("rejects invalid URL values", () => {
    expect(readPage("0")).toBe(1);
    expect(readPage("abc", 2)).toBe(2);
    expect(readPageSize("30", [20, 50], 20)).toBe(20);
    expect(readPageSize("50", [20, 50], 20)).toBe(50);
  });
});
