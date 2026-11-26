import type { Metadata } from "next";
import Link from "next/link";
import { requireDeveloper } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { CATEGORY_LABEL, STATUS_LABEL, listKnowledge } from "@/server/services/knowledge-admin";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { KnowledgeTable } from "@/features/developer/components/knowledge-table";

export const metadata: Metadata = { title: "Knowledge base" };

const TABS = [
  ["ALL", "All"],
  ["CURRENT", "Current"],
  ["DRAFT", "Drafts"],
  ["SUPERSEDED", "Superseded"],
  ["WITHDRAWN", "Retired"],
] as const;

/** Developer console › Knowledge base (pattern: list / index). */
export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const user = await requireDeveloper();
  const sp = await searchParams;
  const status = TABS.some(([k]) => k === sp.status) ? sp.status! : "ALL";
  const { rows, counts } = await listKnowledge(getDb(), user, { status, q: sp.q });
  const href = (s: string) => `/developer/knowledge?status=${s}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`;
  return (
    <div className="dashpad" style={{ padding: "32px 40px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 className="h" style={{ fontSize: 28, margin: 0 }}>Knowledge Base</h1>
          <p className="sec" style={{ margin: "6px 0 0", maxWidth: "70ch" }}>
            The documents the procedure assistant answers from. Only current documents are answered from; drafts wait for you to check them, and superseded ones are shown only as history.
          </p>
        </div>
        <Link className="btn primary" href="/developer/knowledge/new">
          <Icon name="upload" size={16} /> Upload a document
        </Link>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
          <nav className="row" aria-label="Status" style={{ gap: 4, flexWrap: "wrap" }}>
            {TABS.map(([k, label]) => (
              <Link key={k} className={`tab${status === k ? " on" : ""}`} href={href(k)} aria-current={status === k ? "page" : undefined} style={{ minHeight: 36, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 8 }}>
                {label} <span className="mut">{counts[k as keyof typeof counts]}</span>
              </Link>
            ))}
          </nav>
          <form action="/developer/knowledge" method="get" className="row" style={{ gap: 8 }}>
            <input type="hidden" name="status" value={status} />
            <label className="srt" htmlFor="kq">Search documents</label>
            <span style={{ position: "relative" }}>
              <Icon name="search" size={16} style={{ position: "absolute", left: 12, top: 12, color: C.mut }} />
              <input id="kq" className="input" name="q" defaultValue={sp.q ?? ""} placeholder="Search documents" style={{ minHeight: 40, paddingLeft: 36, width: 260 }} />
            </span>
            <button className="btn sm" type="submit">Search</button>
          </form>
        </div>
        {rows.length ? (
          <div style={{ overflowX: "auto" }}>
            <KnowledgeTable rows={rows} categoryLabel={CATEGORY_LABEL} statusLabel={STATUS_LABEL} />
          </div>
        ) : (
          <div style={{ padding: "32px 20px", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <strong>{sp.q || status !== "ALL" ? "No documents match" : "No documents yet"}</strong>
            <span className="mut">{sp.q || status !== "ALL" ? "Try another status or fewer words." : "Upload the station's SOPs, circulars and guides for the assistant to answer from."}</span>
            {sp.q || status !== "ALL" ? (
              <Link className="btn sm" href="/developer/knowledge">Clear all filters</Link>
            ) : (
              <Link className="btn sm primary" href="/developer/knowledge/new">Upload a document</Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
