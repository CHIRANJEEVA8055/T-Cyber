"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import type { NodalList } from "@/server/services/nodal";
import { addNodalRecipientAction } from "../nodal-actions";

/** Settings › Nodal officers (pattern: list / index). Search, filter by type, and — for a supervisor — add an address to the recipient directory. */
export function NodalView({ data, q, type, canAdd }: { data: NodalList; q: string; type: string; canAdd: boolean }) {
  const [added, setAdded] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const href = (p: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams();
    const next = { q, type, page: 1, sort: data.sort ?? undefined, dir: data.sort ? data.dir : undefined, ...p };
    if (next.q) sp.set("q", String(next.q));
    if (next.type && next.type !== "ALL") sp.set("type", String(next.type));
    if (next.sort) sp.set("sort", String(next.sort));
    if (next.sort && next.dir === "desc") sp.set("dir", "desc");
    if (Number(next.page) > 1) sp.set("page", String(next.page));
    const s = sp.toString();
    return `/settings/nodal${s ? `?${s}` : ""}`;
  };
  const filtered = !!q || (type && type !== "ALL");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <form className="row" action="/settings/nodal" method="get" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        {data.sort ? <input type="hidden" name="sort" value={data.sort} /> : null}
        {data.sort && data.dir === "desc" ? <input type="hidden" name="dir" value="desc" /> : null}
        <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 320px" }}>
          <span className="lbl">Search</span>
          <span style={{ position: "relative", display: "block" }}>
            <Icon name="search" size={16} style={{ position: "absolute", left: 12, top: 12, color: C.mut }} />
            <input className="input" name="q" defaultValue={q} placeholder="HDFC Bank, Telegram, ddgterm…" style={{ minHeight: 40, paddingLeft: 36 }} />
          </span>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "0 1 260px" }}>
          <span className="lbl">Type</span>
          <select className="input" name="type" defaultValue={type || "ALL"} style={{ minHeight: 40 }}>
            <option value="ALL">All types ({data.all})</option>
            {data.types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type} ({t.count})
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="submit" style={{ minHeight: 40 }}>
          Search
        </button>
        {filtered ? (
          <Link className="btn" href="/settings/nodal" style={{ minHeight: 40 }}>
            Clear all filters
          </Link>
        ) : null}
      </form>
      {error ? (
        <div className="banner" role="alert" style={{ display: "flex", gap: 10, padding: "12px 14px", borderRadius: 10, border: `1px solid ${C.lineStrong}` }}>
          <Icon name="alertCircle" size={18} />
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn sm" type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="row" style={{ justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${C.line}`, gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 500 }}>
            {data.total} {data.total === 1 ? "contact" : "contacts"}
            {filtered ? ` of ${data.all}` : ""}
          </span>
          <span className="mut" style={{ fontSize: 13 }}>
            {data.source ? `From ${data.source}` : "No list imported yet"}
          </span>
        </div>
        {data.rows.length ? (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  {([["provider", "Provider", "10px 20px"], ["officer", "Nodal officer", "10px 12px"], ["email", "Email", "10px 12px"], ["phone", "Phone", "10px 12px"]] as const).map(([k, label, pad]) => {
                    const on = data.sort === k;
                    const dir = on && data.dir === "asc" ? "desc" : "asc";
                    return (
                      <th key={k} scope="col" aria-sort={on ? (data.dir === "asc" ? "ascending" : "descending") : "none"} style={{ textAlign: "left", padding: pad }}>
                        <Link className={`sortbtn${on ? " on" : ""}`} href={href({ sort: k, dir })} scroll={false} title={on ? `Sorted ${data.dir === "asc" ? "ascending" : "descending"}: click to reverse` : "Sort by this column"}>
                          <span>{label}</span>
                          <Icon name={on && data.dir === "asc" ? "arrowUp" : "arrowDown"} size={12} strokeWidth={2.5} className="sortico" />
                        </Link>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${C.lineSoft}`, verticalAlign: "top" }}>
                    <td style={{ padding: "12px 20px", minWidth: 200 }}>
                      <div style={{ fontWeight: 500 }}>{r.provider}</div>
                      <div className="mut" style={{ fontSize: 13 }}>{r.serviceType}</div>
                    </td>
                    <td style={{ padding: "12px", minWidth: 160 }}>
                      {r.officerName ?? <span className="mut">Not named</span>}
                      {r.address ? <div className="mut" style={{ fontSize: 13, whiteSpace: "pre-line", marginTop: 4, maxWidth: 280 }}>{r.address.slice(0, 160)}</div> : null}
                    </td>
                    <td style={{ padding: "12px", minWidth: 240 }}>
                      {r.emails.length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {r.emails.map((e) => (
                            <div key={e} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                              <span style={{ wordBreak: "break-all" }}>{e}</span>
                              {canAdd ? (
                                added[`${r.id}:${e}`] ? (
                                  <span className="pill ok">Added, unverified</span>
                                ) : (
                                  <button
                                    className="btn sm"
                                    type="button"
                                    disabled={pending}
                                    onClick={() =>
                                      start(async () => {
                                        setError(null);
                                        const res = await addNodalRecipientAction(r.id, e);
                                        if (res.ok) setAdded((a) => ({ ...a, [`${r.id}:${e}`]: res.data.id }));
                                        else setError(res.error);
                                      })
                                    }
                                  >
                                    Add to the recipient directory
                                  </button>
                                )
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="mut">No email listed</span>
                      )}
                    </td>
                    <td style={{ padding: "12px", whiteSpace: "nowrap" }}>{r.phones.length ? r.phones.join(", ") : <span className="mut">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: "32px 20px", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <strong>{filtered ? "No contacts match the search" : "No nodal officer list yet"}</strong>
            <span className="mut">{filtered ? "Try fewer words, or another type." : "Import the CrimeOS nodal officer list (npm run nodal:import) to look up who to write to at a bank or provider."}</span>
            {filtered ? (
              <Link className="btn sm" href="/settings/nodal">
                Clear all filters
              </Link>
            ) : null}
          </div>
        )}
        <div className="row" style={{ justifyContent: "space-between", padding: "12px 20px", borderTop: `1px solid ${C.line}`, gap: 12 }}>
          <span className="mut" style={{ fontSize: 13 }}>
            Page {data.page} of {data.pages}
          </span>
          <span className="row" style={{ gap: 8 }}>
            {data.page > 1 ? (
              <Link className="btn sm" href={href({ page: data.page - 1 })}>
                Previous page
              </Link>
            ) : (
              <span className="btn sm" aria-disabled="true" style={{ opacity: 0.5 }}>
                Previous page
              </span>
            )}
            {data.page < data.pages ? (
              <Link className="btn sm" href={href({ page: data.page + 1 })}>
                Next page
              </Link>
            ) : (
              <span className="btn sm" aria-disabled="true" style={{ opacity: 0.5 }}>
                Next page
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
