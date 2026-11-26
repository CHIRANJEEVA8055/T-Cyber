import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { compareSortValues, nextSort, sortRows } from "@/components/design/sort";
import { cellSortValue } from "@/components/app/data-table";

describe("sorting a list by a column", () => {
  it("sorts text as people read it, numbers and amounts by value, dates by time", () => {
    expect(["R-10", "R-2", "r-1"].sort(compareSortValues)).toEqual(["r-1", "R-2", "R-10"]);
    expect([10n, 9n, 100n].sort(compareSortValues)).toEqual([9n, 10n, 100n]);
    expect([new Date("2026-11-03"), new Date("2026-10-01")].sort(compareSortValues).map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-10-01", "2026-11-03"]);
    expect(compareSortValues(5n, 7)).toBeLessThan(0);
  });

  it("keeps empty values last in both directions, and is stable", () => {
    const rows = [{ k: "b" }, { k: null }, { k: "a" }, { k: "" }, { k: "a", second: true }];
    expect(sortRows(rows, (r) => r.k, "asc").map((r) => r.k)).toEqual(["a", "a", "b", null, ""]);
    expect(sortRows(rows, (r) => r.k, "desc").map((r) => r.k)).toEqual(["b", "a", "a", null, ""]);
    expect(sortRows(rows, (r) => r.k, "asc")[1]).toMatchObject({ second: true });
  });

  it("first click sorts ascending, the next reverses, another column starts ascending", () => {
    const a = nextSort(null, "date");
    expect(a).toEqual({ key: "date", dir: "asc" });
    expect(nextSort(a, "date")).toEqual({ key: "date", dir: "desc" });
    expect(nextSort({ key: "date", dir: "desc" }, "amount")).toEqual({ key: "amount", dir: "asc" });
  });
});

describe("what a drawn table cell sorts by", () => {
  it("reads text, dates, amounts, statuses and record labels from what the cell shows", () => {
    expect(cellSortValue("  R.REQ-412/2026-002 ")).toBe("R.REQ-412/2026-002");
    expect(cellSortValue(createElement("span", null, "Bank A"))).toBe("Bank A");
    expect(cellSortValue(createElement("span", null, "3", " of ", "5"))).toBe("3 of 5");
    expect(cellSortValue(createElement("time", { iso: "2026-11-03T10:00:00.000Z" }))).toEqual(new Date("2026-11-03T10:00:00.000Z"));
    expect(cellSortValue(createElement("b", { minor: "6000000" }))).toBe(6000000n);
    expect(cellSortValue(createElement("i", { kind: "request", value: "SUBMITTED" }))).toBe("SUBMITTED");
    expect(cellSortValue(createElement("i", { kind: "request", value: "SUBMITTED", label: "Sent" }))).toBe("Sent");
    expect(cellSortValue(createElement("button", { node: { label: "Account A" } }))).toBe("Account A");
  });

  it("treats empty and screen-reader-only content as empty", () => {
    expect(cellSortValue(null)).toBeNull();
    expect(cellSortValue(createElement("span", null, "   "))).toBeNull();
    expect(cellSortValue(createElement("span", { className: "sr-only" }, "Actions"))).toBeNull();
    expect(cellSortValue(createElement("time", { iso: null }))).toBeNull();
    expect(cellSortValue(createElement("time", { iso: "not a date" }))).toBeNull();
  });
});
