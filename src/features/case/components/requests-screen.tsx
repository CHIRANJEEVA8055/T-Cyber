"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import { SortTh, useSort, type SortValue } from "@/components/design/sort";
import type { RequestsViewData } from "@/server/services/requests-view";
import { importInboxReplyAction } from "../actions";
import { ImportReplyFromFile } from "./import-reply-file";
import { NewMailButton } from "@/features/requests/components/new-mail";

type Tab = "all" | "needs" | "waiting" | "answered";
type Imported = { responseId: string; matched: boolean; to: string | null; score: number | null; basis: string; findings: string[]; more: number };
export type ImportStart = { from: "inbox" | "file"; requestId: string | null } | null;
type ReqRow = RequestsViewData["rows"][number];
const REQ_SORT: Record<string, (r: ReqRow) => SortValue> = {
  ref: (r) => r.ref,
  party: (r) => r.party,
  about: (r) => r.about,
  date: (r) => new Date(r.at),
  status: (r) => r.pill.text,
  latest: (r) => r.latest,
};

/** Requests & responses (design: Requests artboard). */
export function RequestsScreen({ refLabel, data, openImport, mailOn = false }: { refLabel: string; data: RequestsViewData; openImport: ImportStart; mailOn?: boolean }) {
  const router = useRouter();
  const b = `/cases/${data.caseId}`;
  const [tab, setTab] = useState<Tab>("all");
  const [help, setHelp] = useState(false);
  const [importing, setImporting] = useState(!!openImport && data.canWrite);
  const [notice, setNotice] = useState<string | null>(null);
  const { rows, sort, toggle } = useSort(
    data.rows.filter((r) => tab === "all" || r.tab === tab),
    REQ_SORT,
  );
  const tabs: { k: Tab; label: string; n?: number }[] = [
    { k: "all", label: "All" },
    { k: "needs", label: "Needs you", n: data.counts.needs },
    { k: "waiting", label: "Waiting for a reply" },
    { k: "answered", label: "Answered" },
  ];
  return (
    <>
      <header className="casehead" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div className="mut" style={{ fontSize: 13 }}>
            <Link href={b}>{refLabel}</Link>
            <span style={{ margin: "0 6px" }} aria-hidden="true">
              /
            </span>
            Requests &amp; Responses
          </div>
          <h1 className="h" style={{ fontSize: 28 }}>
            Requests and Responses
          </h1>
          <p className="sec" style={{ margin: "10px 0 0", fontSize: 15 }}>
            What you have asked for, what came back, and what is still missing. Click a row to open it.
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="iconbtn" type="button" aria-label="Where each kind of request goes" onClick={() => setHelp(true)}>
            <Icon name="help" />
          </button>
          {data.canWrite ? (
            <button className="btn" type="button" aria-haspopup="dialog" onClick={() => setImporting(true)}>
              Import a reply
            </button>
          ) : null}
          {data.canWrite && mailOn ? <NewMailButton caseId={data.caseId} scope="scr-requests" /> : null}
          <Link className="btn primary" href={`${b}/actions`} title="The requests the case calls for, drafted and ranked">
            New request
          </Link>
        </div>
      </header>

      <div className="casepad" style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 1240, width: "100%" }}>
        {notice ? (
          <div className="banner ok" role="status">
            <Icon name="check" />
            <div>{notice}</div>
          </div>
        ) : null}
        <section className="card" style={{ display: "flex", flexDirection: "column" }} aria-labelledby="reqs">
          <div style={{ padding: "20px 28px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <h2 id="reqs" className="h" style={{ fontSize: 18, flex: "1 1 200px" }}>
              All requests{" "}
              <span className="num mut" style={{ fontWeight: 500 }}>
                · {rows.length} shown
              </span>
            </h2>
            <div className="row" role="tablist" aria-label="Filter requests" style={{ flexWrap: "wrap", gap: 4 }}>
              {tabs.map((t) => (
                <button key={t.k} className={`tab${tab === t.k ? " on" : ""}`} type="button" role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}>
                  {t.label}
                  {t.n ? (
                    <span className="cnt num" style={{ marginLeft: 6 }}>
                      {t.n}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table wide">
              <thead>
                <tr>
                  <SortTh k="ref" sort={sort} onSort={toggle}>Ref</SortTh>
                  <SortTh k="party" sort={sort} onSort={toggle}>Party</SortTh>
                  <SortTh k="about" sort={sort} onSort={toggle}>About</SortTh>
                  <SortTh k="date" sort={sort} onSort={toggle}>Date</SortTh>
                  <SortTh k="status" sort={sort} onSort={toggle}>Status</SortTh>
                  <SortTh k="latest" sort={sort} onSort={toggle}>Latest</SortTh>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kind}:${r.id}`} className={`r${r.kind === "reply" ? " reply" : ""}`} onClick={() => router.push(r.href)}>
                    <td className={`num${r.kind === "request" ? " mut" : ""}`}>
                      <Link className="rowbtn" href={r.href} onClick={(e) => e.stopPropagation()}>
                        {r.ref}
                      </Link>
                      <span className="sub">{r.refSub}</span>
                    </td>
                    <td>{r.party}</td>
                    <td>
                      {r.about}
                      <span className="sub">{r.aboutSub}</span>
                    </td>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{r.date}</td>
                    <td>
                      <span className={`pill ${r.pill.tone}`}>{r.pill.text}</span>
                    </td>
                    <td className="sec">{r.latest}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: "40px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 15, fontWeight: 500, color: C.fg }}>{tab === "all" ? "No requests yet" : tab === "needs" ? "Nothing needs you here" : tab === "waiting" ? "Nothing is waiting for a reply" : "Nothing answered yet"}</div>
                      <div className="sec">{tab === "all" ? "Requests are drafted from Next actions." : "Other requests are under All."}</div>
                      <div className="row" style={{ justifyContent: "center", gap: 8, marginTop: 12 }}>
                        {tab !== "all" ? (
                          <button className="btn sm" type="button" onClick={() => setTab("all")}>
                            Show all
                          </button>
                        ) : (
                          <Link className="btn sm primary" href={`${b}/actions`}>
                            Open next actions
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
        <p className="mut" style={{ margin: 0, fontSize: 13 }}>
          Every send goes through a simulated adapter: no email, portal, bank, telecom or NPCI request leaves this computer. Replies arrive in the station inbox as synthetic messages.
        </p>
      </div>

      <DesignModal open={importing} onClose={() => setImporting(false)} scope="scr-requests" maxWidth={640} title="Import a reply">
        {importing ? (
          <ImportReply
            caseId={data.caseId}
            inbox={data.inbox}
            targets={data.replyTargets}
            start={openImport ?? { from: data.inbox.length ? "inbox" : "file", requestId: null }}
            onDone={(text) => {
              setNotice(text);
              router.refresh();
            }}
            onClose={() => setImporting(false)}
          />
        ) : null}
      </DesignModal>

      <DesignModal open={help} onClose={() => setHelp(false)} scope="scr-requests" maxWidth={680}>
        <div className="mhead">
          <span className="lbl">Help</span>
          <ModalTitle style={{ fontSize: 20 }}>Where Each Kind of Request Goes</ModalTitle>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            Drafts are routed for you from the station’s directory. This is what each route needs.
          </p>
        </div>
        <div className="mbody">
          <dl className="inner def" style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0, 180px) 1fr", gap: "10px 16px", padding: "16px 20px", fontSize: 14, lineHeight: 1.5 }}>
            <dt style={{ fontWeight: 500 }}>Phone number</dt>
            <dd style={{ margin: 0 }}>
              UNICROSS at the Zonal ACP; the reply comes back through DD. Needs the FIR number and sections, the number, the period with a reason, whether CAF and IMEI are wanted, and a signed FIR copy.
            </dd>
            <dt style={{ fontWeight: 500 }}>Email or app account</dt>
            <dd style={{ margin: 0 }}>The provider’s law-enforcement portal. Preservation first, then disclosure as a separate submission with a legal process reference.</dd>
            <dt style={{ fontWeight: 500 }}>UPI transaction</dt>
            <dd style={{ margin: 0 }}>NPCI, then the bank or app. Needs the UTR, amount, date and payer VPA. A reference with unreadable digits is held back until verified.</dd>
            <dt style={{ fontWeight: 500 }}>Bank account</dt>
            <dd style={{ margin: 0 }}>The bank’s nodal officer; CFCFRMS for holds. Needs the account and IFSC, the transaction reference, amount, FIR and NCRP numbers. Only verified nodal addresses from the directory are used.</dd>
          </dl>
          <p className="mut" style={{ margin: 0, fontSize: 13 }}>
            Routes and addresses are kept in Settings → Directory. A recipient that is not verified cannot be sent to.
          </p>
        </div>
        <div className="mfoot">
          <Link className="btn" href="/assistant">
            Ask the procedure assistant
          </Link>
          <button className="btn primary" type="button" onClick={() => setHelp(false)}>
            Got it
          </button>
        </div>
      </DesignModal>
    </>
  );
}

function ImportReply({ caseId, inbox, targets, start: begin, onDone, onClose }: { caseId: string; inbox: RequestsViewData["inbox"]; targets: RequestsViewData["replyTargets"]; start: NonNullable<ImportStart>; onDone: (text: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"inbox" | "file">(begin.from);
  const [pick, setPick] = useState<string | null>(inbox[0]?.id ?? null);
  const [done, setDone] = useState<Imported | null>(null);
  const [doneTitle, setDoneTitle] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const chosen = inbox.find((m) => m.id === pick);
  const readIn = () =>
    start(async () => {
      if (!chosen) return;
      setError(null);
      const r = await importInboxReplyAction(caseId, chosen.id, chosen.score >= 70 ? chosen.requestId : null);
      if (!r.ok) return setError(r.error);
      setDoneTitle(chosen.subject);
      setDone(r.data);
      onDone(r.data.matched ? `Read in and matched to ${r.data.to}. Check what it says before it updates the case.` : "Read in. It needs you to pick the request it answers.");
    });
  // Where the reply comes from: the station inbox, or a file the officer has (a letter, a portal download, a pen drive).
  const modes = (
    <div className="row" role="tablist" aria-label="Where the reply is" style={{ gap: 4, flexWrap: "wrap" }}>
      {(
        [
          ["inbox", `From the station inbox${inbox.length ? ` (${inbox.length})` : ""}`],
          ["file", "From a file or letter"],
        ] as const
      ).map(([k, label]) => (
        <button key={k} className={`tab${mode === k ? " on" : ""}`} type="button" role="tab" aria-selected={mode === k} onClick={() => (setMode(k), setError(null))}>
          {label}
        </button>
      ))}
    </div>
  );
  if (duplicate)
    return (
      <>
        <div className="mhead">
          <span className="lbl">Import a reply</span>
          <ModalTitle style={{ fontSize: 20 }}>This Reply Was Already Imported</ModalTitle>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            The same message is already in the case. Importing it again does not make a second copy.
          </p>
        </div>
        <div className="mfoot">
          <button className="btn" type="button" onClick={() => setDuplicate(null)}>
            Back
          </button>
          <Link className="btn primary" href={`/cases/${caseId}/responses/${duplicate}`} onClick={onClose}>
            Open the reply
          </Link>
        </div>
      </>
    );
  if (done)
    return (
      <>
        <div className="mhead">
          <span className="lbl">Import a reply · step 2 of 2</span>
          <ModalTitle style={{ fontSize: 20 }}>{doneTitle ?? "Reply read in"}</ModalTitle>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            Kept with its attachments and their hashes. Nothing in the case changes until you accept what it says.
          </p>
        </div>
        <div className="mbody">
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className={`pill ${done.matched ? "ok" : "wait"}`}>{done.matched ? `Matched to ${done.to}` : "Needs a match"}</span>
          </div>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            {done.basis}
          </p>
          <div>
            <div className="lbl">What was found</div>
            {done.findings.length ? (
              <ul className="list">
                {done.findings.map((f, i) => (
                  <li key={i}>
                    <span className="t" style={{ fontSize: 14 }}>
                      {f}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sec" style={{ margin: "6px 0 0", fontSize: 14 }}>
                Nothing the rules could read as a fact. Open it to read the text yourself.
              </p>
            )}
            {done.more ? (
              <p className="mut" style={{ margin: "6px 0 0", fontSize: 13 }}>
                and {done.more} more
              </p>
            ) : null}
          </div>
        </div>
        <div className="mfoot">
          {mode === "inbox" ? (
            <button className="btn" type="button" onClick={() => { setDone(null); setPick(inbox.find((m) => m.id !== pick)?.id ?? null); }} disabled={inbox.length < 2}>
              Pick a different email
            </button>
          ) : (
            <button className="btn" type="button" onClick={() => setDone(null)}>
              Import another
            </button>
          )}
          <Link className="btn primary" href={`/cases/${caseId}/responses/${done.responseId}`} onClick={onClose}>
            {done.matched ? "Check the reply" : "Pick the request"}
          </Link>
        </div>
      </>
    );
  if (mode === "file")
    return (
      <>
        <div className="mhead">
          <span className="lbl">Import a reply · step 1 of 2</span>
          <ModalTitle style={{ fontSize: 20 }}>Import a Reply from a File or Letter</ModalTitle>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            For a reply that came another way: a letter, a portal download or a pen drive. The files are kept with their hashes; nothing in the case changes until you accept what it says.
          </p>
          {modes}
        </div>
        <ImportReplyFromFile
          caseId={caseId}
          targets={targets}
          initialRequestId={begin.requestId}
          onImported={(r) => {
            if (r.kind === "duplicate") return setDuplicate(r.responseId);
            setDoneTitle("Reply read in from the file");
            setDone(r.summary);
            onDone(r.summary.matched ? `Read in and matched to ${r.summary.to}. Check what it says before it updates the case.` : "Read in. It needs you to pick the request it answers.");
          }}
          footer={(submit) => (
            <div className="mfoot">
              <button className="btn" type="button" onClick={onClose}>
                Cancel
              </button>
              {submit}
            </div>
          )}
        />
      </>
    );
  return (
    <>
      <div className="mhead">
        <span className="lbl">Import a reply · step 1 of 2</span>
        <ModalTitle style={{ fontSize: 20 }}>Which Email Is the Reply?</ModalTitle>
        <p className="sec" style={{ margin: 0, fontSize: 14 }}>
          Unread emails in the station inbox that look like replies to this case. Pick one and it will be matched to a request.
        </p>
        {modes}
      </div>
      <div className="mbody">
        {error ? (
          <div className="banner warn" role="alert">
            <Icon name="alert" />
            <div>{error}</div>
          </div>
        ) : null}
        {inbox.length ? (
          <div role="radiogroup" aria-label="Unread replies" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {inbox.map((m) => (
              <button key={m.id} className={`opt${pick === m.id ? " on" : ""}`} type="button" role="radio" aria-checked={pick === m.id} onClick={() => setPick(m.id)} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: 14, borderRadius: 8, border: `1px solid ${pick === m.id ? "rgba(96,165,250,0.5)" : C.line}`, background: pick === m.id ? "var(--c-tint-blue)" : C.inner, textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", width: "100%" }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 15, fontWeight: 500 }}>
                    {m.from} · {m.subject}
                  </span>
                  <span className="mut" style={{ display: "block", fontSize: 13 }}>
                    {m.when}
                    {m.fromGmail ? " · from Gmail" : ""} · {m.attachments ? `${m.attachments} ${m.attachments === 1 ? "attachment" : "attachments"}` : "no attachments"} · looks like {m.looksLike}
                  </span>
                  {m.suggestion ? (
                    <span className="mut" style={{ display: "block", fontSize: 13, marginTop: 4 }}>
                      {m.suggestion}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="inner" style={{ padding: 24, textAlign: "center" }}>
            <div style={{ fontWeight: 500 }}>Nothing left to import</div>
            <div className="sec" style={{ fontSize: 14 }}>
              No unread email in the station inbox looks like a reply to this case.
            </div>
            <button className="btn sm" type="button" onClick={() => setMode("file")} style={{ marginTop: 12 }}>
              Import it from a file
            </button>
          </div>
        )}
        <p className="mut" style={{ margin: 0, fontSize: 13 }}>
          A reply that came another way (a letter, a portal download, a pen drive) can be{" "}
          <button type="button" className="linkbtn" onClick={() => setMode("file")} style={{ color: C.blue, background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", textDecoration: "underline" }}>
            imported from a file
          </button>
          .
        </p>
      </div>
      <div className="mfoot">
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" type="button" onClick={readIn} disabled={!chosen} aria-busy={pending}>
          {pending ? "Reading it in…" : "Read it in"}
        </button>
      </div>
    </>
  );
}
