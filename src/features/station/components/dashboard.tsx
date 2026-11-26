"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DateRangeFilter, rangeLabel, type DateRange } from "@/components/design/date-range";
import { SortTh, useSort, type SortValue } from "@/components/design/sort";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import { formatInr } from "@/domain/money";
import type { DashboardData, DrillGroup, DrillRow, FraudType } from "@/server/services/dashboard";
import { MO_VERTICALS } from "@/domain/mo-verticals";
import type { RepliesInbox } from "@/server/services/station-feed";
import type { StandingStatus } from "@/domain/standing";
import type { HomeLabels } from "../labels";
import { ColumnChart, MultiLineChart, PieChart } from "./charts";
import { NewFirWindow } from "./new-fir-window";

export type DashTab = "mine" | "station" | "action" | "closed" | "trends";

interface Filters {
  status: Record<StandingStatus, boolean>;
  type: Record<FraudType, boolean>;
  held: "any" | "yes" | "no";
  age: "any" | "week" | "month" | "old";
}
const F0: Filters = { status: { action: true, waiting: true, hold: true, done: true }, type: { INVESTMENT: true, ADVERTISEMENT: true, JOB: true, BUSINESS: true, OTP: true, SOCIAL_MEDIA: true, MISC: true, NONE: true }, held: "any", age: "any" };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayMonth(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 330 * 60 * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]}`;
}
function dayMonthTime(iso: string) {
  const d = new Date(new Date(iso).getTime() + 330 * 60 * 1000);
  return `${dayMonth(iso)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
const inr = (minor: string) => formatInr(BigInt(minor));
const DRILL_SORT: Record<string, (r: DrillRow) => SortValue> = { a: (r) => r.a, b: (r) => r.b, c: (r) => r.cs ?? r.c, d: (r) => r.ds ?? r.d };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function Dashboard({ data, inbox, L, lang, ranges, initialTab, openReplies, openFir }: { data: DashboardData; inbox: RepliesInbox; L: HomeLabels; lang: "en" | "te"; ranges: { kpi: DateRange | null; trends: DateRange | null }; initialTab: DashTab; openReplies: boolean; openFir: { open: boolean; ack: string | null } }) {
  const router = useRouter();
  const [tab, setTabState] = useState<DashTab>(initialTab);
  const [sq, setSq] = useState("");
  const [fl, setFl] = useState<Filters>(F0);
  const [popOpen, setPopOpen] = useState(false);
  const [repOpen, setRepOpen] = useState(openReplies);
  const [trKey, setTrKey] = useState<string | null>(null);
  const [fir, setFir] = useState(openFir);

  /** The page's address: the tab and any date filters, so a reload keeps them. */
  const address = (t: DashTab, r: { kpi: DateRange | null; trends: DateRange | null }) => {
    const q = new URLSearchParams();
    if (t !== "mine") q.set("tab", t);
    if (r.kpi) {
      q.set("kfrom", r.kpi.from);
      q.set("kto", r.kpi.to);
    }
    if (r.trends) {
      q.set("tfrom", r.trends.from);
      q.set("tto", r.trends.to);
    }
    return q.size ? `/?${q}` : "/";
  };
  const setTab = (t: DashTab) => {
    setTabState(t);
    setPopOpen(false);
    window.history.replaceState(null, "", address(t, ranges));
  };
  // A date filter reloads the figures for that period from the server.
  const setRange = (which: "kpi" | "trends", r: DateRange | null) => router.push(address(tab, { ...ranges, [which]: r }), { scroll: false });

  const loaded = tab === "mine" ? data.rows.filter((r) => r.mine) : data.rows;
  const q = sq.trim().toLowerCase();
  const shown = loaded.filter(
    (r) =>
      fl.status[r.status] &&
      fl.type[r.type] &&
      (fl.held === "any" || (fl.held === "yes") === BigInt(r.heldMinor) > 0n) &&
      (fl.age === "any" || (fl.age === "week" && r.ageDays <= 7) || (fl.age === "month" && r.ageDays <= 30) || (fl.age === "old" && r.ageDays > 30)) &&
      (q === "" || r.search.includes(q)),
  );
  const closedShown = data.closed.filter((r) => q === "" || r.search.includes(q));
  const actionShown = data.actions.filter((a) => q === "" || `${a.fir} ${a.kindLabel} ${a.what} ${a.why}`.toLowerCase().includes(q));
  // Every list sorts by any of its columns (click a heading; click again to reverse).
  const firKey = (fir: string) => {
    const [n, y] = fir.split("/");
    return Number(y ?? 0) * 100000 + Number(n ?? 0);
  };
  const caseSort = useSort(shown, { fir: (r) => firKey(r.fir), officer: (r) => r.officer, registered: (r) => r.registeredAt, lost: (r) => BigInt(r.lostMinor), held: (r) => BigInt(r.heldMinor), stands: (r) => r.pill.text });
  const actionSort = useSort(actionShown, { fir: (a) => firKey(a.fir), what: (a) => a.what, why: (a) => a.why, when: (a) => a.when.text });
  const closedSort = useSort(closedShown, { fir: (r) => firKey(r.fir), complainant: (r) => r.complainant, closed: (r) => r.closedAt, lost: (r) => BigInt(r.lostMinor), returned: (r) => BigInt(r.returnedMinor), outcome: (r) => r.outcome.text });
  const off = (o: Record<string, boolean>) => Object.values(o).filter((v) => !v).length;
  const activeFilters = (off(fl.status) ? 1 : 0) + (off(fl.type) ? 1 : 0) + (fl.held !== "any" ? 1 : 0) + (fl.age !== "any" ? 1 : 0);
  const isCases = tab === "mine" || tab === "station";
  const filterLabel = activeFilters ? `Filter cases, ${activeFilters} ${activeFilters === 1 ? "filter" : "filters"} on` : "Filter cases";

  const listTitle = { mine: L.myCases, station: L.allCases, action: L.actionT, closed: L.closedT, trends: L.trendsT }[tab];
  const footCount =
    tab === "trends"
      ? null
      : tab === "action"
        ? `${plural(actionShown.length, "action")} across ${plural(new Set(actionShown.map((a) => a.caseId)).size, "case")}${q ? ` · search “${sq.trim()}”` : ""}`
        : tab === "closed"
            ? `Showing ${closedShown.length} of ${data.closed.length} closed this year`
            : activeFilters || q
              ? `Showing ${shown.length} of ${loaded.length} loaded${activeFilters ? ` · ${plural(activeFilters, "filter")} on` : ""}${q ? ` · search “${sq.trim()}”` : ""}`
              : `Showing ${shown.length} of ${loaded.length}`;

  const groups: Record<string, { title: string; cols: [string, string, string, string]; group: DrillGroup }> = useMemo(() => {
    const out: Record<string, { title: string; cols: [string, string, string, string]; group: DrillGroup }> = {};
    for (const g of data.trends.requests.groups) out[g.key] = { title: "Requests by status", cols: ["Request", "About", "Asked", "Where it stands"], group: g };
    for (const g of data.trends.kinds.groups) out[g.key] = { title: "Types of fraud", cols: ["FIR or complaint", "Complainant", "Received", "Amount Lost"], group: g };
    for (const g of data.trends.stages.groups) out[g.key] = { title: "Cases by status", cols: ["FIR", "Complainant", "Registered", "Where it stands"], group: g };
    const per = data.trends.months.byDay ? "by day" : "by month";
    for (const g of data.trends.months.groups) out[g.key] = { title: `Amount lost, ${per}`, cols: ["FIR or complaint", "Complainant", "Amount Lost", "Held"], group: g };
    for (const g of data.trends.months.poh) out[g.key] = { title: `Put on hold, ${per}`, cols: ["FIR or complaint", "Bank reference", "Held on", "Amount held"], group: g };
    for (const g of data.trends.months.firs) out[g.key] = { title: `FIRs registered, ${per}`, cols: ["FIR", "Complainant", "Registered", "Where it stands"], group: g };
    return out;
  }, [data.trends]);
  const tr = trKey ? groups[trKey] : null;
  // Dates and amounts sort by their value (cs, ds), not as text ("₹1,00,000" after "₹70,000").
  const drillSort = useSort(tr?.group.rows ?? [], DRILL_SORT);

  const tabBtn = (t: DashTab, label: string, count?: number, color?: string) => (
    <button className={`tab${tab === t ? " on" : ""}`} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
      {label}
      {count !== undefined && (
        <span className={color ? "num" : "num mut"} style={color ? { color } : undefined}>
          {count}
        </span>
      )}
    </button>
  );

  return (
    <div className="dashpad" style={{ padding: "32px 40px", display: "flex", flexDirection: "column", gap: 24, maxWidth: 1240, width: "100%", boxSizing: "border-box" }}>
      <div className="pagehead">
        <div style={{ minWidth: 0 }}>
          <h1 className="h" style={{ fontSize: 28 }}>
            {L.hello}
          </h1>
          <p className="sec" style={{ margin: "8px 0 0", fontSize: 15 }}>
            {L.helloSub}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" type="button" aria-label={`${L.inbox}, ${plural(inbox.total, "reply", "replies")}`} aria-expanded={repOpen} onClick={() => setRepOpen(true)} style={{ position: "relative" }}>
            <Icon name="mail" size={16} />
            {L.inbox}
            {inbox.total > 0 && <span className="badge">{inbox.total}</span>}
          </button>
          <button className="btn primary" type="button" aria-haspopup="dialog" onClick={() => setFir({ open: true, ack: null })}>
            <Icon name="plus" />
            {L.newFir}
          </button>
        </div>
      </div>

      {lang === "te" && (
        <div className="ackbar" role="status" style={{ margin: 0 }}>
          <Icon name="info" />
          <span>
            ఈ పేజీలో హోమ్ పేజీ లేబుల్స్ మాత్రమే తెలుగులో ఉన్నాయి. కేసు తెరలు, పట్టికల్లోని వివరాలు ఇంగ్లీషులోనే ఉంటాయి.{" "}
            <span className="mut">Only the home-page labels are in Telugu; case screens and table contents stay in English.</span>
          </span>
        </div>
      )}

      <section aria-label="Station position" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }} className="kpis">
        <button className={`card measure${data.kpi.needAction ? " warnborder" : ""}`} type="button" onClick={() => setTab("action")} style={data.kpi.needAction ? { borderColor: "rgba(251,191,36,0.35)" } : undefined}>
          <span className="lbl">{L.need}</span>
          <span className="v" style={{ color: C.amber }}>
            {data.kpi.needAction}
          </span>
          <span className="sec">{L.needSub}</span>
        </button>
        <div className="card measure money2" style={{ gridColumn: "span 3" }}>
          <div className="money2-filter">
            <DateRangeFilter value={ranges.kpi} onChange={(r) => setRange("kpi", r)} label="Period for your FIRs and the money lost and held" usual="Usual period" />
          </div>
          <div className="money2-row">
            <button className="money2-half" type="button" title="Open My cases" onClick={() => setTab("mine")}>
              <span className="lbl">{L.firs}</span>
              <span className="v" style={{ color: C.blue }}>
                {data.kpi.range ? data.kpi.range.firs : data.kpi.firs.open}
              </span>
              <span className="sec">{data.kpi.range ? `registered ${rangeLabel(data.kpi.range.range)} · ${data.kpi.range.firsOpen} still open` : L.firsSub}</span>
            </button>
            <span className="money2-sep" aria-hidden="true">
              |
            </span>
            <button className="money2-half" type="button" title="Open the station trends" onClick={() => setTab("trends")}>
              <span className="lbl">{data.kpi.range ? "Amount lost" : L.lost6}</span>
              <span className="v" style={{ color: C.orangeStrong }}>
                {data.kpi.range ? data.kpi.range.lost : data.kpi.lost6.label}
              </span>
              <span className="sec">{data.kpi.range ? `across ${plural(data.kpi.range.cases, "complaint")} · ${rangeLabel(data.kpi.range.range)}` : L.lost6Sub}</span>
            </button>
            <span className="money2-sep" aria-hidden="true">
              |
            </span>
            <div className="money2-half">
              <span className="lbl">{L.held}</span>
              <span className="v" style={{ color: C.teal }}>
                {data.kpi.range ? data.kpi.range.held : data.kpi.held.label}
              </span>
              <span className="sec">{data.kpi.range ? `across ${plural(data.kpi.range.accounts, "account")} · for those complaints` : L.heldSub}</span>
            </div>
          </div>
        </div>
      </section>

      <article className="card" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="listhead" style={{ padding: "20px 28px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <h2 className="srt">{listTitle}</h2>
          <div className="row" aria-label="Filter cases" role="tablist" style={{ gap: 4, flexWrap: "wrap" }}>
            {tabBtn("mine", L.myCases, data.counts.mine)}
            {tabBtn("action", L.need, data.counts.action, C.amber)}
            {tabBtn("closed", L.closed)}
            {tabBtn("trends", L.trendsT)}
            {tabBtn("station", L.allCases, data.counts.station)}
          </div>
          <div className="row listtools" style={{ gap: 8, flex: "none", marginLeft: "auto" }}>
            {tab !== "trends" && (
              <label style={{ position: "relative", display: "inline-flex" }}>
                <span style={{ position: "absolute", left: 12, top: 0, bottom: 0, color: C.mut, display: "inline-flex", alignItems: "center" }}>
                  <Icon name="search" size={16} />
                </span>
                <input className="in search" type="search" placeholder={L.search} value={sq} aria-label={L.search} onChange={(e) => setSq(e.target.value)} />
              </label>
            )}
            {isCases && (
              <div className="popwrap">
                <button className={`fbtn${activeFilters ? " on" : ""}`} type="button" aria-label={filterLabel} aria-expanded={popOpen} title={filterLabel} onClick={() => setPopOpen(!popOpen)} style={{ position: "relative" }}>
                  <Icon name="filter" />
                  {activeFilters > 0 && <span className="badge sbadge">{activeFilters}</span>}
                </button>
                {popOpen && (
                  <>
                    <button className="popbg" type="button" aria-label="Close filters" onClick={() => setPopOpen(false)} />
                    <div className="pop" aria-label="Filter cases" role="dialog" onKeyDown={(e) => e.key === "Escape" && setPopOpen(false)}>
                      <div className="fhead">
                        <span className="t">Filter cases</span>
                        <span className="row" style={{ gap: 8 }}>
                          <span className="mut" style={{ fontSize: 13 }}>
                            {activeFilters ? `${shown.length} of ${loaded.length} shown` : "Nothing filtered"}
                          </span>
                          <button className="tab" type="button" onClick={() => setFl(F0)} style={{ minHeight: 32, padding: "0 10px", fontSize: 13, color: C.blue }}>
                            Clear
                          </button>
                          <button className="tab" type="button" onClick={() => setPopOpen(false)} style={{ minHeight: 32, padding: "0 10px", fontSize: 13 }}>
                            Done
                          </button>
                        </span>
                      </div>
                      <div>
                        <div className="lbl">Where it stands</div>
                        {(
                          [
                            ["action", "Needs you: approvals and decisions"],
                            ["waiting", "Waiting on replies"],
                            ["hold", "Hold expiring"],
                            ["done", "Restoration filed or money returned"],
                          ] as const
                        ).map(([k, label]) => (
                          <label className="fopt" key={k}>
                            <input type="checkbox" checked={fl.status[k]} onChange={() => setFl({ ...fl, status: { ...fl.status, [k]: !fl.status[k] } })} />
                            {label}
                          </label>
                        ))}
                      </div>
                      <div>
                        <div className="lbl">Investigation vertical</div>
                        {[...MO_VERTICALS.map((v) => [v.key, v.label] as const), ["NONE", "Not classified"] as const].map(([k, label]) => (
                          <label className="fopt" key={k}>
                            <input type="checkbox" checked={fl.type[k]} onChange={() => setFl({ ...fl, type: { ...fl.type, [k]: !fl.type[k] } })} />
                            {label}
                          </label>
                        ))}
                      </div>
                      <div>
                        <div className="lbl" style={{ marginBottom: 8 }}>
                          Money held
                        </div>
                        <div className="segs" role="group" aria-label="Money held">
                          {(
                            [
                              ["any", "Any"],
                              ["yes", "Something held"],
                              ["no", "Nothing held"],
                            ] as const
                          ).map(([k, label]) => (
                            <button key={k} className={`tab${fl.held === k ? " on" : ""}`} type="button" aria-pressed={fl.held === k} onClick={() => setFl({ ...fl, held: k })}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="lbl" style={{ marginBottom: 8 }}>
                          Registered
                        </div>
                        <div className="segs" role="group" aria-label="Registered">
                          {(
                            [
                              ["any", "Any time"],
                              ["week", "This week"],
                              ["month", "This month"],
                              ["old", "Older"],
                            ] as const
                          ).map(([k, label]) => (
                            <button key={k} className={`tab${fl.age === k ? " on" : ""}`} type="button" aria-pressed={fl.age === k} onClick={() => setFl({ ...fl, age: k })}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {isCases && (
          <div style={{ overflowX: "auto" }}>
            <table className="table wide">
              <thead>
                <tr>
                  <SortTh k="fir" sort={caseSort.sort} onSort={caseSort.toggle}>
                    FIR
                  </SortTh>
                  {tab === "station" && (
                    <SortTh k="officer" sort={caseSort.sort} onSort={caseSort.toggle}>
                      {L.officer}
                    </SortTh>
                  )}
                  <SortTh k="registered" sort={caseSort.sort} onSort={caseSort.toggle}>
                    {L.registered}
                  </SortTh>
                  <SortTh k="lost" sort={caseSort.sort} onSort={caseSort.toggle} className="amt">
                    {L.lost}
                  </SortTh>
                  <SortTh k="held" sort={caseSort.sort} onSort={caseSort.toggle} className="amt">
                    {L.heldCol}
                  </SortTh>
                  <SortTh k="stands" sort={caseSort.sort} onSort={caseSort.toggle}>
                    {L.stands}
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {caseSort.rows.map((r) => (
                  <tr className="r" key={r.id}>
                    <td>
                      {r.canOpen ? (
                        <Link href={`/cases/${r.id}`}>
                          {r.fir}
                          <span className="sub">
                            {r.kind}
                            {r.sections ? ` · ${r.sections}` : ""}
                          </span>
                        </Link>
                      ) : (
                        <span title={`Open to ${r.officer} and the station's supervisors`}>
                          {r.fir}
                          <span className="sub">
                            {r.kind}
                            {r.sections ? ` · ${r.sections}` : ""}
                          </span>
                        </span>
                      )}
                    </td>
                    {tab === "station" && <td className="sec">{r.officer}</td>}
                    <td className="num">{dayMonth(r.registeredAt)}</td>
                    <td className="amt">{inr(r.lostMinor)}</td>
                    <td className={BigInt(r.heldMinor) > 0n ? "amt" : "amt mut"} style={BigInt(r.heldMinor) > 0n ? { color: C.teal } : undefined}>
                      {inr(r.heldMinor)}
                    </td>
                    <td>
                      <span className={`pill ${r.pill.tone}`}>{r.pill.text}</span>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={tab === "station" ? 6 : 5} style={{ padding: "40px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>{loaded.length === 0 ? "No open cases yet" : "No cases match these filters"}</div>
                      <div className="sec">{loaded.length === 0 ? "Register an FIR to open a case." : "Loosen a filter or clear them to see the list again."}</div>
                      {(activeFilters > 0 || q) && (
                        <button
                          className="btn"
                          type="button"
                          style={{ marginTop: 12 }}
                          onClick={() => {
                            setFl(F0);
                            setSq("");
                          }}
                        >
                          Clear all filters
                        </button>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "action" && (
          <div style={{ overflowX: "auto" }}>
            <table className="table wide">
              <thead>
                <tr>
                  <SortTh k="fir" sort={actionSort.sort} onSort={actionSort.toggle}>
                    FIR
                  </SortTh>
                  <SortTh k="what" sort={actionSort.sort} onSort={actionSort.toggle}>
                    What it needs from you
                  </SortTh>
                  <SortTh k="why" sort={actionSort.sort} onSort={actionSort.toggle}>
                    Why
                  </SortTh>
                  <SortTh k="when" sort={actionSort.sort} onSort={actionSort.toggle}>
                    When
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {actionSort.rows.map((a, i) => (
                  <tr className="r" key={`${a.caseId}:${i}`}>
                    <td>
                      <Link href={a.href}>
                        {a.fir}
                        <span className="sub">{a.kindLabel}</span>
                      </Link>
                    </td>
                    <td>{a.what}</td>
                    <td className="sec">{a.why}</td>
                    <td>
                      <span className={`pill ${a.when.tone}`}>{a.when.text}</span>
                    </td>
                  </tr>
                ))}
                {actionShown.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: "40px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>{q ? "Nothing matches that search" : "Nothing needs you today"}</div>
                      <div className="sec">{q ? "Clear the search to see every action." : "Approvals, replies to check and decisions will appear here as they come in."}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "closed" && (
          <div style={{ overflowX: "auto" }}>
            <table className="table wide">
              <thead>
                <tr>
                  <SortTh k="fir" sort={closedSort.sort} onSort={closedSort.toggle}>
                    FIR
                  </SortTh>
                  <SortTh k="complainant" sort={closedSort.sort} onSort={closedSort.toggle}>
                    {L.complainant}
                  </SortTh>
                  <SortTh k="closed" sort={closedSort.sort} onSort={closedSort.toggle}>
                    Closed
                  </SortTh>
                  <SortTh k="lost" sort={closedSort.sort} onSort={closedSort.toggle} className="amt">
                    {L.lost}
                  </SortTh>
                  <SortTh k="returned" sort={closedSort.sort} onSort={closedSort.toggle} className="amt">
                    Returned
                  </SortTh>
                  <SortTh k="outcome" sort={closedSort.sort} onSort={closedSort.toggle}>
                    Outcome
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {closedSort.rows.map((r) => (
                  <tr className="r" key={r.id}>
                    <td>
                      {r.canOpen ? (
                        <Link href={`/cases/${r.id}`}>
                          {r.fir}
                          <span className="sub">
                            {r.kind}
                            {r.sections ? ` · ${r.sections}` : ""}
                          </span>
                        </Link>
                      ) : (
                        <span>
                          {r.fir}
                          <span className="sub">{r.kind}</span>
                        </span>
                      )}
                    </td>
                    <td>{r.complainant ?? <span className="mut">Restricted</span>}</td>
                    <td className="num">{dayMonth(r.closedAt)}</td>
                    <td className="amt">{inr(r.lostMinor)}</td>
                    <td className={BigInt(r.returnedMinor) > 0n ? "amt" : "amt mut"} style={BigInt(r.returnedMinor) > 0n ? { color: C.teal } : undefined}>
                      {inr(r.returnedMinor)}
                    </td>
                    <td>
                      <span className={`pill ${r.outcome.tone}`}>{r.outcome.text}</span>
                    </td>
                  </tr>
                ))}
                {closedShown.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: "40px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 15, fontWeight: 500 }}>{q ? "No closed case matches that search" : "No cases closed this year"}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "trends" && (
          <div className="trendbar" style={{ padding: "0 28px", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
            {ranges.trends ? <span className="mut" style={{ fontSize: 13 }}>Showing {rangeLabel(ranges.trends)}</span> : null}
            <DateRangeFilter value={ranges.trends} onChange={(r) => setRange("trends", r)} label="Period for the trends" usual="Usual periods" />
          </div>
        )}
        {tab === "trends" && (
          <div style={{ padding: "16px 28px 24px", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 20 }} className="charts">
            <div className="inner chart">
              <h3>Requests by Status</h3>
              <ColumnChart
                id="ch-rs"
                label="Requests by status"
                data={data.trends.requests.groups.map((g) => ({ key: g.key, label: g.label, short: g.label, value: g.value, title: `${g.label} · ${g.count}` }))}
                onPick={setTrKey}
              />
              <table className="srt">
                <caption>Requests by status</caption>
                <tbody>
                  {data.trends.requests.groups.map((g) => (
                    <tr key={g.key}>
                      <td>{g.label}</td>
                      <td>{g.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="tab seelist" type="button" onClick={() => setTrKey(data.trends.requests.groups[0]!.key)}>
                See the full list
              </button>
            </div>
            <div className="inner chart">
              <h3>Types of Frauds (MO)</h3>
              <p className="sub">{ranges.trends ? `Complaints received ${rangeLabel(ranges.trends)}, by modus operandi.` : `Complaints received in ${data.trends.kinds.monthName}, by modus operandi.`} Click a type for its complaints.</p>
              {data.trends.kinds.groups.length ? (
                <PieChart
                  id="ch-kf"
                  label="Types of frauds"
                  total={data.trends.kinds.total}
                  unit={data.trends.kinds.total === 1 ? "complaint" : "complaints"}
                  data={data.trends.kinds.groups.map((g) => ({ key: g.key, label: g.label, short: g.label, value: g.value, title: `${g.label} · ${g.count}` }))}
                  onPick={setTrKey}
                />
              ) : (
                <p className="sec">{ranges.trends ? "No complaints received in this period." : "No complaints received this month yet."}</p>
              )}
              <table className="srt">
                <caption>Types of frauds (MO)</caption>
                <tbody>
                  {data.trends.kinds.groups.map((g) => (
                    <tr key={g.key}>
                      <td>{g.label}</td>
                      <td>{g.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.trends.kinds.groups[0] && (
                <button className="tab seelist" type="button" onClick={() => setTrKey(data.trends.kinds.groups[0]!.key)}>
                  See the full list
                </button>
              )}
            </div>
            <div className="inner chart">
              <h3>Cases by Status</h3>
              <ColumnChart
                id="ch-st"
                label="Cases by status"
                classes={["c5", "c1", "c2", "c3"]}
                data={data.trends.stages.groups.map((g) => ({ key: g.key, label: g.label, short: g.label === "Under investigation" ? "Investigating" : g.label === "Charge sheet filed" ? "Charge sheet" : g.label, value: g.value, title: `${g.label} · ${g.count}` }))}
                onPick={setTrKey}
              />
              <table className="srt">
                <caption>Cases by status</caption>
                <tbody>
                  {data.trends.stages.groups.map((g) => (
                    <tr key={g.key}>
                      <td>{g.label}</td>
                      <td>{g.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="tab seelist" type="button" onClick={() => setTrKey(data.trends.stages.groups[0]!.key)}>
                See the full list
              </button>
            </div>
            <div className="inner chart">
              <h3>{ranges.trends ? (data.trends.months.byDay ? "Lost, Put on Hold and FIRs, by Day" : "Lost, Put on Hold and FIRs, by Month") : "Lost, Put on Hold and FIRs, Last 6 Months"}</h3>
              <p className="sub">
                {ranges.trends ? `${data.trends.months.lost6} reported lost, ${data.trends.months.pohTotal} put on hold and ${plural(data.trends.months.firTotal, "FIR")} registered in this period.` : `${data.trends.months.lost6} reported lost, ${data.trends.months.pohTotal} put on hold and ${plural(data.trends.months.firTotal, "FIR")} registered since ${data.trends.months.from}.`} Click a point for its list.
              </p>
              <ul className="mlegend" aria-label="Lines">
                <li>
                  <span className="sw l1" aria-hidden="true" />
                  Amount lost (₹ lakh, left)
                </li>
                <li>
                  <span className="sw l2" aria-hidden="true" />
                  Put on hold, POH (₹ lakh, left)
                </li>
                <li>
                  <span className="sw l3" aria-hidden="true" />
                  FIRs registered (count, right)
                </li>
              </ul>
              <MultiLineChart
                label="Amount lost, put on hold and FIRs registered"
                formatLeft={(v) => `₹${Number.isInteger(v) ? v : v.toFixed(1)} L`}
                periods={data.trends.months.groups.map((g) => (data.trends.months.byDay ? g.label.slice(0, 6) : g.label.slice(0, 3)))}
                series={[
                  { key: "lost", label: "Amount lost", cls: "l1", axis: "left", points: data.trends.months.groups.map((g) => ({ key: g.key, label: g.label, short: g.label, value: Math.round(g.value / 10000) / 10, title: `${g.label}: ${g.count}` })) },
                  { key: "poh", label: "Put on hold", cls: "l2", axis: "left", points: data.trends.months.poh.map((g) => ({ key: g.key, label: g.label, short: g.label, value: Math.round(g.value / 10000) / 10, title: `${g.label}: ${g.count}` })) },
                  { key: "fir", label: "FIRs registered", cls: "l3", axis: "right", points: data.trends.months.firs.map((g) => ({ key: g.key, label: g.label, short: g.label, value: g.value, title: `${g.label}: ${g.count}` })) },
                ]}
                onPick={setTrKey}
              />
              <table className="srt">
                <caption>Amount lost and put on hold (lakh rupees), and FIRs registered, by period</caption>
                <tbody>
                  {data.trends.months.groups.map((g, i) => (
                    <tr key={g.key}>
                      <td>{g.label}</td>
                      <td>{(Math.round(g.value / 10000) / 10).toFixed(1)}</td>
                      <td>{(Math.round((data.trends.months.poh[i]?.value ?? 0) / 10000) / 10).toFixed(1)}</td>
                      <td>{data.trends.months.firs[i]?.value ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="tab seelist" type="button" onClick={() => setTrKey(data.trends.months.groups.at(-1)!.key)}>
                See the full list
              </button>
            </div>
          </div>
        )}

        {footCount ? (
          <div style={{ padding: "14px 28px", borderTop: `1px solid ${C.lineSoft}`, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }} className="mut">
            <span>{footCount}</span>
          </div>
        ) : null}
      </article>

      <NewFirWindow
        key={`${fir.open}:${fir.ack ?? ""}`}
        open={fir.open}
        initialAck={null}
        onClose={() => setFir({ open: false, ack: null })}
      />

      <DesignModal open={repOpen} onClose={() => setRepOpen(false)} scope="scr-dashboard" maxWidth={1040}>
        <div className="mhead">
          <ModalTitle id="rep-h" style={{ fontSize: 22, margin: 0 }}>
            Inbox Quick View
          </ModalTitle>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table wide">
            <thead>
              <tr>
                <th scope="col">Reply from</th>
                <th scope="col">About</th>
                <th scope="col">Received</th>
                <th scope="col">What it needs</th>
              </tr>
            </thead>
            <tbody>
              {inbox.groups.flatMap((g) => [
                <tr className="grp" key={`g-${g.caseId}`}>
                  <td colSpan={4}>
                    FIR {g.fir} · {g.kind} · {plural(g.items.length, "reply", "replies")} <Link href={`/cases/${g.caseId}/requests`}>Open in the case</Link>
                  </td>
                </tr>,
                ...g.items.map((i) => (
                  <tr className="r" key={i.id}>
                    <td>
                      <Link href={i.href}>
                        {i.from}
                        <span className="sub">{i.about}</span>
                      </Link>
                    </td>
                    <td>{i.identifier ?? <span className="mut">—</span>}</td>
                    <td className="num">{dayMonthTime(i.receivedAt)}</td>
                    <td>
                      <span className={`pill ${i.needs.tone}`}>{i.needs.text}</span>
                    </td>
                  </tr>
                )),
              ])}
              {inbox.groups.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: "40px 16px", textAlign: "center" }}>
                    <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Nothing to check</div>
                    <div className="sec">Replies to your requests appear here as they arrive in the station mailbox.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mfoot" style={{ alignItems: "center" }}>
          <span className="mut" style={{ marginRight: "auto", fontSize: 13 }}>
            A reply is matched to its request by its reference, sender and the identifiers. Check your inbox.
          </span>
        </div>
      </DesignModal>

      <DesignModal open={!!tr} onClose={() => setTrKey(null)} scope="scr-dashboard" maxWidth={960}>
        {tr && (
          <>
            <div className="mhead">
              <div className="lbl">Trends · {tr.title}</div>
              <ModalTitle id="tr-h" style={{ fontSize: 22, margin: 0 }}>
                {tr.group.label}{" "}
                <span className="num mut" style={{ fontWeight: 500 }}>
                  · {tr.group.count}
                </span>
              </ModalTitle>
              <p className="sec" style={{ margin: 0, fontSize: 14 }}>
                {tr.group.sub}
              </p>
              <div className="row" role="tablist" aria-label="Which list" style={{ gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                {Object.entries(groups)
                  .filter(([, v]) => v.title === tr.title)
                  .map(([k, v]) => (
                    <button key={k} className={`tab${k === trKey ? " on" : ""}`} type="button" role="tab" aria-selected={k === trKey} onClick={() => setTrKey(k)}>
                      {v.group.label} <span className="num mut">{v.group.value > 1000 ? v.group.count.replace(" lost", "") : v.group.value}</span>
                    </button>
                  ))}
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="table wide">
                <thead>
                  <tr>
                    {tr.cols.map((c, i) => (
                      <SortTh key={c} k={"abcd"[i]!} sort={drillSort.sort} onSort={drillSort.toggle}>
                        {c}
                      </SortTh>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {drillSort.rows.slice(0, 50).map((r, i) => (
                    <tr className="r" key={`${r.a}:${i}`}>
                      <td>
                        {r.href ? (
                          <Link href={r.href}>
                            {r.a}
                            <span className="sub">{r.sub}</span>
                          </Link>
                        ) : (
                          <span title="Open to the case's officer and the station's supervisors">
                            {r.a}
                            <span className="sub">{r.sub}</span>
                          </span>
                        )}
                      </td>
                      <td>{r.b}</td>
                      <td>{r.c}</td>
                      <td>{r.d}</td>
                    </tr>
                  ))}
                  {tr.group.rows.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ padding: "32px 16px", textAlign: "center" }} className="sec">
                        Nothing in this list.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mfoot" style={{ alignItems: "center" }}>
              <span className="mut" style={{ marginRight: "auto", fontSize: 13 }}>
                Showing {Math.min(50, tr.group.rows.length)} of {tr.group.rows.length}. Rows you can open link to their case; the rest belong to other officers.
              </span>
              <button className="btn primary" type="button" onClick={() => setTrKey(null)}>
                Close
              </button>
            </div>
          </>
        )}
      </DesignModal>
    </div>
  );
}
