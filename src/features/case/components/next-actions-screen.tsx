"use client";

import Link from "next/link";
import { GmailStatus } from "@/features/requests/components/gmail-status";
import { MailWindow } from "@/features/requests/components/mail-window";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import type { NextAction, NextActionsData, SetAside } from "@/server/services/next-actions";
import type { SplitMethod } from "@/server/services/allocation-decision";
import { approveAndSendAction, sendFromGmailAction, prepareAssistantDraftAction, prepareDraftWithoutAddresseeAction, recordSplitAction, updateIdentifierNotesAction } from "../actions";
import { deferTaskAction, dismissTaskAction, reopenTaskAction, completeTaskAction } from "@/features/tasks/actions";
import { markDraftReviewedAction, recordForwardedAction, recordPortalSubmissionAction, requestApprovalAction } from "@/features/requests/actions";
import { setRecipientVerificationAction } from "@/features/settings/actions";
import { copyText, newId } from "@/lib/browser";

type Filter = "all" | "ready" | "waiting" | "deferred";
type Split =
  | { needed: false; held: string; decided: Decided | null }
  | { needed: true; held: string; decided: Decided | null; options: { method: SplitMethod; title: string; detail: string }[]; note: string };
type Decided = { method: SplitMethod; on: string; note: string; split: string | null };

const isReady = (a: NextAction) => (a.kind === "DRAFT" || a.kind === "REMINDER") && !a.deferred && !!a.request?.canApproveAndSend;
const needsSomething = (a: NextAction) => !a.deferred && (a.kind === "BLOCKED" || a.kind === "DECISION" || a.kind === "LEAD" || a.kind === "REQUEST" || ((a.kind === "DRAFT" || a.kind === "REMINDER") && !a.request?.canApproveAndSend));
const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const fmt = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).format(new Date(iso));
const fmtTime = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** What each kind of item a request asks for gives the case. */
const ITEM_USE: Record<string, string> = {
  STATEMENT: "Shows where the remaining money went",
  KYC: "Tests who holds the account on record",
  ATM_DETAILS: "Gives the ATM ID the CCTV request needs",
  LINKED_CONTACTS: "New identity leads",
  CDR: "Who the number called, and from where",
  SUBSCRIBER_DETAILS: "Who the number is registered to",
  ACCOUNT_DETAILS: "Who registered the account or site",
  BENEFICIARY_DETAILS: "Names the accounts the money went to",
  IMEI: "Which handsets used the number",
  HOLD_CONFIRMATION: "Confirms the money is held",
  PRESERVATION_CONFIRMATION: "Stops the records being deleted",
  BALANCE_CONFIRMATION: "What is left in the account",
  IP_LOGS: "Where the account was used from",
};

/** Highlights the facts a letter rests on: amounts, dates, references and masked numbers. */
function Letter({ body, hidden }: { body: string; hidden: Set<string> }) {
  const re = /(₹[\d,]+(?:\.\d\d)?|\b\d{2} [A-Z][a-z]{2} \d{4}(?:, \d{2}:\d{2})?|\bFIR \d+\/\d{4}|\b(?:[PRHU]\.)?(?:REQ|RES)-(?:\d{1,7}\/\d{4}|\d{8,20})-\d{3,5}(?:-R\d+)?|\bREQ-\d{4}-\d{4}|(?:X{4,}|·{3})\d{2,4}|\+91-X+\d{2}|\b[A-Z]{2}\/\d+\/\d+\b)/g;
  const lines = body.split("\n").filter((l) => !hidden.has(l.replace(/^\s*(?:[-•]|\d+[.)])\s*/, "").trim()));
  return (
    <div className="inner letter" style={{ whiteSpace: "pre-wrap" }}>
      {lines.map((l, i) => (
        <p key={i} style={{ minHeight: l.trim() ? undefined : 8 }}>
          {l.split(re).map((part, j) => (j % 2 ? <span key={j} className="hl">{part}</span> : part))}
        </p>
      ))}
    </div>
  );
}

function Banner({ tone, children }: { tone: "ok" | "warn" | "info"; children: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role={tone === "warn" ? "alert" : "status"}>
      <Icon name={tone === "ok" ? "check" : tone === "warn" ? "alert" : "info"} />
      <div>{children}</div>
    </div>
  );
}

/**
 * What is missing before a request can be addressed, and how to find it, step by step from what the case holds.
 * The detail can be recorded here; the request is then drafted (or the blank draft addressed) straight away.
 */
function GapGuide({ gap, canWrite, onRecorded }: { gap: NonNullable<NextAction["gap"]>; canWrite: boolean; onRecorded: () => void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [pending, start] = useTransition();
  const fieldId = `gap-${gap.record?.entityId ?? "x"}`;
  const check = (v: string) => (!v.trim() ? `Enter the ${gap.record?.field === "bank" ? "bank or IFSC" : "name"} first.` : null);
  const save = () => {
    const problem = check(value);
    setTouched(true);
    if (problem) return setErr(problem);
    start(async () => {
      const v = value.trim();
      const ifsc = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(v);
      const res = await updateIdentifierNotesAction(gap.record!.entityId, gap.record!.field === "bank" ? (ifsc ? { ifsc: v } : { bank: v }) : { provider: v });
      if (!res.ok) return setErr(res.error);
      setValue("");
      onRecorded();
    });
  };
  return (
    <section className="gapguide" aria-label="What is missing and how to find it">
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <Icon name="alert" />
        <div>
          <div style={{ fontWeight: 600 }}>{gap.missing}</div>
          <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
            {gap.why}
          </div>
        </div>
      </div>
      <div className="lbl" style={{ marginTop: 14 }}>
        How to find it
      </div>
      <ol className="gapsteps">
        {gap.steps.map((st, i) => (
          <li key={i}>
            {st.text}
            {st.link ? (
              <>
                {" "}
                <Link href={st.link.href} target={st.link.href.startsWith("/assistant") ? "_blank" : undefined} style={{ color: C.blue, whiteSpace: "nowrap" }}>
                  {st.link.label}
                </Link>
              </>
            ) : null}
          </li>
        ))}
      </ol>
      {gap.record && canWrite ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 14 }}
        >
          <label htmlFor={fieldId} style={{ fontSize: 14, fontWeight: 500 }}>
            {gap.record.label}
          </label>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input
              id={fieldId}
              className="input"
              value={value}
              placeholder={gap.record.placeholder}
              autoComplete="off"
              aria-invalid={!!err}
              aria-describedby={`${fieldId}-hint`}
              onFocus={() => setErr(null)}
              onBlur={() => touched && setErr(check(value))}
              onChange={(e) => setValue(e.target.value)}
              style={{ minHeight: 40, flex: "1 1 220px" }}
            />
            <button className="btn" type="submit" aria-busy={pending}>
              {pending ? "Saving…" : "Save and address"}
            </button>
          </div>
          <span id={`${fieldId}-hint`} className="mut" role={err ? "alert" : undefined} style={{ fontSize: 13, color: err ? C.red : undefined }}>
            {err ?? `${gap.record.hint} Logged against the identifier; what any record said is unchanged.`}
          </span>
        </form>
      ) : null}
    </section>
  );
}

const footStyle = { position: "sticky", bottom: 0, background: C.card, padding: "20px 28px", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${C.line}` } as const;

export function NextActionsScreen({ caseId, refLabel, data, split, canWrite, initialRank }: { caseId: string; refLabel: string; data: NextActionsData; split: Split | null; canWrite: boolean; initialRank: number | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [openRank, setOpenRank] = useState<number | null>(initialRank && data.actions.some((a) => a.rank === initialRank) ? initialRank : null);
  // Keep the opened action's details while the list refreshes underneath (a sent request moves, a decision completes).
  const [snapshot, setSnapshot] = useState<NextAction | null>(null);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The card that opened the dialog gets focus back when it closes (it keeps its node across refreshes).
  const opener = useRef<string | null>(null);

  const shown = data.actions.filter((a) => filter === "all" || (filter === "ready" && isReady(a)) || (filter === "waiting" && needsSomething(a)) || (filter === "deferred" && a.deferred));
  const live = openRank !== null ? (data.actions.find((a) => a.rank === openRank && (!snapshot || a.taskId === snapshot.taskId)) ?? data.actions.find((a) => a.taskId === snapshot?.taskId) ?? null) : null;
  const selected = live ?? snapshot;
  const open = (a: NextAction) => {
    if (!snapshot) opener.current = a.taskId;
    setSnapshot(a);
    setOpenRank(a.rank);
    setError(null);
  };
  const close = () => {
    setOpenRank(null);
    setSnapshot(null);
    setError(null);
  };
  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "All", n: data.counts.all },
    { key: "ready", label: "Ready to send", n: data.counts.ready },
    { key: "waiting", label: "Needs Action", n: data.counts.waiting },
    { key: "deferred", label: "Deferred", n: data.counts.deferred },
  ];
  const reopen = (s: SetAside) =>
    start(async () => {
      if (!s.id || s.taskVersion === null) return;
      const r = await reopenTaskAction(s.id, s.taskVersion);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });

  return (
    <>
      <header className="casehead" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div className="mut" style={{ fontSize: 13 }}>
            <Link href={`/cases/${caseId}`}>{refLabel}</Link>
            <span style={{ margin: "0 6px" }} aria-hidden="true">
              /
            </span>
            Next Actions
          </div>
          <h1 className="h" style={{ fontSize: 28 }}>
            Next Actions
          </h1>
          <p className="sec" style={{ margin: "10px 0 0", fontSize: 15 }}>
            Ranked by what unblocks the most. Click an action to Open, Approve and Send it.
          </p>
        </div>
        <div className="row" role="tablist" aria-label="Filter actions" style={{ flexWrap: "wrap", gap: 4, padding: 4, borderRadius: 12, background: C.panel, border: `1px solid ${C.line}` }}>
          {tabs.map((t) => (
            <button key={t.key} className={`tab${filter === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={filter === t.key} onClick={() => setFilter(t.key)}>
              {t.label}{" "}
              <span className="num mut">{t.n}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="casepad" style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 1240, width: "100%" }}>
        {error && !selected ? (
          <Banner tone="warn">
            {error}
          </Banner>
        ) : null}
        <section aria-label="Ranked actions" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          {shown.map((a) => (
            <button key={a.taskId} data-task={a.taskId} className={`card act${selected?.taskId === a.taskId ? " sel" : ""}`} type="button" aria-pressed={selected?.taskId === a.taskId} aria-haspopup="dialog" onClick={() => open(a)}>
              <span className="n">{a.rank}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="row" style={{ justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <span className="t">{a.line || a.title}</span>
                  <span className={`pill ${a.status.tone}`}>{a.status.text}</span>
                </span>
                {a.deferred && a.deferredNote ? (
                  <span className="why" style={{ display: "block" }}>
                    Deferred: {a.deferredNote}
                  </span>
                ) : null}
                <span className="meta" style={{ display: "block" }}>
                  {a.objective}
                </span>
              </span>
            </button>
          ))}
          {shown.length === 0 ? (
            <div className="inner card" style={{ padding: 32, textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>{filter === "deferred" ? "Nothing deferred" : filter === "ready" ? "Nothing ready to send" : filter === "waiting" ? "Nothing waiting on anything" : "No open actions"}</div>
              <div className="sec" style={{ marginTop: 4 }}>
                {filter === "deferred" ? "Actions you defer appear in this list." : filter === "all" ? "New actions appear when a reply or a new record changes what the case needs." : "Other actions are under All."}
              </div>
              {filter !== "all" ? (
                <button className="btn sm" type="button" style={{ marginTop: 12 }} onClick={() => setFilter("all")}>
                  Show all actions
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 4 }}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <h2 className="h" style={{ fontSize: 16 }}>
                Leads Set Aside
              </h2>
              <span className="mut" style={{ fontSize: 13 }}>
                New evidence can reopen any of them
              </span>
            </div>
            {data.setAside.length === 0 ? (
              <p className="sec" style={{ margin: "8px 0 0", fontSize: 14 }}>
                Nothing has been set aside. A lead you dismiss stays here with your reason, so it can be reopened.
              </p>
            ) : (
              data.setAside.map((s) => (
                <div key={`${s.title}:${s.label}`} className="row" style={{ justifyContent: "space-between", gap: 12, padding: "10px 0", fontSize: 14, borderTop: `1px solid ${C.lineSoft}` }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {s.title}
                    <span className="mut" style={{ display: "block", fontSize: 13 }}>
                      {s.reason}
                    </span>
                  </span>
                  <span className="row" style={{ gap: 8 }}>
                    {s.label === "Reopened" ? (
                      <span className="pill gap">{s.rankNow ? `Reopened · action ${s.rankNow}` : "Reopened"}</span>
                    ) : (
                      <span className="pill neutral">{s.label}</span>
                    )}
                    {s.canReopen && canWrite ? (
                      <button className="btn sm" type="button" disabled={pending} onClick={() => reopen(s)}>
                        Reopen
                      </button>
                    ) : null}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <DesignModal open={!!selected} onClose={close} scope="scr-next-actions" title={selected ? `${selected.title}` : undefined} returnFocusTo={() => (opener.current ? document.querySelector<HTMLElement>(`button[data-task="${CSS.escape(opener.current)}"]`) : null)}>
        {selected ? <ActionDialog key={selected.taskId} caseId={caseId} a={selected} all={data.actions} split={split} canWrite={canWrite} onOpen={open} onClose={close} /> : null}
      </DesignModal>
    </>
  );
}

function ActionDialog({ caseId, a, all, split, canWrite, onOpen, onClose }: { caseId: string; a: NextAction; all: NextAction[]; split: Split | null; canWrite: boolean; onOpen: (a: NextAction) => void; onClose: () => void }) {
  // With Gmail, the draft opens as the mail itself, every part editable in place (see MailWindow).
  if (a.request && a.request.gmail.on && (a.kind === "DRAFT" || a.kind === "REMINDER" || a.kind === "SENT")) return <MailDraftDialog a={a} all={all} canWrite={canWrite} onOpen={onOpen} />;
  if (a.request && (a.kind === "DRAFT" || a.kind === "REMINDER" || a.kind === "SENT")) return <DraftDialog caseId={caseId} a={a} all={all} canWrite={canWrite} onOpen={onOpen} />;
  if (a.kind === "BLOCKED") return <BlockedDialog caseId={caseId} a={a} all={all} canWrite={canWrite} onOpen={onOpen} />;
  if ((a.kind === "DECISION" || a.kind === "DECIDED") && a.ruleId === "FUNDS_ALLOCATION_BASIS" && split) return <SplitDialog caseId={caseId} a={a} split={split} canWrite={canWrite} />;
  return <TaskDialog caseId={caseId} a={a} canWrite={canWrite} onClose={onClose} />;
}

function Head({ label, a, title, sub }: { label: string; a: NextAction; title: string; sub: ReactNode }) {
  return (
    <div style={{ padding: "24px 68px 24px 28px", display: "flex", flexDirection: "column", gap: 10, borderBottom: `1px solid ${C.line}` }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="lbl">{label}</span>
        <span className={`pill ${a.status.tone}`}>{a.status.text}</span>
      </div>
      {/* Identifiers (emails, URLs) are long unbroken strings: they wrap instead of running off a phone screen. */}
      <ModalTitle style={{ fontSize: 20, overflowWrap: "anywhere" }}>{title}</ModalTitle>
      <p className="sec" style={{ margin: 0, fontSize: 14, overflowWrap: "anywhere" }}>
        {sub}
      </p>
    </div>
  );
}

/** Defer with a reason, inline in the dialog's footer. */
function DeferForm({ a, onDone, onCancel }: { a: NextAction; onDone: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const invalid = touched && reason.trim().length < 3;
  const submit = () => {
    setTouched(true);
    if (reason.trim().length < 3) return;
    start(async () => {
      const r = await deferTaskAction(a.taskId, a.taskVersion, "", reason);
      if (!r.ok) setError(r.error);
      else onDone();
    });
  };
  return (
    <div style={{ ...footStyle, justifyContent: "flex-start", alignItems: "flex-end" }}>
      <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="defer-reason" style={{ fontSize: 14, fontWeight: 500 }}>
          Why defer it?
        </label>
        <input id="defer-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)} onFocus={() => setTouched(false)} aria-invalid={invalid} aria-describedby="defer-hint" style={{ minHeight: 40 }} />
        <span id="defer-hint" className="mut" style={{ fontSize: 13, color: invalid ? C.orange : undefined }}>
          {error ?? (invalid ? "Give a short reason; it is kept with the action." : "Kept with the action. It is re-checked against the case before it can be sent.")}
        </span>
      </div>
      <button className="btn" type="button" onClick={onCancel}>
        Cancel
      </button>
      <button className="btn primary" type="button" onClick={submit} aria-busy={pending}>
        {pending ? "Deferring…" : "Defer action"}
      </button>
    </div>
  );
}

/**
 * A drafted request when mail goes through Gmail: the mail window, with To, subject, text, what it asks for and the
 * files editable in place and saved as typed. Defer sets it aside with a reason; Preview shows it as it goes; Send
 * checks every field and sends it from the linked Gmail account.
 */
function MailDraftDialog({ a, all, canWrite, onOpen }: { a: NextAction; all: NextAction[]; canWrite: boolean; onOpen: (a: NextAction) => void }) {
  const r = a.request!;
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "defer">("idle");
  const [note, setNote] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const dependants = all.filter((x) => x.blockedBy?.rank === a.rank);
  const label = a.kind === "SENT" ? `Sent · ${r.reference}` : a.kind === "REMINDER" ? `Reminder · ${r.reference}` : `Draft · ${r.reference}`;
  const title = r.unaddressed ? `Request about ${r.unaddressed.addressee}` : r.recipient.type === "BANK" ? `Request to ${r.recipient.org}’s nodal officer` : `Request to ${r.recipient.org}`;
  const sub = dependants.length ? `Ranked ${ORDINAL[a.rank - 1] ?? `number ${a.rank}`} because ${dependants.map((d) => `action ${d.rank}`).join(" and ")} ${dependants.length === 1 ? "depends" : "depend"} on it.` : a.why;
  const next = all.find((x) => x.rank > a.rank && isReady(x));
  // Recording the missing bank or provider rewrites the draft to that addressee; the window then shows the new text.
  const readdress = () =>
    start(async () => {
      setError(null);
      const res = await prepareAssistantDraftAction(a.taskId);
      if (!res.ok) setError(res.error);
      else {
        setNote(`Recorded, and ${res.data.reference} is rewritten to that addressee. Check the address and the text, then send.`);
        setReload((n) => n + 1);
        router.refresh();
      }
    });
  const restore = () =>
    start(async () => {
      const res = await reopenTaskAction(a.taskId, a.taskVersion);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  const canDefer = canWrite && a.kind !== "SENT" && !a.taskId.startsWith("reminder:") && !a.deferred;
  return (
    <>
      <MailWindow
        key={`${r.id}:${reload}`}
        requestId={r.id}
        head={() => <Head label={label} a={a} title={title} sub={sub} />}
        hideFooter={step === "defer"}
        onSent={() => router.refresh()}
        extra={
          <>
            {note ? <Banner tone="ok">{note}</Banner> : null}
            {error ? <Banner tone="warn">{error}</Banner> : null}
            {a.deferred ? <Banner tone="warn">Deferred: {a.deferredNote}. The draft is kept; restore it to send it.</Banner> : null}
            {r.unaddressed?.gap && a.kind !== "SENT" ? (
              <details className="mw-box">
                <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 500 }}>Not sure where to send it? {r.unaddressed.gap.missing}</summary>
                <div style={{ marginTop: 12 }}>
                  <GapGuide gap={r.unaddressed.gap} canWrite={canWrite} onRecorded={readdress} />
                </div>
              </details>
            ) : null}
          </>
        }
        footerStart={
          <>
            {canDefer ? (
              <button className="btn" type="button" onClick={() => setStep("defer")}>
                Defer
              </button>
            ) : null}
            {a.deferred && canWrite ? (
              <button className="btn" type="button" onClick={restore} aria-busy={pending}>
                {pending ? "Restoring…" : "Restore"}
              </button>
            ) : null}
            {a.kind === "SENT" && next ? (
              <button className="btn primary" type="button" onClick={() => onOpen(next)}>
                Next action
              </button>
            ) : null}
          </>
        }
      />
      {step === "defer" ? (
        <DeferForm
          a={a}
          onCancel={() => setStep("idle")}
          onDone={() => {
            setStep("idle");
            setNote("Deferred. The draft is kept; restore it from the Deferred list when you are ready.");
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function DraftDialog({ caseId, a, all, canWrite, onOpen }: { caseId: string; a: NextAction; all: NextAction[]; canWrite: boolean; onOpen: (a: NextAction) => void }) {
  const r = a.request!;
  const router = useRouter();
  const [keep, setKeep] = useState<Set<string>>(() => new Set(r.items.map((i) => i.id)));
  const [step, setStep] = useState<"idle" | "confirm" | "defer" | "portal" | "verify" | "review" | "forwarded">("idle");
  // v1 delivery: approved requests are mailed to the PS IO's mailbox, and the IO forwards them from their own mailbox.
  const viaIo = r.delivery.viaIo;
  // Gmail (prototype): approved requests are sent from the linked Gmail account to the address the officer types.
  const viaGmail = r.gmail.on;
  const [gmailTo, setGmailTo] = useState(r.gmail.to);
  const [handedAt, setHandedAt] = useState<string | null>(r.delivery.handedOverAt);
  const [fwdAt, setFwdAt] = useState("");
  const [fwdNote, setFwdNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [result, setResult] = useState<null | { kind: "sent"; text: string } | { kind: "failed"; text: string } | { kind: "info"; text: string }>(null);
  const [error, setError] = useState<string | null>(null);
  const [portalRef, setPortalRef] = useState("");
  const [pending, start] = useTransition();
  const [key] = useState(() => `na:${r.id}:${r.version}:${newId()}`);
  const dependants = all.filter((x) => x.blockedBy?.rank === a.rank);
  const canScope = canWrite && r.mode === "APPROVE_AND_SEND" && r.authoredByAssistant && r.status === "DRAFT" && r.items.length > 1;
  const hidden = useMemo(() => new Set(r.items.filter((i) => !keep.has(i.id)).map((i) => i.label.trim())), [keep, r.items]);
  const scoped = keep.size !== r.items.length;
  const isSent = a.kind === "SENT" || result?.kind === "sent";
  const short = r.recipient.org.split(",")[0];
  const label = a.kind === "SENT" ? `Sent · ${r.reference}` : a.kind === "REMINDER" ? "Reminder" : `Draft · ${r.reference}`;
  const title = r.recipient.type === "BANK" ? `Request to ${r.recipient.org}’s nodal officer` : `Request to ${r.recipient.org}`;
  const sub = dependants.length
    ? `Ranked ${ORDINAL[a.rank - 1] ?? `number ${a.rank}`} because ${dependants.map((d) => `action ${d.rank}`).join(" and ")} ${dependants.length === 1 ? "depends" : "depend"} on it. ${r.needsReview ? "" : "Facts unchanged since the draft was made."}`
    : a.why;

  const send = () =>
    start(async () => {
      setError(null);
      const res = await approveAndSendAction(r.id, r.version, scoped ? [...keep] : null, key);
      if (!res.ok) {
        setError(res.error);
        setStep("idle");
        return;
      }
      const o = res.data;
      if (o.outcome === "HANDED_OVER") {
        setStep("idle");
        setHandedAt(o.at);
        setResult({
          kind: "info",
          text: `Approved and mailed to ${o.to}${o.transport === "SIMULATED" ? " (simulated: kept in T-CYBER, nothing left this server)" : ""}${o.attachments ? ` with ${o.attachments} ${o.attachments === 1 ? "attachment" : "attachments"}` : ""}. Forward it to ${short} (${r.recipient.address}) from your mailbox, then choose “Mark as forwarded”.`,
        });
      } else if (o.outcome === "PORTAL") {
        setStep("portal");
        setResult({ kind: "info", text: `Approved. ${short} takes this request on its law-enforcement portal: submit it there, then record the reference the portal gives.` });
      } else if (o.outcome === "FAILED") {
        setStep("idle");
        setResult({ kind: "failed", text: `The simulated send failed: ${o.error} Nothing left the station. Send it again when ready.` });
      } else {
        setStep("idle");
        if (o.outcome !== "SUCCEEDED") return;
        setResult({
          kind: "sent",
          text: `Sent ${fmt(o.at)}, ${fmtTime(o.at)} to ${short}${o.attachments ? ` with ${o.attachments} ${o.attachments === 1 ? "attachment" : "attachments"}` : ""}, through the simulated ${o.channel === "UNICROSS" ? "UNICROSS" : o.channel === "NPCI_ROUTE" ? "NPCI" : "mail"} adapter: nothing left this computer. ${o.externalReference ? `Receipt ${o.externalReference} is in the audit log. ` : ""}Tracked as ${o.reference}${o.followUpAt ? `; if nothing comes back by ${fmt(o.followUpAt)}, a reminder is drafted for you` : ""}.`,
        });
      }
      router.refresh();
    });
  const sendGmail = () =>
    start(async () => {
      setError(null);
      const res = await sendFromGmailAction(r.id, r.version, scoped ? [...keep] : null, gmailTo, key);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const o = res.data;
      setStep("idle");
      if (o.outcome === "FAILED") setResult({ kind: "failed", text: o.error });
      else if (o.outcome === "SUCCEEDED")
        setResult({
          kind: "sent",
          text: `Sent from ${r.gmail.account ?? "Gmail"} to ${gmailTo.trim()} on ${fmt(o.at)}, ${fmtTime(o.at)}${o.attachments ? `, with ${o.attachments} ${o.attachments === 1 ? "attachment" : "attachments"}` : ""}. It is in that account's Sent folder. Tracked as ${o.reference}${o.followUpAt ? `; if nothing comes back by ${fmt(o.followUpAt)}, a reminder is drafted for you` : ""}.`,
        });
      router.refresh();
    });
  const askApproval = () =>
    start(async () => {
      const res = await requestApprovalAction(r.id, r.version);
      if (!res.ok) setError(res.error);
      else {
        setResult({ kind: "info", text: "Sent for approval. It appears in the approver’s list; you are told when it is approved." });
        router.refresh();
      }
    });
  const markReviewed = () =>
    start(async () => {
      setError(null);
      const res = await markDraftReviewedAction(r.id, r.version, reviewNote.trim());
      if (!res.ok) setError(res.error);
      else {
        setStep("idle");
        setResult({ kind: "info", text: "Marked as reviewed, with your note in the log. It can be approved and sent now." });
        router.refresh();
      }
    });
  const readdress = () =>
    start(async () => {
      setError(null);
      const res = await prepareAssistantDraftAction(a.taskId);
      if (!res.ok) setError(res.error);
      else {
        setResult({ kind: "info", text: r.unaddressed ? `Addressed. ${res.data.reference} keeps its reference; check the address and the wording before it is sent.` : `Re-addressed to the provider on the nodal officer list. ${res.data.reference} keeps its reference; check the new address before it is sent.` });
        router.refresh();
      }
    });
  const verify = () =>
    start(async () => {
      setError(null);
      const res = await setRecipientVerificationAction(r.recipient.id, true, `Checked against the nodal officer list for ${r.recipient.org} before sending ${r.reference}`);
      if (!res.ok) setError(res.error);
      else {
        setStep("idle");
        setResult({ kind: "info", text: `${r.recipient.address} is verified for ${r.recipient.org} and logged with your name. You can approve and send the request now.` });
        router.refresh();
      }
    });
  const recordPortal = () =>
    start(async () => {
      const fresh = all.find((x) => x.request?.id === r.id)?.request;
      const res = await recordPortalSubmissionAction(r.id, fresh?.version ?? r.version + 2, portalRef);
      if (!res.ok) setError(res.error);
      else {
        setStep("idle");
        setResult({ kind: "sent", text: `Recorded as submitted on ${short}’s portal with reference ${portalRef.trim()}. Tracked as ${r.reference}.` });
        router.refresh();
      }
    });
  const recordFwd = () =>
    start(async () => {
      setError(null);
      const fresh = all.find((x) => x.request?.id === r.id)?.request ?? r;
      const res = await recordForwardedAction(r.id, fresh.version, fwdAt || null, fwdNote.trim() || null);
      if (!res.ok) setError(res.error);
      else {
        setStep("idle");
        setResult({ kind: "sent", text: `Recorded as forwarded to ${short} (${r.recipient.address})${fwdAt ? "" : " just now"}. Tracked as ${r.reference}; its follow-up dates start from when it was forwarded.` });
        router.refresh();
      }
    });
  const forwardText = `To: ${r.recipient.address}\nSubject: ${r.subject}\n\n${r.body}`;
  const mailto = `mailto:${encodeURIComponent(r.recipient.address)}?subject=${encodeURIComponent(r.subject)}&body=${encodeURIComponent(r.body)}`;
  const approvedNow = ["APPROVED", "SUBMISSION_FAILED"].includes(r.status) || !!handedAt;
  const next = all.find((x) => x.rank > a.rank && isReady(x));

  return (
    <>
      <Head label={label} a={a} title={title} sub={sub} />
      <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 20 }}>
        {result ? <Banner tone={result.kind === "sent" ? "ok" : result.kind === "failed" ? "warn" : "info"}>{result.text}</Banner> : null}
        {!result && a.kind === "SENT" && r.sent ? (
          <Banner tone="ok">
            {r.sent.how?.startsWith("Forwarded by")
              ? `Forwarded ${fmt(r.sent.at)}, ${fmtTime(r.sent.at)} to ${short} from the IO's own mailbox (${r.sent.how.replace(/ from their own mailbox.*$/, "").replace(/^Forwarded by /, "recorded by ")}). ${r.sent.receipt ? `Note: ${r.sent.receipt}. ` : ""}`
              : `Sent ${fmt(r.sent.at)}, ${fmtTime(r.sent.at)} through the simulated adapter: nothing left this computer. ${r.sent.receipt ? `Receipt ${r.sent.receipt} is in the audit log. ` : ""}`}
            {r.sent.followUpAt ? `If nothing comes back by ${fmt(r.sent.followUpAt)}, a reminder is drafted for you.` : ""}
          </Banner>
        ) : null}
        {a.deferred ? <Banner tone="warn">Deferred: {a.deferredNote}. The draft is kept and is re-checked against the case before it can be sent.</Banner> : null}
        {r.unaddressed && !isSent ? (
          r.unaddressed.gap ? (
            <GapGuide gap={r.unaddressed.gap} canWrite={canWrite} onRecorded={readdress} />
          ) : (
            <Banner tone="info">The missing detail is recorded now. Address the draft; it can then be approved and sent.</Banner>
          )
        ) : null}
        {r.needsReview && !isSent && !r.unaddressed ? <Banner tone="warn">Check before sending: {r.needsReview}</Banner> : null}
        {error ? <Banner tone="warn">{error}</Banner> : null}
        <div className="kv">
          <span className="k">To</span>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {r.unaddressed ? <>Not addressed yet: for {r.unaddressed.addressee}</> : r.recipient.address}{" "}
            {r.unaddressed ? null : <span className="mut">· {r.recipient.verified ? `verified${r.recipient.verifiedOn ? ` ${r.recipient.verifiedOn}` : ""}` : "not verified"}</span>}
            {r.recipient.nodal.length ? (
              <span className="mut" style={{ display: "block", fontSize: 13, marginTop: 4 }}>
                On the nodal officer list for {r.recipient.org}: {r.recipient.nodal.map((n) => `${n.emails.join(", ")}${n.officer ? ` (${n.officer})` : ""}`).join("; ")}
                {r.recipient.nodal.some((n) => n.emails.includes(r.recipient.address.toLowerCase())) ? " · matches the To address" : " · check the To address against it"}
              </span>
            ) : null}
          </span>
          <span className="k">From</span>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {r.gmail.on ? (
              <>
                {r.gmail.account ?? "the linked Gmail account"} <span className="mut">· linked Gmail account</span>
              </>
            ) : (
              <>
                {r.from.address} <span className="mut">· {r.from.station ? "station mailbox" : "set on this draft"}</span>
              </>
            )}
          </span>
          <span className="k">Subject</span>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{r.subject}</span>
        </div>
        <Letter body={r.body} hidden={hidden} />
        {canScope && !isSent ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="lbl" style={{ marginBottom: 4 }}>
              What to ask for
            </legend>
            {r.items.map((i) => {
              const unblocks = i.itemType === "ATM_DETAILS" ? dependants.find((d) => d.ruleId === "EVIDENCE_ATM_CCTV") : undefined;
              return (
                <label key={i.id} className="chk">
                  <input
                    type="checkbox"
                    checked={keep.has(i.id)}
                    onChange={() => {
                      const n = new Set(keep);
                      if (n.has(i.id)) n.delete(i.id);
                      else n.add(i.id);
                      setKeep(n);
                    }}
                  />
                  <span>
                    {i.label}
                    <span className="d">{unblocks ? `Unblocks action ${unblocks.rank}` : (ITEM_USE[i.itemType] ?? "Asked for by the rules for this kind of request")}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : (
          <div>
            <div className="lbl">Asks for</div>
            <ul style={{ margin: "8px 0 0", paddingLeft: 20, fontSize: 14, lineHeight: 1.6 }}>
              {r.items.filter((i) => result?.kind !== "sent" || keep.has(i.id)).map((i) => (
                <li key={i.id}>{i.label}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className="lbl">Attached</div>
          {r.attachments.length ? (
            r.attachments.map((f) => (
              <div key={f.id} className="row" style={{ justifyContent: "space-between", padding: "8px 0", fontSize: 14 }}>
                <a href={`/api/evidence/${f.id}/file`} target="_blank" rel="noopener" style={{ color: C.blue }}>
                  {f.fileName}
                </a>
                <span className="mut" style={{ fontSize: 13 }}>
                  {f.title}
                </span>
              </div>
            ))
          ) : (
            <p className="mut" style={{ margin: "6px 0 0", fontSize: 14 }}>
              Nothing attached. Add the FIR copy in the request editor if the recipient asks for it.
            </p>
          )}
        </div>
        <div>
          <div className="lbl">Letter for printing</div>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
            <a className="btn" href={`/api/requests/${r.id}/letter?format=pdf`} download>
              <Icon name="download" /> PDF
            </a>
            <a className="btn" href={`/api/requests/${r.id}/letter?format=docx`} download>
              <Icon name="download" /> Word
            </a>
            <span className="mut" style={{ fontSize: 13 }}>
              {["APPROVED", "SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE"].includes(r.status)
                ? "On the station letterhead, as approved, to print and send by hand or post."
                : r.unaddressed
                  ? "Marked DRAFT until the addressee is recorded."
                  : r.demoAddress
                    ? "Marked DRAFT until it is re-addressed."
                    : !r.recipient.verified
                      ? "Marked DRAFT until the address is verified."
                      : r.needsReview
                        ? "Marked DRAFT until it is checked (see above)."
                        : "Ready to print on the station letterhead: the address is verified. Approval is needed only to send it from here."}
            </span>
          </div>
        </div>
        {viaIo && approvedNow && !isSent && !r.unaddressed ? (
          <section className="fwd" aria-label="Forward it from your mailbox">
            <div className="lbl">Forward it from your mailbox</div>
            <p style={{ margin: "6px 0 10px", fontSize: 14 }}>
              {handedAt
                ? `Mailed to ${r.delivery.handedOverTo ?? r.delivery.ioMailbox} on ${fmt(handedAt)}, ${fmtTime(handedAt)}. Forward that mail to ${short}, or send it from here, then mark it as forwarded.`
                : `Approved. Mail it to the IO mailbox (${r.delivery.ioMailbox}) or send it from your mail program now, then mark it as forwarded.`}
            </p>
            <div className="kv" style={{ marginBottom: 10 }}>
              <span className="k">To</span>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{r.recipient.address}</span>
              <span className="k">Subject</span>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{r.subject}</span>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <a className="btn" href={mailto}>
                Open in mail app
              </a>
              <button className="btn" type="button" onClick={async () => setCopied(await copyText(forwardText))}>
                {copied ? "Copied" : "Copy the draft"}
              </button>
              <a className="btn" href={`/api/requests/${r.id}/eml`} download>
                <Icon name="download" /> Email file (.eml)
              </a>
            </div>
            <p className="mut" style={{ margin: "8px 0 0", fontSize: 13 }}>
              {r.attachments.length ? "The mail app link carries the text only: attach the files listed above yourself, or use the email file, which has them." : "Nothing to attach."} The email file opens as a ready-to-send mail in Outlook and most mail programs.
            </p>
          </section>
        ) : null}
        <p className="mut" style={{ margin: 0, fontSize: 13 }}>
          {r.approvalNote} If the wording is edited after approval, the approval is withdrawn and the draft comes back here.{" "}
          {canScope && !isSent ? <span style={{ color: keep.size ? C.mut : C.orange }}>{keep.size ? `${keep.size} of ${r.items.length} items in scope.` : "Tick at least one item to send."}</span> : null}
        </p>
        <GmailStatus requestId={r.id} g={r.gmail} canWrite={canWrite && r.mode !== "VIEW"} sent={isSent} />
      </div>

      {step === "defer" ? (
        <DeferForm a={a} onCancel={() => setStep("idle")} onDone={() => { setStep("idle"); setResult({ kind: "info", text: "Deferred. The draft is kept; restore it from the Deferred list when you are ready." }); router.refresh(); }} />
      ) : step === "confirm" && viaGmail ? (
        <div style={{ ...footStyle, justifyContent: "flex-start", alignItems: "flex-end", gap: 12, background: "var(--c-tint-blue)" }}>
          <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="gmail-to" style={{ fontSize: 14, fontWeight: 500 }}>
              Send to
            </label>
            <input id="gmail-to" className="input" type="text" inputMode="email" autoComplete="off" value={gmailTo} onChange={(e) => setGmailTo(e.target.value)} placeholder="nodal.officer@bank.in" style={{ minHeight: 40 }} aria-describedby="gmail-to-hint" autoFocus />
            <span id="gmail-to-hint" className="mut" style={{ fontSize: 12 }}>
              {`${r.mode === "APPROVE_AND_SEND" ? "Approves it, then sends" : "Sends"} it from ${r.gmail.account ?? "the linked Gmail account"} with ${keep.size} ${keep.size === 1 ? "item" : "items"} and ${r.attachments.length ? `${r.attachments.length} ${r.attachments.length === 1 ? "attachment" : "attachments"}` : "no attachments"}. Several addresses: separate them with commas. This is logged.`}
            </span>
          </div>
          <button className="btn" type="button" onClick={() => setStep("idle")}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={sendGmail} aria-busy={pending} disabled={!gmailTo.trim() || !r.gmail.connected}>
            {pending ? "Sending…" : r.mode === "APPROVE_AND_SEND" ? "Approve and send" : "Send from Gmail"}
          </button>
        </div>
      ) : step === "confirm" ? (
        <div style={{ ...footStyle, justifyContent: "flex-start", alignItems: "center", gap: 12, background: "var(--c-tint-blue)" }}>
          <div style={{ flex: "1 1 240px", fontSize: 15 }}>
            {viaIo
              ? `${r.mode === "APPROVE_AND_SEND" ? "Approve it and mail" : "Mail"} it to the IO mailbox (${r.delivery.ioMailbox}) to forward to ${short}, with ${keep.size} ${keep.size === 1 ? "item" : "items"} and ${r.attachments.length ? `${r.attachments.length} ${r.attachments.length === 1 ? "attachment" : "attachments"}` : "no attachments"}? Nothing goes to ${short} until it is forwarded. This is logged.`
              : `Send to ${short} now, with ${keep.size} ${keep.size === 1 ? "item" : "items"} and ${r.attachments.length ? `${r.attachments.length} ${r.attachments.length === 1 ? "attachment" : "attachments"}` : "no attachments"}? This is logged.`}
          </div>
          <button className="btn" type="button" onClick={() => setStep("idle")} autoFocus>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={send} aria-busy={pending}>
            {pending ? (viaIo ? "Mailing…" : "Sending…") : viaIo ? "Mail to the IO" : "Send"}
          </button>
        </div>
      ) : step === "forwarded" ? (
        <div style={{ ...footStyle, justifyContent: "flex-start", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="fwd-at" style={{ fontSize: 14, fontWeight: 500 }}>
              Forwarded at
            </label>
            <input id="fwd-at" className="input" type="datetime-local" value={fwdAt} onChange={(e) => setFwdAt(e.target.value)} style={{ minHeight: 40 }} aria-describedby="fwd-at-hint" />
            <span id="fwd-at-hint" className="mut" style={{ fontSize: 12 }}>
              Leave empty for now.
            </span>
          </div>
          <div style={{ flex: "2 1 240px", display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="fwd-note" style={{ fontSize: 14, fontWeight: 500 }}>
              Note <span className="mut">(optional)</span>
            </label>
            <input id="fwd-note" className="input" value={fwdNote} onChange={(e) => setFwdNote(e.target.value)} placeholder="Sent from io.psmadhapur@tspolice.gov.in" style={{ minHeight: 40 }} />
            <span className="mut" style={{ fontSize: 12 }}>&nbsp;</span>
          </div>
          <button className="btn" type="button" onClick={() => setStep("idle")}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={recordFwd} aria-busy={pending}>
            {pending ? "Recording…" : "Mark as forwarded"}
          </button>
        </div>
      ) : step === "review" ? (
        <div style={{ ...footStyle, justifyContent: "flex-start", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="review-note" style={{ fontSize: 14, fontWeight: 500 }}>
              What did you check?
            </label>
            <input id="review-note" className="input" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="Wording still right after the hold was confirmed" style={{ minHeight: 40 }} />
          </div>
          <button className="btn" type="button" onClick={() => setStep("idle")}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={markReviewed} aria-busy={pending}>
            {pending ? "Saving…" : "Mark as reviewed"}
          </button>
        </div>
      ) : step === "verify" ? (
        <div style={{ ...footStyle, justifyContent: "flex-start", alignItems: "center", gap: 12, background: "var(--c-tint-blue)" }}>
          <div style={{ flex: "1 1 260px", fontSize: 15 }}>
            Verify {r.recipient.address} as {r.recipient.org}’s address for law-enforcement requests? Check it against the nodal officer list above. Every request to this address can then be sent; this is logged.
          </div>
          <button className="btn" type="button" onClick={() => setStep("idle")} autoFocus>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={verify} aria-busy={pending}>
            {pending ? "Verifying…" : "Verify address"}
          </button>
        </div>
      ) : step === "portal" ? (
        <div style={{ ...footStyle, justifyContent: "flex-start", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="portal-ref" style={{ fontSize: 14, fontWeight: 500 }}>
              Reference from {short}’s portal
            </label>
            <input id="portal-ref" className="input" value={portalRef} onChange={(e) => setPortalRef(e.target.value)} placeholder="LE-88213" style={{ minHeight: 40 }} />
          </div>
          <button className="btn primary" type="button" onClick={recordPortal} aria-busy={pending}>
            {pending ? "Recording…" : "Record the portal reference"}
          </button>
        </div>
      ) : isSent ? (
        <div style={footStyle}>
          <Link className="btn" href={`/cases/${caseId}/requests/${r.id}`}>
            View in Requests
          </Link>
          {next ? (
            <button className="btn primary" type="button" onClick={() => onOpen(next)}>
              Next action
            </button>
          ) : null}
        </div>
      ) : a.deferred ? (
        <RestoreFooter a={a} />
      ) : (
        <div style={footStyle}>
          {canWrite && (r.mode === "APPROVE_AND_SEND" || r.mode === "SEND" || r.mode === "ASK_APPROVAL") && !a.taskId.startsWith("reminder:") ? (
            <button className="btn" type="button" onClick={() => setStep("defer")}>
              Defer
            </button>
          ) : null}
          {canWrite && r.mode !== "VIEW" ? (
            <Link className="btn" href={`/cases/${caseId}/requests/${r.id}`} title="Opens the request editor. A version you write needs another officer's approval.">
              Edit wording
            </Link>
          ) : (
            <Link className="btn" href={`/cases/${caseId}/requests/${r.id}`}>
              View in Requests
            </Link>
          )}
          {r.unaddressed ? (
            !r.unaddressed.gap && canWrite ? (
              <button className="btn primary" type="button" onClick={readdress} aria-busy={pending}>
                {pending ? "Addressing…" : "Address it"}
              </button>
            ) : null
          ) : r.demoAddress && canWrite ? (
            <button className="btn primary" type="button" onClick={readdress} aria-busy={pending}>
              {pending ? "Re-addressing…" : "Re-address it"}
            </button>
          ) : r.needsReview && canWrite && r.mode !== "VIEW" ? (
            <button className="btn primary" type="button" onClick={() => setStep("review")}>
              Mark as reviewed
            </button>
          ) : !viaGmail && !r.recipient.verified && r.recipient.canVerify && (r.mode === "APPROVE_AND_SEND" || r.mode === "SEND" || r.mode === "WAITING_APPROVAL") ? (
            <button className="btn primary" type="button" onClick={() => setStep("verify")}>
              Verify address
            </button>
          ) : !viaGmail && !r.recipient.verified && r.status === "DRAFT" && canWrite && r.mode !== "VIEW" ? (
            <button className="btn primary" type="button" onClick={askApproval} aria-busy={pending}>
              {pending ? "Sending for approval…" : "Send for approval"}
            </button>
          ) : !r.recipient.verified && !viaGmail ? null : viaIo && r.mode === "SEND" && canWrite ? (
            <>
              <button className={`btn${handedAt ? "" : " primary"}`} type="button" onClick={() => setStep("confirm")}>
                {r.status === "SUBMISSION_FAILED" ? "Mail to the IO again" : handedAt ? "Mail again" : "Mail to the IO"}
              </button>
              <button className={`btn${handedAt ? " primary" : ""}`} type="button" onClick={() => setStep("forwarded")}>
                Mark as forwarded
              </button>
            </>
          ) : r.mode === "APPROVE_AND_SEND" || r.mode === "SEND" ? (
            <button className="btn primary" type="button" disabled={keep.size === 0} onClick={() => setStep("confirm")}>
              {viaGmail ? (r.status === "SUBMISSION_FAILED" ? "Send from Gmail again" : r.mode === "SEND" ? "Send from Gmail" : "Approve and send from Gmail") : viaIo ? (r.mode === "SEND" ? "Mail to the IO" : "Approve and mail to the IO") : r.status === "SUBMISSION_FAILED" ? "Send again" : r.mode === "SEND" ? "Send" : "Approve and send"}
            </button>
          ) : r.mode === "ASK_APPROVAL" ? (
            <button className="btn primary" type="button" onClick={askApproval} aria-busy={pending}>
              {pending ? "Sending for approval…" : "Send for approval"}
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}

function RestoreFooter({ a }: { a: NextAction }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={footStyle}>
      {error ? (
        <span role="alert" className="mut" style={{ flex: "1 1 200px", fontSize: 13, color: C.orange }}>
          {error}
        </span>
      ) : null}
      <button
        className="btn"
        type="button"
        aria-busy={pending}
        onClick={() =>
          start(async () => {
            const r = await reopenTaskAction(a.taskId, a.taskVersion);
            if (!r.ok) setError(r.error);
            else router.refresh();
          })
        }
      >
        {pending ? "Restoring…" : "Restore"}
      </button>
    </div>
  );
}

function BlockedDialog({ caseId, a, all, canWrite, onOpen }: { caseId: string; a: NextAction; all: NextAction[]; canWrite: boolean; onOpen: (a: NextAction) => void }) {
  const router = useRouter();
  const blocker = a.blockedBy ? all.find((x) => x.rank === a.blockedBy!.rank) : undefined;
  const blockerWaiting = blocker && blocker.kind !== "SENT";
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        setInfo(done);
        router.refresh();
      }
    });
  return (
    <>
      <Head label="Not ready" a={a} title={a.title} sub={blocker ? `There is no draft yet: ${a.why.charAt(0).toLowerCase()}${a.why.slice(1)}` : a.why} />
      <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="chain">
          {a.chain.map((s, i) => (
            <div key={i} className="st">
              <span className={`sn${s.state === "done" ? " done" : s.state === "now" ? " now" : ""}`} aria-label={s.state === "done" ? "Done" : s.state === "now" ? "Current step" : "Later step"}>
                {s.state === "done" ? <Icon name="check" size={14} /> : i + 1}
              </span>
              <div>
                {s.text}
                <div className="d">{s.sub}</div>
              </div>
            </div>
          ))}
        </div>
        {info ? <Banner tone="ok">{info}</Banner> : null}
        {error ? <Banner tone="warn">{error}</Banner> : null}
        {a.gap && !info ? (
          <GapGuide
            gap={a.gap}
            canWrite={canWrite}
            onRecorded={() =>
              run(async () => {
                const r = await prepareAssistantDraftAction(a.taskId);
                return r.ok ? r : { ok: false as const, error: `Recorded. ${r.error}` };
              }, "Recorded, and the request is drafted to that addressee. It is in the list, ready for you to check and send.")
            }
          />
        ) : null}
        {a.note ? (
          <Banner tone="info">
            {a.note}
            {blockerWaiting ? ` Action ${blocker.rank} should go today.` : ""}
          </Banner>
        ) : null}
      </div>
      <div style={footStyle}>
        <Link className="btn" href={`/cases/${caseId}/people`}>
          {a.ruleId === "EVIDENCE_ATM_CCTV" ? "View the sighting" : "Open people & identifiers"}
        </Link>
        {blockerWaiting ? (
          <button className="btn primary" type="button" onClick={() => onOpen(blocker)}>
            Go to action {blocker.rank}
          </button>
        ) : canWrite && a.gap?.canDraftWithout && !info ? (
          <button
            className="btn primary"
            type="button"
            aria-busy={pending}
            title="The draft is written in full with the addressee left blank. It can be edited and printed; it is approved and sent once it is addressed."
            onClick={() => run(async () => prepareDraftWithoutAddresseeAction(a.taskId), "Drafted with the addressee left blank. Check and print it from the list; record the missing detail to address it, then it can be approved and sent.")}
          >
            {pending ? "Drafting…" : "Draft without the addressee"}
          </button>
        ) : null}
      </div>
    </>
  );
}

function SplitDialog({ caseId, a, split, canWrite }: { caseId: string; a: NextAction; split: Split; canWrite: boolean }) {
  const router = useRouter();
  const decided = split.decided;
  const [method, setMethod] = useState<SplitMethod>(decided?.method ?? "PROPORTIONAL");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const invalid = touched && note.trim().length < 10;
  const record = () => {
    setTouched(true);
    if (note.trim().length < 10) return;
    start(async () => {
      const r = await recordSplitAction(caseId, method, note);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };
  return (
    <>
      <Head label="Your decision" a={a} title={`How should the ${split.held} be split?`} sub="SOP 2026 §7.3 prescribes no formula between victims; you record the basis you choose. The assistant does not choose: it shows what each route gives." />
      <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 10 }}>
        {decided ? (
          <Banner tone="ok">
            Recorded {decided.on} with your reasoning: “{decided.note.replace(/[.\s]+$/, "")}”.{" "}
            {decided.split ? `The ledger shows the proposed split (${decided.split}); once the supervisor confirms it, the restoration filing is drafted.` : "No split was proposed: the held money stays held until the court orders its release."}
          </Banner>
        ) : null}
        {error ? <Banner tone="warn">{error}</Banner> : null}
        {split.needed ? (
          <div role="radiogroup" aria-label="How to split the held money" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {split.options.map((o) => (
              <button key={o.method} className={`opt${method === o.method ? " on" : ""}`} type="button" role="radio" aria-checked={method === o.method} disabled={!!decided || !canWrite} onClick={() => setMethod(o.method)}>
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
            ))}
          </div>
        ) : null}
        {!decided && canWrite && split.needed ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            <label htmlFor="split-note" style={{ fontSize: 14, fontWeight: 500 }}>
              Your reason
            </label>
            <textarea id="split-note" className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => setTouched(true)} onFocus={() => setTouched(false)} aria-invalid={invalid} aria-describedby="split-hint" style={{ padding: 10, resize: "vertical" }} />
            <span id="split-hint" className="mut" style={{ fontSize: 13, color: invalid ? C.orange : undefined }}>
              {invalid ? "Write a sentence on why this route fits the case." : "Recorded with the decision and shown in the ledger and the audit log."}
            </span>
          </div>
        ) : null}
        {split.needed ? (
          <p className="mut" style={{ margin: "6px 0 0", fontSize: 13 }}>
            {split.note}
          </p>
        ) : null}
      </div>
      <div style={footStyle}>
        <Link className="btn" href={`/cases/${caseId}/recovery`}>
          Open the ledger
        </Link>
        {!decided && canWrite && split.needed ? (
          <button className="btn primary" type="button" onClick={record} aria-busy={pending}>
            {pending ? "Recording…" : "Record decision"}
          </button>
        ) : null}
      </div>
    </>
  );
}

function TaskDialog({ caseId, a, canWrite, onClose }: { caseId: string; a: NextAction; canWrite: boolean; onClose: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "defer" | "aside" | "done">("idle");
  // The complainant's statement is a step to complete, not a name to rule out.
  const statement = a.ruleId === "FUNDS_VICTIM_STATEMENT";
  const [text, setText] = useState(a.kind === "LEAD" && !statement ? "A matching name alone is not enough" : "");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const label = a.kind === "LEAD" ? (a.route.includes("reopened") ? "Reopened lead" : "Lead") : a.kind === "REQUEST" ? "Proposed request" : a.kind === "DECISION" ? "Your decision" : "Action";
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string, closeAfter = false) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        setInfo(done);
        setStep("idle");
        router.refresh();
        if (closeAfter) onClose();
      }
    });
  return (
    <>
      <Head label={label} a={a} title={a.question || a.title} sub={a.why} />
      <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
        {info ? <Banner tone="ok">{info}</Banner> : null}
        {error ? <Banner tone="warn">{error}</Banner> : null}
        {a.deferred ? <Banner tone="warn">Deferred: {a.deferredNote}.</Banner> : null}
        {a.prerequisites.length ? (
          <div className="chain">
            {a.prerequisites.map((p, i) => (
              <div key={i} className="st">
                <span className={`sn${p.met ? " done" : " now"}`} aria-label={p.met ? "Met" : "Not met yet"}>
                  {p.met ? <Icon name="check" size={14} /> : i + 1}
                </span>
                <div>
                  {p.label}
                  <div className="d">{p.basis}</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {a.kind === "REQUEST" && a.gap && !a.deferred ? (
          <GapGuide
            gap={a.gap}
            canWrite={canWrite}
            onRecorded={() =>
              run(async () => {
                const r = await prepareAssistantDraftAction(a.taskId);
                return r.ok ? r : { ok: false as const, error: `Recorded. ${r.error}` };
              }, "Recorded, and the request is drafted to that addressee. It is in the list, ready for you to check and send.")
            }
          />
        ) : a.kind === "REQUEST" && a.note && !a.deferred ? (
          <Banner tone="warn">{a.note}</Banner>
        ) : null}
        {statement ? (
          <Banner tone="info">Ask the complainant for the statement (or the transaction screenshots) covering every payment, and upload it under Intake & evidence. Its rows are read into the money trail, and the accounts it names get their freeze and statement requests drafted.</Banner>
        ) : a.kind === "LEAD" ? (
          <Banner tone="info">The case assistant can compare the identifiers recorded in this case with those in other cases you can open, and say whether anything overlaps.</Banner>
        ) : null}
        <p className="mut" style={{ margin: 0, fontSize: 13 }}>
          {a.route}
        </p>
      </div>
      {step === "defer" ? (
        <DeferForm a={a} onCancel={() => setStep("idle")} onDone={() => { setStep("idle"); setInfo("Deferred, with your reason."); router.refresh(); }} />
      ) : step === "aside" || step === "done" ? (
        <div style={{ ...footStyle, justifyContent: "flex-start", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="task-text" style={{ fontSize: 14, fontWeight: 500 }}>
              {step === "aside" ? "Why set it aside?" : "What did you find?"}
            </label>
            <input id="task-text" className="input" value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 40 }} />
          </div>
          <button className="btn" type="button" onClick={() => setStep("idle")}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            aria-busy={pending}
            onClick={() => (step === "aside" ? run(() => dismissTaskAction(a.taskId, a.taskVersion, text), "Set aside. It is listed under Leads set aside with your reason.", true) : run(() => completeTaskAction(a.taskId, a.taskVersion, text, null), "Recorded as done, with what you found.", true))}
          >
            {step === "aside" ? "Set aside" : "Record as done"}
          </button>
        </div>
      ) : a.deferred ? (
        <RestoreFooter a={a} />
      ) : (
        <div style={footStyle}>
          {canWrite && statement ? (
            <>
              <button className="btn" type="button" onClick={() => { setText(""); setStep("aside"); }}>
                Set aside
              </button>
              <Link className="btn primary" href={`/cases/${caseId}/intake`}>
                Upload the statement
              </Link>
            </>
          ) : canWrite && a.kind === "LEAD" ? (
            <>
              <button className="btn" type="button" onClick={() => { setText("A matching name alone is not enough"); setStep("aside"); }}>
                Set aside again
              </button>
              <button className="btn" type="button" onClick={() => { setText(""); setStep("done"); }}>
                Record what you found
              </button>
              <Link className="btn primary" href={`/cases/${caseId}/assistant`}>
                Ask the case assistant
              </Link>
            </>
          ) : null}
          {canWrite && a.kind === "REQUEST" ? (
            <>
              <button className="btn" type="button" onClick={() => setStep("defer")}>
                Defer
              </button>
              {a.gap?.canDraftWithout ? (
                <button
                  className="btn primary"
                  type="button"
                  aria-busy={pending}
                  title="The draft is written in full with the addressee left blank. It can be edited and printed; it is approved and sent once it is addressed."
                  onClick={() => run(async () => prepareDraftWithoutAddresseeAction(a.taskId), "Drafted with the addressee left blank. Check and print it from the list; record the missing detail to address it, then it can be approved and sent.")}
                >
                  {pending ? "Drafting…" : "Draft without the addressee"}
                </button>
              ) : a.note ? (
                <Link className="btn primary" href={`/cases/${caseId}/people`}>
                  Open people & identifiers
                </Link>
              ) : (
                <button className="btn primary" type="button" aria-busy={pending} onClick={() => run(async () => prepareAssistantDraftAction(a.taskId), "Drafted by the assistant from the case record. It is now in the list, ready for you to check and send.")}>
                  {pending ? "Drafting…" : "Draft it"}
                </button>
              )}
            </>
          ) : null}
          {a.kind === "DECISION" ? (
            <Link className="btn primary" href={`/cases/${caseId}/recovery`}>
              Open the ledger
            </Link>
          ) : null}
        </div>
      )}
    </>
  );
}
