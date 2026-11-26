"use client";

import Link from "next/link";
import { C } from "@/components/design/tokens";
import { SortTh, useSort, type SortValue } from "@/components/design/sort";
import type { listKnowledge } from "@/server/services/knowledge-admin";

type Row = Awaited<ReturnType<typeof listKnowledge>>["rows"][number];

const tone: Record<string, string> = { CURRENT: "ok", DRAFT: "wait", SUPERSEDED: "neutral", WITHDRAWN: "gap" };
const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));

/** The knowledge base's documents; each column heading sorts the list. */
export function KnowledgeTable({ rows, categoryLabel, statusLabel }: { rows: Row[]; categoryLabel: Record<string, string>; statusLabel: Record<string, string> }) {
  const by: Record<string, (r: Row) => SortValue> = {
    title: (r) => r.title,
    kind: (r) => categoryLabel[r.category] ?? r.category,
    version: (r) => r.version,
    sections: (r) => r.sections,
    status: (r) => statusLabel[r.status] ?? r.status,
    updated: (r) => new Date(r.updatedAt),
  };
  const { rows: shown, sort, toggle } = useSort(rows, by);
  return (
    <table className="table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
      <thead>
        <tr>
          <SortTh k="title" sort={sort} onSort={toggle} style={{ textAlign: "left", padding: "10px 16px" }}>Document</SortTh>
          <SortTh k="kind" sort={sort} onSort={toggle} style={{ textAlign: "left", padding: "10px 12px" }}>Kind</SortTh>
          <SortTh k="version" sort={sort} onSort={toggle} style={{ textAlign: "left", padding: "10px 12px" }}>Version</SortTh>
          <SortTh k="sections" sort={sort} onSort={toggle} style={{ textAlign: "right", padding: "10px 12px" }}>Sections</SortTh>
          <SortTh k="status" sort={sort} onSort={toggle} style={{ textAlign: "left", padding: "10px 12px" }}>Status</SortTh>
          <SortTh k="updated" sort={sort} onSort={toggle} style={{ textAlign: "left", padding: "10px 16px" }}>Updated</SortTh>
        </tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.id} style={{ borderTop: `1px solid ${C.lineSoft}` }}>
            <td style={{ padding: "12px 16px", minWidth: 280 }}>
              <Link href={`/developer/knowledge/${r.id}`} style={{ fontWeight: 500, color: "inherit" }} className="rowlink">
                {r.title}
              </Link>
              <div className="mut" style={{ fontSize: 13 }}>
                {r.issuingBody}
                {r.replaces ? ` · replaces ${r.replaces}` : ""}
                {r.isSynthetic ? " · illustrative" : ""}
              </div>
            </td>
            <td style={{ padding: "12px" }}>{categoryLabel[r.category]}</td>
            <td style={{ padding: "12px", whiteSpace: "nowrap" }}>
              {r.version}
              <div className="mut" style={{ fontSize: 13 }}>from {day(r.effectiveFrom)}</div>
            </td>
            <td style={{ padding: "12px", textAlign: "right" }}>{r.sections}</td>
            <td style={{ padding: "12px" }}>
              <span className={`pill ${tone[r.status] ?? "neutral"}`}>{statusLabel[r.status] ?? r.status}</span>
            </td>
            <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>{day(r.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
