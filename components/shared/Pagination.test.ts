import { describe, expect, it } from "vitest";
import { paginationPageItems } from "./Pagination";

describe("paginationPageItems", () => {
  it("shows every page for short result sets", () => {
    expect(paginationPageItems(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the current page and both boundaries for long result sets", () => {
    expect(paginationPageItems(10, 20)).toEqual([
      1,
      "gap-left",
      9,
      10,
      11,
      "gap-right",
      20,
    ]);
  });

  it("expands the leading and trailing page ranges near boundaries", () => {
    expect(paginationPageItems(2, 20)).toEqual([1, 2, 3, 4, 5, "gap-right", 20]);
    expect(paginationPageItems(19, 20)).toEqual([1, "gap-left", 16, 17, 18, 19, 20]);
  });
});
