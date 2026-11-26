"use client";

import type { ReactNode } from "react";
import { sortRows, nextSort, type SortState, type SortValue } from "@/components/design/sort";
import { Icon } from "@/components/ui/icon";
import { useState } from "react";
import { cn } from "@/lib/cn";

/** The sortable part of DataTable: headings that sort, and rows whose cells were already drawn. */
export interface ClientColumn {
  key: string;
  header: ReactNode;
  className: string;
  sortable: boolean;
}
export interface ClientRow {
  key: string;
  className: string;
  cells: { node: ReactNode; className: string }[];
  sort: SortValue[];
}

export function DataTableClient({ caption, columns, rows, minWidth }: { caption: string; columns: ClientColumn[]; rows: ClientRow[]; minWidth: number }) {
  const [sort, setSort] = useState<SortState | null>(null);
  const at = sort ? columns.findIndex((c) => c.key === sort.key) : -1;
  const shown = sort && at >= 0 ? sortRows(rows, (r) => r.sort[at], sort.dir) : rows;
  return (
    <table className="w-full border-collapse text-left" style={{ minWidth: rows.length ? minWidth : undefined }}>
      <caption className="sr-only">{caption}</caption>
      {/* Header cells are positioned so sr-only labels stay inside the scroll container instead of widening the page. */}
      <thead className="bg-surface-muted">
        <tr className="border-b border-line">
          {columns.map((c) => {
            const on = sort?.key === c.key;
            return (
              <th key={c.key} scope="col" aria-sort={c.sortable ? (on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none") : undefined} className={c.className}>
                {c.sortable && rows.length > 1 ? (
                  <button type="button" className={cn("sortbtn", on && "on")} onClick={() => setSort((s) => nextSort(s, c.key))} title={on ? `Sorted ${sort!.dir === "asc" ? "ascending" : "descending"}: click to reverse` : "Sort by this column"}>
                    <span>{c.header}</span>
                    <Icon name={on && sort!.dir === "asc" ? "arrowUp" : "arrowDown"} size={12} strokeWidth={2.5} className="sortico" />
                  </button>
                ) : (
                  c.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.key} className={r.className}>
            {r.cells.map((cell, i) => (
              <td key={columns[i]!.key} className={cell.className}>
                {cell.node}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
