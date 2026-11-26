"use client";

import { useMemo, useState, type ReactNode, type ThHTMLAttributes } from "react";
import { Icon } from "@/components/ui/icon";

/**
 * Sorting a list by any of its columns: click a column's heading to sort by it (A to Z, smallest or earliest
 * first), click it again to reverse. Text sorts as people read it ("R-2" before "R-10", case ignored); amounts
 * and dates sort by value; empty values always go last. The original order stays until a heading is clicked.
 */

export type SortValue = string | number | bigint | Date | null | undefined;
export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}

const collator = new Intl.Collator("en-IN", { numeric: true, sensitivity: "base" });

/** Compares two values for sorting; empty values compare as last whatever the direction (handled by the caller). */
export function compareSortValues(a: SortValue, b: SortValue): number {
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  if (typeof a === "bigint" || typeof b === "bigint") {
    const x = BigInt(a as bigint | number);
    const y = BigInt(b as bigint | number);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

const empty = (v: SortValue) => v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));

/** The rows in the chosen order (a stable sort; empty values last). */
export function sortRows<T>(rows: readonly T[], get: ((r: T) => SortValue) | undefined, dir: SortDir): T[] {
  if (!get) return [...rows];
  return rows
    .map((r, i) => ({ r, i, v: get(r) }))
    .sort((p, q) => {
      if (empty(p.v) && empty(q.v)) return p.i - q.i;
      if (empty(p.v)) return 1;
      if (empty(q.v)) return -1;
      const c = compareSortValues(p.v, q.v);
      return (dir === "asc" ? c : -c) || p.i - q.i;
    })
    .map((x) => x.r);
}

export function nextSort(cur: SortState | null, key: string): SortState {
  return cur?.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

/** Sort state and sorted rows for a list; `by` names each sortable column's value. */
export function useSort<T>(rows: readonly T[], by: Record<string, (r: T) => SortValue>, initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const sorted = useMemo(() => (sort ? sortRows(rows, by[sort.key], sort.dir) : [...rows]), [rows, sort, by]);
  return { rows: sorted, sort, toggle: (key: string) => setSort((s) => nextSort(s, key)) };
}

/** A column heading that sorts the list when clicked. */
export function SortTh({ k, sort, onSort, children, ...th }: { k: string; sort: SortState | null; onSort: (key: string) => void; children: ReactNode } & ThHTMLAttributes<HTMLTableCellElement>) {
  const on = sort?.key === k;
  return (
    <th scope="col" aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"} {...th}>
      <button type="button" className={`sortbtn${on ? " on" : ""}`} onClick={() => onSort(k)} title={on ? `Sorted ${sort!.dir === "asc" ? "ascending" : "descending"}: click to reverse` : "Sort by this column"}>
        <span>{children}</span>
        <Icon name={on ? (sort!.dir === "asc" ? "arrowUp" : "arrowDown") : "arrowDown"} size={12} strokeWidth={2.5} className="sortico" />
      </button>
    </th>
  );
}
