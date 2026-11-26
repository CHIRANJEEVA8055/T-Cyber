"use client";

import { useEffect, useMemo } from "react";
import { cn } from "@/lib/cn";

export interface Segment {
  page: number | null;
  line: number | null;
  row: number | null;
  text: string;
  method: string;
}

export interface Highlight {
  page?: number | null;
  line?: number | null;
  row?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
}

function same(h: Highlight | null, s: Segment) {
  if (!h) return false;
  if (h.row) return s.row === h.row;
  if (h.line) return s.line === h.line && (h.page ? s.page === h.page : true);
  return false;
}

/**
 * Extracted text shown exactly as parsed, with page and line (or row) numbers matching the source
 * references used everywhere else. The highlighted location scrolls into view.
 */
export function DocumentViewer({ segments, highlight, idPrefix = "seg", className }: { segments: Segment[]; highlight: Highlight | null; idPrefix?: string; className?: string }) {
  const isTable = segments.some((s) => s.method === "CSV_ROW");
  const pages = useMemo(() => {
    const map = new Map<number | null, Segment[]>();
    for (const s of segments) map.set(s.page, [...(map.get(s.page) ?? []), s]);
    return [...map.entries()];
  }, [segments]);
  const key = highlight ? `${highlight.page ?? ""}-${highlight.line ?? ""}-${highlight.row ?? ""}` : "";

  useEffect(() => {
    if (!highlight) return;
    const id = highlight.row ? `${idPrefix}-row-${highlight.row}` : `${idPrefix}-p${highlight.page ?? 0}-l${highlight.line}`;
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [key, highlight, idPrefix]);

  if (segments.length === 0) return null;
  if (isTable) {
    return (
      <div className={cn("overflow-x-auto rounded-[var(--radius-control)] border border-line", className)}>
        <table className="w-full min-w-[640px] border-collapse text-left text-label">
          <caption className="sr-only">Parsed table with source row numbers</caption>
          <tbody>
            {segments.map((s) => (
              <tr key={s.row} id={`${idPrefix}-row-${s.row}`} className={cn("border-b border-line last:border-b-0", s.row === 1 && "bg-surface-muted font-medium", same(highlight, s) && "bg-warning-tint")}>
                <th scope="row" className="w-10 px-2 py-1.5 text-right font-normal text-ink-3">
                  {s.row}
                  {same(highlight, s) ? <span className="sr-only"> (cited row)</span> : null}
                </th>
                {s.text.split(" | ").map((cell, i) => (
                  <td key={i} className="whitespace-nowrap px-2 py-1.5 text-ink">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {pages.map(([page, lines]) => (
        <section key={page ?? "text"} aria-label={page ? `Page ${page}` : "Text"} className="rounded-[var(--radius-control)] border border-line">
          {page ? <h3 className="border-b border-line bg-surface-muted px-3 py-1.5 text-label font-medium text-ink-2">Page {page}</h3> : null}
          <ol className="px-2 py-2 font-mono text-label leading-relaxed text-ink">
            {lines.map((s) => {
              const hl = same(highlight, s);
              const start = hl && highlight?.charStart != null ? highlight.charStart : null;
              const end = hl && highlight?.charEnd != null ? highlight.charEnd : null;
              return (
                <li key={`${s.page}-${s.line}`} id={`${idPrefix}-p${s.page ?? 0}-l${s.line}`} className={cn("grid grid-cols-[2.25rem_1fr] gap-2 rounded-[2px] px-1", hl && "bg-warning-tint")}>
                  <span aria-hidden="true" className="select-none text-right text-ink-3">
                    {s.line}
                  </span>
                  <span className="whitespace-pre-wrap break-words">
                    {hl ? <span className="sr-only">Cited line: </span> : null}
                    {start !== null && end !== null ? (
                      <>
                        {s.text.slice(0, start)}
                        <mark className="rounded-[2px] bg-[#f5d48a] px-0.5 text-ink">{s.text.slice(start, end)}</mark>
                        {s.text.slice(end)}
                      </>
                    ) : (
                      s.text
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
