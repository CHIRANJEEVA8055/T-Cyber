import type { Metadata } from "next";
import Link from "next/link";
import { requireDeveloper } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { AUDIT_KINDS, listSystemAudit } from "@/server/services/system-audit";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";

export const metadata: Metadata = { title: "Audit log" };

/** Developer console › Audit log (pattern: inbox / activity feed): knowledge-base changes, assistant use and sign-ins. */
export default async function AuditPage({ searchParams }: { searchParams: Promise<{ kind?: string; q?: string; page?: string }> }) {
  const user = await requireDeveloper();
  const sp = await searchParams;
  const a = await listSystemAudit(getDb(), user, { kind: sp.kind, q: sp.q, page: Number(sp.page ?? 1) });
  const href = (p: { kind?: string; page?: number }) => {
    const s = new URLSearchParams();
    const kind = p.kind ?? a.kind;
    if (kind !== "ALL") s.set("kind", kind);
    if (a.q) s.set("q", a.q);
    if ((p.page ?? 1) > 1) s.set("page", String(p.page));
    return `/developer/audit${s.toString() ? `?${s}` : ""}`;
  };
  return (
    <div className="dashpad" style={{ padding: "32px 40px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 className="h" style={{ fontSize: 28, margin: 0 }}>Audit Log</h1>
        <p className="sec" style={{ margin: "6px 0 0", maxWidth: "70ch" }}>Knowledge-base and ready-question changes, use of the assistants and sign-ins. Events tied to a case show which case and what kind of event, never its contents.</p>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
          <nav className="row" aria-label="Kind of event" style={{ gap: 4, flexWrap: "wrap" }}>
            {Object.entries(AUDIT_KINDS).map(([k, label]) => (
              <Link key={k} className={`tab${a.kind === k ? " on" : ""}`} href={href({ kind: k })} aria-current={a.kind === k ? "page" : undefined} style={{ minHeight: 36, padding: "0 12px", display: "inline-flex", alignItems: "center", borderRadius: 8 }}>
                {label}
              </Link>
            ))}
          </nav>
          <form action="/developer/audit" method="get" className="row" style={{ gap: 8 }}>
            {a.kind !== "ALL" ? <input type="hidden" name="kind" value={a.kind} /> : null}
            <label className="srt" htmlFor="aq">Search the audit log</label>
            <span style={{ position: "relative" }}>
              <Icon name="search" size={16} style={{ position: "absolute", left: 12, top: 12, color: C.mut }} />
              <input id="aq" className="input" name="q" defaultValue={a.q} placeholder="Search the audit log" style={{ minHeight: 40, paddingLeft: 36, width: 260 }} />
            </span>
            <button className="btn sm" type="submit">Search</button>
          </form>
        </div>
        {a.rows.length ? (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {a.rows.map((r) => (
              <li key={r.id} className="row" style={{ gap: 16, padding: "12px 20px", borderTop: `1px solid ${C.lineSoft}`, alignItems: "flex-start" }}>
                <span className="mut" style={{ fontSize: 13, minWidth: 150, whiteSpace: "nowrap" }}>{r.when}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block" }}>{r.summary}</span>
                  <span className="mut" style={{ fontSize: 13 }}>
                    {r.who} · {r.action}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div style={{ padding: "28px 20px", display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <strong>No events match</strong>
            <span className="mut">Try another kind of event or fewer words.</span>
            <Link className="btn sm" href="/developer/audit">Clear all filters</Link>
          </div>
        )}
        <div className="row" style={{ justifyContent: "space-between", padding: "12px 20px", borderTop: `1px solid ${C.line}` }}>
          <span className="mut" style={{ fontSize: 13 }}>
            {a.total} {a.total === 1 ? "event" : "events"} · page {a.page} of {a.pages}
          </span>
          <span className="row" style={{ gap: 8 }}>
            {a.page > 1 ? <Link className="btn sm" href={href({ page: a.page - 1 })}>Previous page</Link> : <span className="btn sm" aria-disabled="true" style={{ opacity: 0.5 }}>Previous page</span>}
            {a.page < a.pages ? <Link className="btn sm" href={href({ page: a.page + 1 })}>Next page</Link> : <span className="btn sm" aria-disabled="true" style={{ opacity: 0.5 }}>Next page</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
