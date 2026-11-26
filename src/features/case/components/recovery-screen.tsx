"use client";

import Link from "next/link";
import { DropdownMenu as M } from "radix-ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import { SortTh, useSort, type SortValue } from "@/components/design/sort";
import type { RecoveryViewData } from "@/server/services/recovery-view";
import type { SplitMethod } from "@/server/services/allocation-decision";
import { logContactAction, recordSplitAction } from "../actions";
import { confirmAllocationAction, withdrawAllocationAction } from "@/features/funds/actions";

type MoveRow = RecoveryViewData["rows"][number];
const MOVE_SORT: Record<string, (r: MoveRow) => SortValue> = {
  when: (r) => new Date(r.at),
  movement: (r) => r.movement,
  amount: (r) => BigInt(r.amountMinor),
  record: (r) => r.record,
};

type Split =
  | { needed: false; held: string; decided: Decided | null }
  | { needed: true; held: string; decided: Decided | null; options: { method: SplitMethod; title: string; detail: string }[]; note: string };
type Decided = { method: SplitMethod; on: string; note: string; split: string | null };

const inr = (minor: bigint) => {
  const r = (minor < 0n ? -minor : minor) / 100n;
  const s = r.toString();
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${minor < 0n ? "−" : ""}₹${rest ? `${rest},${last3}` : last3}`;
};

/** Transactions & recovery (design: Recovery artboard). */
export function RecoveryScreen({ refLabel, data, split }: { refLabel: string; data: RecoveryViewData; split: Split | null }) {
  const router = useRouter();
  const b = `/cases/${data.caseId}`;
  const [preview, setPreview] = useState(false);
  const [help, setHelp] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [logOpen, setLogOpen] = useState(false);
  const pv = preview && data.refundPreview;
  // Preview: what the ledger would show if the allocated refund reached the victim. Nothing is recorded.
  const pvMinor = pv ? BigInt(data.refundPreview!.amountMinor) : 0n;
  const heldShown = pv ? inr(BigInt(data.totals.heldMinor) - pvMinor) : data.measures.held.value;
  const returnedShown = pv ? inr(BigInt(data.totals.returnedMinor) + pvMinor) : data.measures.returned.value;
  const { rows, sort, toggle } = useSort(
    data.rows.filter((r) => filter === "all" || r.accounts.includes(filter)),
    MOVE_SORT,
  );

  return (
    <>
      <header className="casehead" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div className="mut" style={{ fontSize: 13 }}>
            <Link href={b}>{refLabel}</Link>
            <span style={{ margin: "0 6px" }} aria-hidden="true">
              /
            </span>
            Transactions &amp; Recovery
          </div>
          <h1 className="h" style={{ fontSize: 28 }}>
            Recovery Ledger
          </h1>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {data.refundPreview ? (
            <label className="tog">
              <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
              {data.refundPreview.label}
            </label>
          ) : null}
          <button className="iconbtn" type="button" aria-label="How to read the ledger" onClick={() => setHelp(true)}>
            <Icon name="help" />
          </button>
          <M.Root>
            <M.Trigger className="btn" aria-label="Detailed info: holds, allocations and refunds, record a transaction">
              Detailed info <Icon name="chevronDown" size={14} />
            </M.Trigger>
            <M.Portal>
              <div className="scr-recovery">
                <M.Content className="cmenu" align="end" sideOffset={6} style={{ minWidth: 220, padding: 4, borderRadius: 10, border: `1px solid ${C.line}`, background: C.card, boxShadow: "0 12px 32px rgba(0,0,0,0.4)", zIndex: 60 }}>
                  {[
                    { href: `${b}/funds/holds`, label: "Holds" },
                    { href: `${b}/funds/returns`, label: "Allocations and refunds" },
                    { href: `${b}/funds`, label: "Record a transaction" },
                  ].map((x) => (
                    <M.Item key={x.href} asChild>
                      <Link href={x.href} className="menuitem" style={{ display: "block", padding: "8px 12px", borderRadius: 8, fontSize: 14, color: "inherit", outline: "none" }}>
                        {x.label}
                      </Link>
                    </M.Item>
                  ))}
                </M.Content>
              </div>
            </M.Portal>
          </M.Root>
          <a className="btn" href={`/api/cases/${data.caseId}/ledger`} download>
            Export
          </a>
        </div>
      </header>

      <div className="casepad" style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 1240, width: "100%" }}>
        {pv ? (
          <div className="banner warn" role="status">
            <Icon name="alert" />
            <div>
              <strong>Preview only, nothing is recorded.</strong> This is what the ledger would show if a {data.refundPreview!.amount} refund from {data.refundPreview!.from} reached {data.refundPreview!.victim}. Figures that would change are outlined in amber.
            </div>
          </div>
        ) : null}
        {data.reconciliation ? (
          <div className="banner warn" role="alert">
            <Icon name="alert" />
            <div>
              <strong>Needs reconciliation.</strong> {data.reconciliation.join(" ")}
            </div>
          </div>
        ) : null}

        <section aria-label="Position" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="kpis" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }}>
            <div className="card measure">
              <div className="lbl">Amount Lost</div>
              <div className="v">{data.measures.lost.value}</div>
              <div className="sec">{data.measures.lost.sub}</div>
            </div>
            <div className={`card measure${pv ? " prev" : ""}`}>
              <div className="lbl">Held in accounts</div>
              <div className="v" style={{ color: C.teal }}>
                {heldShown}
              </div>
              <div className="sec">{data.measures.held.sub}</div>
            </div>
            <div className="card measure">
              <div className="lbl">Taken out as cash</div>
              <div className="v" style={{ color: C.orange }}>
                {data.measures.cash.value}
              </div>
              <div className="sec">{data.measures.cash.sub}</div>
            </div>
            <div className={`card measure${pv ? " prev" : ""}`}>
              <div className="lbl">Returned to victims</div>
              <div className="v">{returnedShown}</div>
              <div className="sec">{pv ? `${data.refundPreview!.amount} to ${data.refundPreview!.victim}, if credited` : data.measures.returned.sub}</div>
            </div>
          </div>
        </section>

        <section className="stack-narrow" style={{ display: "grid", gridTemplateColumns: "minmax(0, 7fr) minmax(0, 5fr)", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
            <article className="card" style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "20px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <h2 className="h" style={{ fontSize: 18 }}>
                  Where the Money Went
                </h2>
                <div className="row" role="tablist" aria-label="Filter by account" style={{ gap: 4, flexWrap: "wrap" }}>
                  <button className={`tab${filter === "all" ? " on" : ""}`} type="button" role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")}>
                    All
                  </button>
                  {data.accountFilters.map((a) => (
                    <button key={a.id} className={`tab${filter === a.id ? " on" : ""}`} type="button" role="tab" aria-selected={filter === a.id} onClick={() => setFilter(a.id)}>
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="table" style={{ minWidth: 520 }}>
                  <thead>
                    <tr>
                      <SortTh k="when" sort={sort} onSort={toggle}>When</SortTh>
                      <SortTh k="movement" sort={sort} onSort={toggle}>Movement</SortTh>
                      <SortTh k="amount" sort={sort} onSort={toggle} className="amt">Amount</SortTh>
                      <SortTh k="record" sort={sort} onSort={toggle}>Record</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td className="num" style={{ whiteSpace: "nowrap" }}>
                          {r.when}
                        </td>
                        <td>
                          {r.movement}
                          <span className="sub">{r.sub}</span>
                        </td>
                        <td className="amt" style={r.tone === "cash" ? { color: C.orange } : r.tone === "held" ? { color: C.teal } : undefined}>
                          {r.amount}
                        </td>
                        <td className="sec">{r.record}</td>
                      </tr>
                    ))}
                    {pv ? (
                      <tr className="prev">
                        <td className="num">Preview</td>
                        <td>
                          Refund from {data.refundPreview!.from} to {data.refundPreview!.victim}
                          <span className="sub">Not recorded</span>
                        </td>
                        <td className="amt" style={{ color: C.amber }}>
                          {data.refundPreview!.amount}
                        </td>
                        <td className="sec">—</td>
                      </tr>
                    ) : null}
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ padding: "32px 16px", textAlign: "center" }}>
                          <div style={{ fontWeight: 500 }}>No money movements recorded{filter !== "all" ? " for this account" : ""}</div>
                          <div className="sec">Payments from the FIR and transfers from bank statements appear here as they are applied.</div>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </article>
            <article className="card cardpad" style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 4 }}>
              <h2 className="h" style={{ fontSize: 18 }}>
                {data.accounts.length === 1 ? "The account" : `The ${["", "one", "two", "three", "four", "five", "six"][data.accounts.length] ?? data.accounts.length} accounts`}
              </h2>
              {data.accounts.length ? (
                <ul className="list">
                  {data.accounts.map((a) => (
                    <li key={a.id}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>{a.name}</span>
                        {a.bank ? <span className="mut"> · {a.bank}</span> : null}
                        <span className="sec" style={{ display: "block", fontSize: 14 }}>
                          {a.sentence}
                        </span>
                      </span>
                      <span className={`pill ${a.pill.tone}`}>{a.pill.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sec" style={{ margin: "8px 0 0", fontSize: 14 }}>
                  No beneficiary account is recorded yet.
                </p>
              )}
            </article>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
            <article className="card cardpad" style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
              <h2 className="h" style={{ fontSize: 18 }}>
                Each Victim
              </h2>
              {data.victims.map((v) => {
                const isPv = pv && data.refundPreview!.claimId === v.claimId;
                const loss = BigInt(v.lossMinor);
                const cred = BigInt(v.creditedMinor) + (isPv ? pvMinor : 0n);
                const alloc = BigInt(v.allocatedMinor) - (isPv ? pvMinor : 0n);
                const pct = (m: bigint) => (loss > 0n ? Math.max(0, Math.min(100, Number((m * 1000n) / loss) / 10)) : 0);
                const remaining = loss - cred < 0n ? 0n : loss - cred;
                return (
                  <div key={v.claimId} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="row" style={{ justifyContent: "space-between", fontSize: 15 }}>
                      <span style={{ fontWeight: 500 }}>{v.name}</span>
                      <span className="num">{inr(remaining)} still lost</span>
                    </div>
                    <div className="vbar" role="img" aria-label={`${v.name}: ${inr(cred)} returned and ${inr(alloc < 0n ? 0n : alloc)} set aside of ${v.lost} lost`}>
                      <span className="c" style={{ width: `${pct(cred)}%` }} />
                      <span className="a" style={{ width: `${Math.min(100 - pct(cred), pct(alloc < 0n ? 0n : alloc))}%` }} />
                    </div>
                    <div className="sec" style={{ fontSize: 13 }}>
                      Paid {v.lost} · returned {inr(cred)} · set aside {inr(alloc < 0n ? 0n : alloc)}
                    </div>
                  </div>
                );
              })}
              <p className="mut" style={{ margin: 0, fontSize: 13 }}>
                Solid is returned. Striped is set aside for them but not yet paid. Only a confirmed credit lowers the loss.
              </p>
            </article>

            <article id="contacts" className="card cardpad" style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 12, scrollMarginTop: 24 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
                <h2 className="h" style={{ fontSize: 18 }}>
                  Keeping the Victims Informed
                </h2>
                {data.canWrite ? (
                  <button className="btn" type="button" aria-expanded={logOpen} aria-controls="log-form" onClick={() => setLogOpen(!logOpen)}>
                    Log a call
                  </button>
                ) : null}
              </div>
              {data.silent.length ? (
                <div className="banner warn" role="status">
                  <Icon name="alert" />
                  <div>{data.silent.join(" and ")} {data.silent.length === 1 ? "has" : "have"} heard nothing for 7 days or more.</div>
                </div>
              ) : null}
              {logOpen ? <LogCall caseId={data.caseId} victims={data.victimOptions} onDone={() => { setLogOpen(false); router.refresh(); }} onCancel={() => setLogOpen(false)} /> : null}
              {data.calls.length ? (
                <ul className="list vlog">
                  {data.calls.map((c) => (
                    <li key={c.id}>
                      <span className="t">
                        {c.who}
                        <span className="s">
                          {c.text} · {c.by.toLowerCase().replace(/^logged/, "logged")}
                        </span>
                      </span>
                      {c.pill ? <span className={`pill ${c.pill.tone}`}>{c.pill.text}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sec" style={{ margin: 0, fontSize: 14 }}>
                  No call is logged yet. Log what each victim was told, so the next officer knows.
                </p>
              )}
              <p className="mut" style={{ margin: 0, fontSize: 13 }}>
                Every call goes into the audit log with its time and into the handover. A victim who has heard nothing for 7 days shows on the dashboard as needing a call.
              </p>
            </article>

            {split ? <WhoseMoney caseId={data.caseId} split={split} data={data} /> : null}
          </div>
        </section>
      </div>

      <DesignModal open={help} onClose={() => setHelp(false)} scope="scr-recovery" maxWidth={680}>
        <div className="mhead">
          <span className="lbl">Help</span>
          <ModalTitle style={{ fontSize: 20 }}>How to Read the Ledger</ModalTitle>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            Every figure comes from a bank record. These are the words the ledger uses and what each one counts.
          </p>
        </div>
        <div className="mbody">
          <dl className="inner def" style={{ margin: 0 }}>
            <dt>Amount Lost</dt>
            <dd>What the victims paid, from the FIR and their bank records. It only goes down when money is returned.</dd>
            <dt>Held in accounts</dt>
            <dd>What a bank has confirmed is actually there under a hold. A hold on an empty account counts for nothing.</dd>
            <dt>Allocated to victims</dt>
            <dd>Held money attributed to a victim under a basis you record. Never guessed from amounts or timing.</dd>
            <dt>Authorised vs returned</dt>
            <dd>Authorised means an order exists. Returned means the victim’s bank confirms the credit. Only returned money reduces the loss.</dd>
            <dt>All movements</dt>
            <dd>Every transfer added up, so the same rupee is counted once per hop. It is always more than the loss.</dd>
            <dt>Preview</dt>
            <dd>The toggle in the header shows what the ledger would look like after a refund. Nothing is recorded while it is on.</dd>
          </dl>
          <p className="mut" style={{ margin: 0, fontSize: 13 }}>
            In the victim bars, solid is returned and striped is set aside for them but not yet paid.
          </p>
        </div>
        <div className="mfoot">
          <Link className="btn" href="/assistant">
            Ask about the restoration procedure
          </Link>
          <button className="btn primary" type="button" onClick={() => setHelp(false)}>
            Got it
          </button>
        </div>
      </DesignModal>
    </>
  );
}

function LogCall({ caseId, victims, onDone, onCancel }: { caseId: string; victims: { id: string; name: string }[]; onDone: () => void; onCancel: () => void }) {
  const [who, setWho] = useState(victims[0]?.id ?? "");
  const [what, setWhat] = useState("");
  const [next, setNext] = useState("");
  const [waiting, setWaiting] = useState("");
  const [missing, setMissing] = useState<null | "blur" | "submit">(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const invalid = !!missing && !what.trim();
  const save = () => {
    if (!what.trim()) {
      setMissing("submit");
      document.getElementById("log-what")?.focus();
      return;
    }
    start(async () => {
      setError(null);
      const r = await logContactAction(caseId, { victimEntityId: who, summary: what.trim(), nextDueAt: next ? `${next}T11:00` : null, followUp: waiting.trim() || null });
      if (!r.ok) setError(r.error);
      else onDone();
    });
  };
  return (
    <div id="log-form" className="inner" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="segs" role="radiogroup" aria-label="Which victim">
        {victims.map((v) => (
          <button key={v.id} className={`seg${who === v.id ? " on" : ""}`} type="button" role="radio" aria-checked={who === v.id} onClick={() => setWho(v.id)}>
            {v.name}
          </button>
        ))}
      </div>
      <label className="fld">
        What they were told
        <textarea id="log-what" className="in" rows={2} value={what} placeholder="Told that the hold on Account B is confirmed" onChange={(e) => { setWhat(e.target.value); setMissing(null); }} onBlur={() => !what.trim() && setMissing("blur")} onFocus={() => missing === "blur" && setMissing(null)} aria-invalid={invalid} aria-describedby={invalid ? "log-what-err" : undefined} style={{ padding: 10, minHeight: 64 }} />
        {invalid ? (
          <span id="log-what-err" style={{ fontSize: 13, color: C.orange }}>
            Write what they were told before saving.
          </span>
        ) : null}
      </label>
      <div className="stack-narrow" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <label className="fld">
          Next call
          <input className="in" type="date" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="fld">
          Waiting on them for
          <input className="in" type="text" value={waiting} placeholder="The bank proof for restoration" onChange={(e) => setWaiting(e.target.value)} maxLength={200} />
        </label>
      </div>
      <div className="row" style={{ justifyContent: "flex-end", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {error ? (
          <span role="alert" style={{ fontSize: 13, color: C.orange }}>
            {error}
          </span>
        ) : null}
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" type="button" onClick={save} aria-busy={pending}>
          {pending ? "Saving…" : "Save the call"}
        </button>
      </div>
    </div>
  );
}

function WhoseMoney({ caseId, split, data }: { caseId: string; split: Split; data: RecoveryViewData }) {
  const router = useRouter();
  const decided = split.decided;
  const [method, setMethod] = useState<SplitMethod | null>(decided?.method ?? null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const stillOpen = data.proposed.length > 0 || !decided;
  const pill = decided ? { text: decided.method === "COURT" ? "Left to the court" : data.proposed.some((p) => p.status === "PROPOSED") ? "Proposed" : "Confirmed", tone: decided.method === "COURT" ? "neutral" : "ok" } : { text: "Not confirmed", tone: "wait" };
  const record = () =>
    start(async () => {
      setError(null);
      if (!method) return setError("Choose one of the three routes.");
      if (note.trim().length < 10) return setError("Write a sentence on why this route fits the case; it is recorded with the decision.");
      const r = await recordSplitAction(caseId, method, note);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  const change = () =>
    start(async () => {
      setError(null);
      if (reason.trim().length < 3) return setError("Say why the split is being changed.");
      for (const p of data.proposed) {
        const r = await withdrawAllocationAction(p.id, reason.trim());
        if (!r.ok) return setError(r.error);
      }
      setChanging(false);
      router.refresh();
    });
  const confirm = (id: string) =>
    start(async () => {
      const r = await confirmAllocationAction(id, false);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  if (!split.needed && !decided) return null;
  return (
    <article className="card cardpad" style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="h" style={{ fontSize: 18 }}>
          Whose Money Is Held?
        </h2>
        <span className={`pill ${pill.tone}`}>{pill.text}</span>
      </div>
      {!decided ? (
        <p className="mut" style={{ margin: 0, fontSize: 13 }}>
          Also in{" "}
          <Link href={`/cases/${caseId}/actions`} style={{ color: C.blue }}>
            Next Actions
          </Link>
          , where it can be decided too.
        </p>
      ) : null}
      {error ? (
        <div className="banner warn" role="alert">
          <Icon name="alert" />
          <div>{error}</div>
        </div>
      ) : null}
      {decided ? (
        <div className="banner ok" role="status">
          <Icon name="check" />
          <div>
            Confirmed {decided.on}: {decided.method === "PROPORTIONAL" ? "split in proportion to what each victim paid" : decided.method === "FIRST_IN_FIRST_OUT" ? "first in, first out" : "left to the court"}. {decided.split ? `The split above follows this basis (${decided.split}) and goes into the export.` : "No split is recorded here."}
          </div>
        </div>
      ) : (
        <p className="sec" style={{ margin: 0, fontSize: 14 }}>
          Both victims paid into the same account before the money moved on, so the ledger cannot say whose {split.held} is held until you choose a basis.
        </p>
      )}
      {split.needed && !decided
        ? split.options.map((o) => (
            <button key={o.method} className={`opt${method === o.method ? " on" : ""}`} type="button" role="radio" aria-checked={method === o.method} disabled={!data.canWrite} onClick={() => setMethod(o.method)}>
              <span className={`radio${method === o.method ? " on" : ""}`}>
                <span />
              </span>
              <span>
                <span style={{ fontSize: 15, fontWeight: 500, display: "block" }}>{o.title}</span>
                <span className="mut" style={{ fontSize: 13, display: "block" }}>
                  {o.detail}
                </span>
              </span>
            </button>
          ))
        : null}
      {!decided && data.canWrite && split.needed ? (
        <label className="fld">
          Your reason
          <textarea className="in" rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={{ padding: 10, minHeight: 60 }} />
        </label>
      ) : null}
      {data.proposed.length ? (
        <ul className="list">
          {data.proposed.map((p) => (
            <li key={p.id}>
              <span className="t" style={{ fontSize: 14 }}>
                {p.text}
                <span className="s" style={{ display: "block", fontSize: 13, color: C.mut, fontWeight: 400 }}>
                  {p.status === "CONFIRMED" ? "Confirmed" : `Proposed by ${p.by}; ${data.isSupervisor ? "confirm it to let the restoration be drafted" : "the supervisor confirms it"}`}
                </span>
              </span>
              {p.canConfirm ? (
                <button className="btn sm" type="button" onClick={() => confirm(p.id)} aria-busy={pending}>
                  Confirm
                </button>
              ) : (
                <span className={`pill ${p.status === "CONFIRMED" ? "ok" : "wait"}`}>{p.status === "CONFIRMED" ? "Confirmed" : "Proposed"}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {changing ? (
        <label className="fld">
          Why change the split?
          <input className="in" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </label>
      ) : null}
      <div className="row" style={{ justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        {!decided && data.canWrite && split.needed ? (
          <button className="btn primary" type="button" onClick={record} aria-busy={pending}>
            {pending ? "Recording…" : "Record this basis"}
          </button>
        ) : null}
        {decided && data.canWrite && data.proposed.length && stillOpen ? (
          changing ? (
            <>
              <button className="btn" type="button" onClick={() => setChanging(false)}>
                Cancel
              </button>
              <button className="btn primary" type="button" onClick={change} aria-busy={pending}>
                Withdraw the split
              </button>
            </>
          ) : (
            <button className="btn" type="button" onClick={() => setChanging(true)}>
              Change
            </button>
          )
        ) : null}
        {decided ? (
          <Link className="btn primary" href={`/cases/${caseId}/actions`}>
            {data.proposed.some((p) => p.status === "CONFIRMED") ? "Draft the restoration filing" : "Open next actions"}
          </Link>
        ) : null}
      </div>
    </article>
  );
}
