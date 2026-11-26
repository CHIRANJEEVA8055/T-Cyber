"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import type { IntakeViewData } from "@/server/services/intake-view";
import { finishIntakeAction } from "../actions";
import { addManualCandidateAction, reviewCandidateAction } from "@/features/evidence/actions";

type Line = IntakeViewData["documents"][number]["lines"][number];

/** A document line with the details the reader found marked where it found them. */
function Marked({ l }: { l: Line }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of l.marks) {
    if (m.start < at) continue;
    if (m.start > at) parts.push(l.text.slice(at, m.start));
    parts.push(
      <span key={m.id} className={`mk ${m.kind}`}>
        {l.text.slice(m.start, m.end)}
      </span>,
    );
    at = m.end;
  }
  parts.push(l.text.slice(at));
  return <>{parts}</>;
}

/** Intake & evidence (design: Intake artboard): check what was read from the FIR and the other documents. */
export function IntakeScreen({ refLabel, data }: { refLabel: string; data: IntakeViewData }) {
  const router = useRouter();
  const b = `/cases/${data.caseId}`;
  const [doc, setDoc] = useState(data.documents[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const current = data.documents.find((d) => d.id === doc) ?? data.documents[0];
  const act = (id: string, action: "ACCEPT" | "REJECT") =>
    start(async () => {
      setError(null);
      const r = await reviewCandidateAction(id, action === "REJECT" ? { action, rejectReason: "Not a detail of this case" } : { action });
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  const finish = () =>
    start(async () => {
      setError(null);
      const r = await finishIntakeAction(data.caseId, data.documents.map((d) => d.id));
      if (!r.ok) return setError(r.error);
      if (r.data.left) {
        setNotice(`${r.data.applied} details added to the case. ${r.data.left} still need your check: they are marked Uncertain or Check role.`);
        router.refresh();
      } else router.push(b);
    });
  const checking = data.pending > 0;
  return (
    <>
      <header className="casehead" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div className="mut" style={{ fontSize: 13 }}>
            <Link href={b}>{refLabel}</Link>
            <span style={{ margin: "0 6px" }} aria-hidden="true">
              /
            </span>
            Intake &amp; Evidence
          </div>
          <h1 className="h" style={{ fontSize: 28 }}>
            {data.hasFir ? "Check what was read from the FIR" : "Intake & evidence"}
          </h1>
          <p className="sec" style={{ margin: "10px 0 0", fontSize: 15 }}>
            Confirm each detail was read correctly and whose it is. That is all this step decides.
          </p>
        </div>
        <ol className="row" aria-label="Steps" style={{ gap: 24, flexWrap: "wrap", listStyle: "none", margin: 0, padding: 0 }}>
          {[
            { n: 1, label: "Upload", state: "done" },
            { n: 2, label: "Read", state: "done" },
            { n: 3, label: "Check", state: checking ? "on" : "done" },
            { n: 4, label: "Open the case", state: checking ? "" : "on" },
          ].map((s) => (
            <li key={s.n} className={`step ${s.state}`} aria-current={s.state === "on" ? "step" : undefined}>
              <span className="n">{s.state === "done" ? <Icon name="check" size={12} /> : s.n}</span>
              {s.label}
            </li>
          ))}
        </ol>
      </header>

      <div className="casepad stack-narrow" style={{ display: "grid", gridTemplateColumns: "minmax(0, 6fr) minmax(0, 5fr)", gap: 24, maxWidth: 1240, width: "100%", alignItems: "start" }}>
        <section className="card" aria-label="Source document" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ padding: "16px 24px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, borderBottom: `1px solid ${C.line}` }}>
            <div className="row" role="tablist" aria-label="Documents" style={{ gap: 4, flex: "1 1 auto", flexWrap: "wrap" }}>
              {data.documents.map((d) => (
                <button key={d.id} className={`tab${current?.id === d.id ? " on" : ""}`} type="button" role="tab" aria-selected={current?.id === d.id} onClick={() => setDoc(d.id)}>
                  {d.tab}
                </button>
              ))}
            </div>
            {current ? (
              <span className="mut" style={{ fontSize: 13 }}>
                {current.caption}
              </span>
            ) : null}
          </div>
          <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 6, maxHeight: 720, overflowY: "auto" }}>
            {current ? (
              current.lines.length ? (
                current.lines.map((l, i) => (
                  <p key={i} className="doc" style={{ margin: 0 }}>
                    {l.page && (i === 0 || current.lines[i - 1]!.page !== l.page) ? (
                      <span className="lbl" style={{ display: "block", fontFamily: "inherit", margin: i ? "12px 0 4px" : "0 0 4px" }}>
                        Page {l.page}
                      </span>
                    ) : null}
                    <Marked l={l} />
                  </p>
                ))
              ) : (
                <p className="sec" style={{ margin: 0 }}>
                  This document has no text the reader could use. Open it to read it yourself.
                </p>
              )
            ) : (
              <p className="sec" style={{ margin: 0 }}>
                No documents yet. Open a case from an FIR copy on the dashboard, or upload one in Evidence.
              </p>
            )}
            {current?.truncated ? <p className="mut" style={{ fontSize: 13 }}>Only the first 400 lines are shown here; the full document is in Evidence.</p> : null}
          </div>
          <div className="sec" style={{ padding: "14px 28px", display: "flex", flexWrap: "wrap", gap: 16, fontSize: 13, borderTop: `1px solid ${C.line}` }}>
            {[
              ["acct", "Account"],
              ["phone", "Person or phone"],
              ["plat", "Online account"],
              ["amt", "Amount or reference"],
              ["unc", "Needs checking"],
            ].map(([k, label]) => (
              <span key={k} className="row" style={{ gap: 6 }}>
                <span className={`mk ${k}`} style={{ width: 12, height: 12, display: "inline-block", padding: 0 }} aria-hidden="true" />
                {label}
              </span>
            ))}
            <Link className="more" href={`${b}/evidence`} style={{ marginLeft: "auto" }}>
              All evidence
            </Link>
          </div>
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
          <div className="card" style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "20px 28px 8px", display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}>
              <h2 className="h" style={{ fontSize: 18, flex: "1 1 160px" }}>
                What Was Found
              </h2>
              <span className="sec" style={{ fontSize: 14 }}>
                {data.summary}
              </span>
            </div>
            <div style={{ padding: "0 28px 16px" }}>
              {error ? (
                <div className="banner warn" role="alert" style={{ marginBottom: 8 }}>
                  <Icon name="alert" />
                  <div>{error}</div>
                </div>
              ) : null}
              {notice ? (
                <div className="banner ok" role="status" style={{ marginBottom: 8 }}>
                  <Icon name="check" />
                  <div>{notice}</div>
                </div>
              ) : null}
              {data.groups.map((g) =>
                g.items.length ? (
                  <div key={g.key}>
                    <div className="lbl" style={{ padding: "14px 0 6px" }}>
                      {g.label}
                    </div>
                    <ul className="list">
                      {g.items.map((it) => (
                        <li key={it.id} style={{ alignItems: "flex-start" }}>
                          <span className="t">
                            {it.title}
                            <span className="s">{it.sub}</span>
                            {it.pending && data.canWrite ? (
                              <span className="row" style={{ gap: 8, marginTop: 8 }}>
                                <button className="btn sm" type="button" disabled={pending} onClick={() => act(it.id, "ACCEPT")} aria-label={`Confirm ${it.title}`}>
                                  Confirm
                                </button>
                                <button className="btn sm" type="button" disabled={pending} onClick={() => act(it.id, "REJECT")} aria-label={`Set aside ${it.title}`}>
                                  Set aside
                                </button>
                              </span>
                            ) : null}
                          </span>
                          <span className={`pill ${it.status.tone}`}>{it.status.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
              {data.notInFir.length ? (
                <>
                  <div className="lbl" style={{ padding: "14px 0 6px" }}>
                    Not in the FIR
                  </div>
                  <ul className="list">
                    {data.notInFir.map((n) => (
                      <li key={n.title}>
                        <span className="t">
                          {n.title}
                          <span className="s">{n.sub}</span>
                        </span>
                        <span className="pill neutral">Missing</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
            {data.flags.length ? (
              <div className="sec" style={{ padding: "14px 28px", fontSize: 14, borderTop: `1px solid ${C.line}` }}>
                {data.flags.join(" ")}
              </div>
            ) : null}
            {data.canWrite ? (
              <div style={{ padding: "16px 28px", display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", borderTop: `1px solid ${C.line}` }}>
                <button className="btn" type="button" aria-haspopup="dialog" onClick={() => setAdding(true)} disabled={!current}>
                  Add something that was missed
                </button>
                {checking ? (
                  <button className="btn primary" type="button" onClick={finish} aria-busy={pending}>
                    {pending ? "Applying…" : "Confirm and open the case"}
                  </button>
                ) : (
                  <Link className="btn primary" href={b}>
                    Open the case overview
                  </Link>
                )}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <DesignModal open={adding} onClose={() => setAdding(false)} scope="scr-intake" maxWidth={560}>
        {adding && current ? <AddMissed evidenceId={current.id} docName={current.tab} onDone={() => { setAdding(false); router.refresh(); }} onCancel={() => setAdding(false)} /> : null}
      </DesignModal>
    </>
  );
}

type Cat = "people" | "money" | "contact" | "other";
const CATS: { k: Cat; label: string; hint: string }[] = [
  { k: "people", label: "People", hint: "R. Kumar, named as the caller" },
  { k: "money", label: "Money", hint: "Account XXXXXXXX1234 or name@bank" },
  { k: "contact", label: "Contact", hint: "+91-98XXXXXX12 or name@example.com" },
  { k: "other", label: "Online", hint: "A profile name, website or IP address" },
];
function fieldFor(cat: Cat, v: string): string {
  const t = v.trim();
  if (cat === "people") return "PERSON_NAME";
  if (cat === "money") return t.includes("@") ? "UPI_ID" : "BANK_ACCOUNT";
  if (cat === "contact") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? "EMAIL" : "PHONE";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return "IP_ADDRESS";
  if (/^(https?:\/\/|www\.)/i.test(t) || /\.[a-z]{2,}(\/|$)/i.test(t)) return "WEBSITE";
  return "PLATFORM_PROFILE";
}

function AddMissed({ evidenceId, docName, onDone, onCancel }: { evidenceId: string; docName: string; onDone: () => void; onCancel: () => void }) {
  const [cat, setCat] = useState<Cat>("people");
  const [what, setWhat] = useState("");
  const [where, setWhere] = useState("");
  const [missing, setMissing] = useState<null | "blur" | "submit">(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const invalid = !!missing && !what.trim();
  const save = () => {
    if (!what.trim()) {
      setMissing("submit");
      document.getElementById("add-what")?.focus();
      return;
    }
    start(async () => {
      setError(null);
      const page = Number(/page\s*(\d+)/i.exec(where)?.[1]) || null;
      const r = await addManualCandidateAction(evidenceId, { field: fieldFor(cat, what), value: what.trim(), page, line: null, row: null, roleHint: where.trim() || null });
      if (!r.ok) setError(r.error);
      else onDone();
    });
  };
  return (
    <>
      <div className="mhead">
        <div className="lbl">Intake &amp; evidence · {docName}</div>
        <ModalTitle style={{ fontSize: 20, margin: 0 }}>Add Something That Was Missed</ModalTitle>
        <p className="sec" style={{ margin: 0, fontSize: 14 }}>
          A detail in the document that the reader did not pick up. It is added to the list as yours, and the audit records who added it and when.
        </p>
      </div>
      <div className="mbody">
        <div className="fld">
          <span className="lbl" id="cat-l">
            Where does it belong
          </span>
          <div className="row" role="radiogroup" aria-labelledby="cat-l" style={{ gap: 8, flexWrap: "wrap" }}>
            {CATS.map((c) => (
              <button key={c.k} className={`btn sm${cat === c.k ? " primary" : ""}`} type="button" role="radio" aria-checked={cat === c.k} onClick={() => setCat(c.k)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="fld">
          <label className="lbl" htmlFor="add-what">
            What was missed
          </label>
          <input id="add-what" className="in input" type="text" placeholder={CATS.find((c) => c.k === cat)!.hint} value={what} onChange={(e) => { setWhat(e.target.value); setMissing(null); }} onBlur={() => !what.trim() && setMissing("blur")} onFocus={() => missing === "blur" && setMissing(null)} aria-invalid={invalid} style={{ minHeight: 40 }} />
          {invalid ? <span style={{ fontSize: 13, color: C.orange }}>Write what was missed before saving.</span> : null}
        </div>
        <div className="fld">
          <label className="lbl" htmlFor="add-where">
            Where it appears
          </label>
          <input id="add-where" className="in input" type="text" placeholder="FIR page 3, or Receipt 2" value={where} onChange={(e) => setWhere(e.target.value)} style={{ minHeight: 40 }} />
        </div>
        {error ? (
          <div className="banner warn" role="alert">
            <Icon name="alert" />
            <div>{error}</div>
          </div>
        ) : null}
      </div>
      <div className="mfoot" style={{ alignItems: "center" }}>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" type="button" onClick={save} aria-busy={pending}>
          {pending ? "Adding…" : "Add to the list"}
        </button>
      </div>
    </>
  );
}
