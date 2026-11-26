import Link from "next/link";
import { isValidElement, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SortValue } from "@/components/design/sort";
import { DataTableClient } from "./data-table-client";

/**
 * What a drawn cell sorts by, read from what it shows: its text, a date's instant (`iso`), an amount (`minor`), a
 * status (`value`) or a record's label (`node.label`). A cell with nothing readable sorts as empty (last).
 */
const hiddenHeader = (h: ReactNode) => h === null || h === undefined || h === "" || (isValidElement(h) && typeof (h.props as { className?: unknown }).className === "string" && /\bsr-only\b/.test((h.props as { className: string }).className));

export function cellSortValue(n: ReactNode, depth = 0): SortValue {
  if (n === null || n === undefined || typeof n === "boolean" || depth > 12) return null;
  if (typeof n === "string") return n.trim() || null;
  if (typeof n === "number" || typeof n === "bigint") return n;
  if (Array.isArray(n)) {
    const parts = n.map((x) => cellSortValue(x as ReactNode, depth + 1)).filter((x) => x !== null && x !== "");
    if (parts.length === 1) return parts[0]!;
    return parts.length ? parts.map((x) => (x instanceof Date ? x.toISOString() : String(x))).join(" ") : null;
  }
  if (isValidElement(n)) {
    const p = (n.props ?? {}) as Record<string, unknown>;
    if (typeof p.iso === "string" && p.iso) {
      const d = new Date(p.iso);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (p.iso === null) return null;
    if (typeof p.minor === "bigint" || typeof p.minor === "number") return p.minor;
    if (typeof p.minor === "string" && /^-?\d+$/.test(p.minor)) return BigInt(p.minor);
    if (typeof p.value === "string" && p.children === undefined) return typeof p.label === "string" && p.label ? p.label : p.value;
    const node = p.node as { label?: unknown } | undefined;
    if (node && typeof node.label === "string") return node.label;
    // Screen-reader-only text is not what the column shows.
    if (typeof p.className === "string" && /\bsr-only\b/.test(p.className)) return null;
    return cellSortValue(p.children as ReactNode, depth + 1);
  }
  return null;
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  className?: string;
  /** Hide on narrow screens when the information is available elsewhere. */
  hideBelow?: "md" | "lg";
  /** What the column sorts by when its heading is clicked; without it, it sorts by what the cell shows (see cellSortValue). */
  sortValue?: (row: T) => SortValue;
  /** Set false for a column that should not sort (an actions column). */
  sortable?: boolean;
}

/**
 * Records table on an L1 surface with hairline row dividers. The table scrolls inside its own
 * container so the page never scrolls horizontally. When `rowHref` is given, the first cell holds
 * the row's link and the whole row is clickable (one focusable link per row).
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  caption,
  empty,
  className,
  minWidth = 720,
  dense,
  rowClassName,
  mobileCard,
  cardBelow = "md",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  caption: string;
  empty?: ReactNode;
  className?: string;
  minWidth?: number;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
  /** Narrow screens (< 768px): render each row as a stacked card instead of a horizontally scrolling table. */
  mobileCard?: (row: T) => ReactNode;
  /** Breakpoint below which mobileCard is used (default md = 768px). */
  cardBelow?: "md" | "lg";
}) {
  const hide = (c: Column<T>) => (c.hideBelow === "md" ? "hidden md:table-cell" : c.hideBelow === "lg" ? "hidden lg:table-cell" : "");
  return (
    <div className={cn("panel overflow-hidden", className)}>
      {mobileCard && rows.length > 0 ? (
        <ul className={cn("divide-y divide-line", cardBelow === "lg" ? "lg:hidden" : "md:hidden")} aria-label={caption}>
          {rows.map((row) => {
            const href = rowHref?.(row);
            return (
              <li key={rowKey(row)} className="relative">
                {href ? (
                  <Link href={href} className="group flex items-start gap-3 px-4 py-3.5 outline-none hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)]">
                    <span className="block min-w-0 flex-1">{mobileCard(row)}</span>
                    {/* Resting affordance: the whole card opens the record. */}
                    <ChevronRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-3 group-hover:text-action" />
                  </Link>
                ) : (
                  <div className="px-4 py-3.5">{mobileCard(row)}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className={cn("overflow-x-auto", mobileCard && rows.length > 0 && (cardBelow === "lg" ? "hidden lg:block" : "hidden md:block"))}>
        <DataTableClient
          caption={caption}
          minWidth={minWidth}
          columns={columns.map((c, i) => ({
            key: c.key,
            header: c.header,
            className: cn("relative whitespace-nowrap px-3 py-2.5 text-label font-medium text-ink-2 first:pl-4 last:pr-4", c.align === "right" && "text-right tabular-nums", hide(c), c.className),
            // A column with no visible heading (row actions, a details button) does not sort.
            sortable: c.sortable !== false && rows.length > 1 && !hiddenHeader(c.header) && (!!c.sortValue || (i >= 0 && rows.some((r) => cellSortValue(c.cell(r)) !== null))),
          }))}
          rows={rows.map((row) => {
            const href = rowHref?.(row);
            return {
              key: rowKey(row),
              className: cn("group border-b border-line last:border-b-0", href && "relative cursor-pointer hover:bg-surface-muted focus-within:bg-surface-muted", rowClassName?.(row)),
              sort: columns.map((c) => (c.sortValue ? c.sortValue(row) : cellSortValue(c.cell(row)))),
              cells: columns.map((c, i) => ({
                className: cn("px-3 align-top text-body text-ink first:pl-4 last:pr-4", dense ? "py-2.5" : "py-3", c.align === "right" && "text-right tabular-nums", hide(c), c.className),
                // Resting affordance: the first cell is a link in the action colour; the whole row is its hit area.
                node:
                  href && i === 0 ? (
                    <Link href={href} className="font-medium text-action outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-[var(--color-focus)] group-hover:underline">
                      {c.cell(row)}
                    </Link>
                  ) : (
                    c.cell(row)
                  ),
              })),
            };
          })}
        />
      </div>
      {rows.length === 0 ? empty : null}
    </div>
  );
}
