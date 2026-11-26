"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { copyText, newId } from "@/lib/browser";
import { checkMail, invalidLine, MAIL_FIELD_LABEL, MAX_ATTACH_BYTES, splitAddresses, withItemLine, withoutItemLine, type MailField } from "@/domain/mail-check";
import type { MailView } from "@/server/services/mail-window";
import { commitMailAction, createMailAction, discardMailAction, loadMailAction, loadNewMailAction, saveMailAction, sendMailAction } from "../mail-actions";
import { resyncGmailAction } from "@/features/case/actions";

type Fields = { to: string; subject: string; body: string; attachmentIds: string[]; keepItems: string[] };
type SaveState = { state: "idle" } | { state: "saving" } | { state: "saved"; at: string | null } | { state: "error"; text: string };
/** For the window's owner: save what is typed and make it a version (when the window closes). */
export type MailHandle = { close: () => Promise<void> };

const fmt = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).format(new Date(iso));
const fmtTime = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
/** "10:42" today, "11 Nov, 05:54" on another day. */
const fmtWhen = (iso: string) => (fmt(iso) === fmt(new Date().toISOString()) ? fmtTime(iso) : `${fmt(iso)}, ${fmtTime(iso)}`);
const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const istNowInput = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 16);
const fieldsOf = (v: MailView): Fields => ({ to: v.to, subject: v.subject, body: v.body, attachmentIds: v.attachments.map((a) => a.id), keepItems: v.items });
const footStyle = { position: "sticky", bottom: 0, background: C.card, padding: "16px 28px", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", alignItems: "center", borderTop: `1px solid ${C.line}`, zIndex: 1 } as const;

function CopyButton({ text, what }: { text: string; what: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="mw-icon"
      data-done={done}
      title={done ? "Copied" : `Copy ${what}`}
      aria-label={done ? `${what} copied` : `Copy ${what}`}
      onClick={async () => {
        const ok = await copyText(text);
        setDone(ok);
        if (ok) setTimeout(() => setDone(false), 1600);
      }}
    >
      <Icon name={done ? "check" : "copy"} size={16} />
    </button>
  );
}

/**
 * A request's mail with every part editable where it is shown: To, subject, text, what it asks for and the files.
 * Each change is saved as it is typed (and copied to the Gmail draft). Preview shows the mail as it goes; Send
 * checks every field and outlines the ones to fix in red, naming them at the top, before anything is sent.
 */
export function MailWindow({ requestId, caseId, head, extra, footerStart, hideFooter, handle, onSent, onDiscarded }: { requestId: string | null; caseId?: string; head?: (v: MailView | null) => ReactNode; extra?: ReactNode; footerStart?: ReactNode; hideFooter?: boolean; handle?: RefObject<MailHandle | null>; onSent?: () => void; onDiscarded?: () => void }) {
  const router = useRouter();
  const [view, setView] = useState<MailView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [files, setFiles] = useState<MailView["caseFiles"]>([]);
  const [save, setSave] = useState<SaveState>({ state: "idle" });
  const [conflict, setConflict] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<MailField, string>>>({});
  const [top, setTop] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "info"; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [gmailMsg, setGmailMsg] = useState<string | null>(null);
  // The request being written (empty for a new mail until its first save), its lock counter and its fields' key.
  const idRef = useRef(requestId ?? "");
  const versionRef = useRef(0);
  const keyRef = useRef("");
  const savedKey = useRef("");
  const fieldsRef = useRef<Fields | null>(null);
  const inflight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<HTMLFieldSetElement>(null);
  /** Puts the cursor in the first field to fix. */
  const focusField = (k: MailField) => ({ to: toRef, subject: subjectRef, body: bodyRef, attachments: attachRef, items: itemsRef })[k].current?.focus();

  // Only the latest load counts (an earlier one answering late is ignored), and a load never replaces what was typed
  // since it began.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const typedBefore = fieldsRef.current ? JSON.stringify(fieldsRef.current) : null;
    const res = idRef.current ? await loadMailAction(idRef.current) : caseId ? await loadNewMailAction(caseId) : null;
    if (seq !== loadSeq.current) return;
    if (!res) return setLoadError("Nothing to open.");
    if (!res.ok) return setLoadError(res.error);
    if (typedBefore !== null && fieldsRef.current && JSON.stringify(fieldsRef.current) !== typedBefore) return;
    const f = fieldsOf(res.data);
    setView(res.data);
    setFiles(res.data.caseFiles);
    setFields(f);
    fieldsRef.current = f;
    savedKey.current = JSON.stringify(f);
    versionRef.current = res.data.version;
    keyRef.current = res.data.key;
    setSave(res.data.savedAt ? { state: "saved", at: res.data.savedAt } : { state: "idle" });
    setConflict(false);
  }, [caseId]);

  useEffect(() => {
    // Loading the window's own copy of the mail is a fetch on open: state is set from its answer.
    void load();
  }, [load]);

  const saveNow = useCallback(
    async (overwrite = false): Promise<boolean> => {
      if (inflight.current) await inflight.current;
      const snap = fieldsRef.current;
      if (!snap) return true;
      const key = JSON.stringify(snap);
      if (key === savedKey.current && !overwrite) return true;
      const p = (async () => {
        setSave({ state: "saving" });
        if (!idRef.current) {
          // A new mail's first save makes it a request; its reference is added to the end of the subject.
          const made = await createMailAction(caseId!, { to: snap.to, subject: snap.subject, body: snap.body, attachmentIds: snap.attachmentIds });
          if (!made.ok) {
            setSave({ state: "error", text: made.error });
            return false;
          }
          idRef.current = made.data.requestId;
          versionRef.current = made.data.version;
          keyRef.current = made.data.key;
          const withRef = { ...snap, subject: made.data.subject };
          savedKey.current = JSON.stringify(withRef);
          // The subject takes the reference unless the officer is typing in it right now.
          setFields((f) => (f && f.subject === snap.subject ? { ...f, subject: made.data.subject } : f));
          const fresh = await loadMailAction(made.data.requestId);
          if (fresh.ok) {
            setView(fresh.data);
            versionRef.current = fresh.data.version;
            keyRef.current = fresh.data.key;
          }
          setSave({ state: "saved", at: new Date().toISOString() });
          return true;
        }
        const res = await saveMailAction(idRef.current, { expectedVersion: versionRef.current, baseKey: keyRef.current, to: snap.to, subject: snap.subject, body: snap.body, attachmentIds: snap.attachmentIds, keepItems: snap.keepItems, overwrite });
        if (!res.ok) {
          if (res.code === "CONFLICT") setConflict(true);
          setSave({ state: "error", text: res.error });
          return false;
        }
        versionRef.current = res.data.version;
        keyRef.current = res.data.key;
        savedKey.current = key;
        setConflict(false);
        setSave({ state: "saved", at: res.data.savedAt });
        return true;
      })();
      inflight.current = p;
      try {
        return await p;
      } finally {
        if (inflight.current === p) inflight.current = null;
      }
    },
    [caseId],
  );

  /** Saves what is typed now (used before Send, and by the window's owner before it closes). */
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    for (let i = 0; i < 3; i++) {
      if (!fieldsRef.current || JSON.stringify(fieldsRef.current) === savedKey.current) return true;
      if (!(await saveNow())) return false;
    }
    return JSON.stringify(fieldsRef.current) === savedKey.current;
  }, [saveNow]);

  useImperativeHandle(
    handle,
    () => ({
      close: async () => {
        await flush();
        if (idRef.current) await commitMailAction(idRef.current);
      },
    }),
    [flush],
  );

  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);
  // Saved shortly after typing stops; whatever is unsaved when the window closes is saved then.
  useEffect(() => {
    if (!fields || !view?.editable || conflict) return;
    if (JSON.stringify(fields) === savedKey.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow(), 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fields, view?.editable, conflict, saveNow]);
  // When the window closes, what is unsaved is saved, and the working copy becomes a version.
  useEffect(
    () => () => {
      const id = idRef.current;
      const snap = fieldsRef.current;
      if (!id) return;
      void (async () => {
        if (snap && JSON.stringify(snap) !== savedKey.current) await saveMailAction(id, { expectedVersion: versionRef.current, baseKey: keyRef.current, to: snap.to, subject: snap.subject, body: snap.body, attachmentIds: snap.attachmentIds, keepItems: snap.keepItems });
        await commitMailAction(id);
      })();
    },
    [],
  );

  const sizes = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  if (loadError) return <div style={{ padding: "24px 28px" }} className="banner warn" role="alert"><Icon name="alert" /><div>{loadError}</div></div>;
  if (!view || !fields) {
    return (
      <>
        {head?.(null)}
        <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 12 }} aria-busy="true" aria-label="Loading the mail">
          {[40, 40, 40, 220].map((h, i) => (
            <div key={i} style={{ height: h, borderRadius: 10, background: "var(--c-raise)" }} />
          ))}
        </div>
      </>
    );
  }

  const v = view;
  const edit = v.editable && !preview && !sending;
  const set = (patch: Partial<Fields>, clear: MailField[]) => {
    setFields((f) => (f ? { ...f, ...patch } : f));
    if (clear.some((k) => errors[k])) {
      const next = { ...errors };
      for (const k of clear) delete next[k];
      setErrors(next);
      setTop(invalidLine(next));
    }
  };
  const attachedBytes = fields.attachmentIds.reduce((s, id) => s + (sizes.get(id)?.sizeBytes ?? 0), 0);
  const hasItems = !v.officerMail && v.allItems.length > 0;
  const check = () => checkMail({ to: fields.to, subject: fields.subject, body: fields.body, attachmentBytes: attachedBytes, missingAttachments: fields.attachmentIds.filter((id) => !sizes.has(id)).map(() => "An attached file"), hasItems, itemsKept: fields.keepItems.length });

  const send = async () => {
    setResult(null);
    const errs = check();
    if (Object.keys(errs).length) {
      setErrors(errs);
      setTop(invalidLine(errs));
      setPreview(false);
      const first = (Object.keys(MAIL_FIELD_LABEL) as MailField[]).find((k) => errs[k]);
      setTimeout(() => focusField(first!), 0);
      return;
    }
    setSending(true);
    try {
      if (!(await flush())) {
        setResult({ tone: "warn", text: "The latest changes could not be saved, so nothing was sent. See the note at the bottom, then try again." });
        return;
      }
      const res = await sendMailAction(idRef.current, versionRef.current, keyRef.current, newId());
      if (!res.ok) {
        if (res.fieldErrors && Object.keys(res.fieldErrors).length) {
          const errs2 = res.fieldErrors as Partial<Record<MailField, string>>;
          setErrors(errs2);
          setTop(invalidLine(errs2) ?? res.error);
        } else setResult({ tone: "warn", text: res.error });
        return;
      }
      const o = res.data;
      setResult({ tone: o.outcome === "SENT" ? "ok" : o.outcome === "FAILED" ? "warn" : "info", text: o.text });
      if (o.outcome === "SENT") {
        await load();
        onSent?.();
      } else await load();
      router.refresh();
    } finally {
      setSending(false);
    }
  };

  const toggleItem = (label: string) => {
    const kept = fields.keepItems.includes(label);
    if (kept) {
      const body = withoutItemLine(fields.body, label) ?? fields.body;
      set({ keepItems: fields.keepItems.filter((l) => l !== label), body }, ["items"]);
    } else {
      const keep = v.allItems.map((i) => i.label).filter((l) => l === label || fields.keepItems.includes(l));
      set({ keepItems: keep, body: withItemLine(fields.body, label, fields.keepItems) }, ["items", "body"]);
    }
  };
  const attach = (id: string) => set({ attachmentIds: fields.attachmentIds.includes(id) ? fields.attachmentIds.filter((x) => x !== id) : [...fields.attachmentIds, id] }, ["attachments"]);
  const upload = async (file: File) => {
    setUploading(file.name);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("category", "OTHER");
      form.set("title", file.name);
      form.set("receivedAt", istNowInput());
      form.set("sourceDescription", `Attached to ${v.reference} in the mail window`);
      const res = await fetch(`/api/cases/${v.caseId}/evidence`, { method: "POST", body: form });
      const json = (await res.json().catch(() => null)) as { ok: boolean; data?: { evidenceId: string }; error?: string; fieldErrors?: Record<string, string> } | null;
      if (!json?.ok || !json.data) {
        setErrors({ ...errors, attachments: json?.fieldErrors?.file ?? json?.error ?? "The file could not be added." });
        return;
      }
      setFiles((f) => [...f, { id: json.data!.evidenceId, fileName: file.name, title: file.name, sizeBytes: file.size, category: "OTHER" }]);
      set({ attachmentIds: [...fields.attachmentIds, json.data.evidenceId] }, ["attachments"]);
    } finally {
      setUploading(null);
    }
  };
  const discard = async () => {
    if (idRef.current) {
      const res = await discardMailAction(idRef.current);
      if (!res.ok) return setResult({ tone: "warn", text: res.error });
    }
    onDiscarded?.();
  };
  const resync = async () => {
    setGmailMsg(null);
    if (!(await flush())) return;
    await commitMailAction(idRef.current);
    const res = await resyncGmailAction(idRef.current);
    if (!res.ok) return setGmailMsg(res.error);
    setGmailMsg(res.data.outcome === "pulled" ? "Brought in the edit made in Gmail." : res.data.outcome === "created" ? "Saved in Gmail's Drafts." : "Gmail and T-CYBER match.");
    if (res.data.outcome === "pulled") await load();
  };

  const err = (k: MailField) => (errors[k] ? <div className="mw-err" id={`mw-${k}-err`} role="alert">{errors[k]}</div> : null);
  const allText = `To: ${splitAddresses(fields.to).join(", ")}\nSubject: ${fields.subject}\n\n${fields.body}`;
  const attached = fields.attachmentIds.map((id) => sizes.get(id) ?? { id, fileName: "A file no longer in the case", title: "", sizeBytes: 0, category: "" });
  const g = v.gmail;
  const gmailLine = !g.on || v.sent
    ? null
    : !v.id
      ? "Nothing is kept until you type. Then it is kept as a draft of this case, and in Gmail's Drafts."
    : !g.connected || g.note
      ? `Gmail is not connected, so the draft is not in Gmail yet. ${g.note ?? ""}`
      : g.missing
        ? "This draft is no longer in Gmail's Drafts (sent or deleted there). It is put back when you send."
        : g.error
          ? `Could not update the Gmail draft: ${g.error}`
          : g.inGmail
            ? `In the Drafts of ${g.account}${g.syncedAt ? `, checked ${fmt(g.syncedAt)} ${fmtTime(g.syncedAt)}` : ""}. Edits here or in Gmail are copied to the other.`
            : `Being saved to the Drafts of ${g.account}.`;

  return (
    <>
      {head?.(v)}
      <div className="mw" style={{ padding: "20px 28px" }}>
        {top ? (
          <div className="mw-bad" role="alert">
            <Icon name="alert" size={18} />
            <span>{top}</span>
          </div>
        ) : null}
        {result ? (
          <div className={`banner ${result.tone}`} role={result.tone === "warn" ? "alert" : "status"}>
            <Icon name={result.tone === "ok" ? "check" : result.tone === "warn" ? "alert" : "info"} />
            <div>{result.text}</div>
          </div>
        ) : null}
        {conflict ? (
          <div className="banner warn" role="alert">
            <Icon name="alert" />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span>This mail was changed elsewhere (in Gmail or by another officer) since you opened it, so your last change is not saved yet.</span>
              <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className="btn" type="button" onClick={() => void load()}>
                  Load the latest
                </button>
                <button className="btn" type="button" onClick={() => void saveNow(true)}>
                  Keep mine
                </button>
              </span>
            </div>
          </div>
        ) : null}
        {v.sent && !result ? (
          <div className="banner ok" role="status">
            <Icon name="check" />
            <div>
              Sent {fmt(v.sent.at)}, {fmtTime(v.sent.at)}
              {v.sent.how ? ` · ${v.sent.how}` : ""}.{v.sent.followUpAt ? ` If nothing comes back by ${fmt(v.sent.followUpAt)}, a reminder is drafted.` : ""}
            </div>
          </div>
        ) : null}
        {v.needsReview && v.editable ? (
          <div className="banner warn" role="status">
            <Icon name="alert" />
            <div>Check before sending: {v.needsReview}</div>
          </div>
        ) : null}
        {v.readOnlyNote ? <p className="mut" style={{ margin: 0, fontSize: 13 }}>{v.readOnlyNote}</p> : null}
        {extra}

        <div className="mw-row">
          <span className="mw-k">From</span>
          <div className="mw-ro">
            {v.from.address} <span className="mut">· {v.from.note}</span>
          </div>
          <span />
        </div>

        <div className="mw-row">
          <label htmlFor="mw-to">To</label>
          <div>
            {edit ? (
              <input
                id="mw-to"
                ref={toRef}
                className="mw-in"
                type="text"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                value={fields.to}
                placeholder="nodal.officer@bank.in, another@provider.com"
                aria-invalid={!!errors.to}
                aria-describedby={errors.to ? "mw-to-err" : "mw-to-hint"}
                onChange={(e) => set({ to: e.target.value }, ["to"])}
              />
            ) : (
              <div className="mw-ro">{splitAddresses(fields.to).join(", ") || <span className="mut">No address yet</span>}</div>
            )}
            {err("to")}
            {edit && !errors.to ? (
              <div className="mw-hint" id="mw-to-hint">
                Several addresses: separate them with commas (at most 5).
              </div>
            ) : null}
            {edit && v.suggested.length ? (
              <div className="mw-chips" style={{ marginTop: 6 }}>
                {v.suggested
                  .filter((s) => !splitAddresses(fields.to).some((a) => a.toLowerCase() === s.address.toLowerCase()))
                  .map((s) => (
                    <button key={s.address} type="button" className="mw-sugg" title={s.note} onClick={() => set({ to: [...splitAddresses(fields.to), s.address].join(", ") }, ["to"])}>
                      <Icon name="plus" size={12} /> {s.address}
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
          <CopyButton text={splitAddresses(fields.to).join(", ")} what="the To addresses" />
        </div>

        <div className="mw-row">
          <label htmlFor="mw-subject">Subject</label>
          <div>
            {edit ? (
              <input id="mw-subject" ref={subjectRef} className="mw-in" value={fields.subject} aria-invalid={!!errors.subject} aria-describedby={errors.subject ? "mw-subject-err" : undefined} onChange={(e) => set({ subject: e.target.value }, ["subject"])} />
            ) : (
              <div className="mw-ro">{fields.subject}</div>
            )}
            {err("subject")}
          </div>
          <CopyButton text={fields.subject} what="the subject" />
        </div>

        <div className="mw-row">
          <label htmlFor="mw-body">{preview || !edit ? "Mail" : "Mail text"}</label>
          <div>
            {edit ? (
              <textarea id="mw-body" ref={bodyRef} className="mw-in" value={fields.body} aria-invalid={!!errors.body} aria-describedby={errors.body ? "mw-body-err" : undefined} onChange={(e) => set({ body: e.target.value }, ["body"])} rows={16} />
            ) : (
              <div className="mw-letter">{fields.body}</div>
            )}
            {err("body")}
          </div>
          <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <CopyButton text={fields.body} what="the mail text" />
            <CopyButton text={allText} what="the whole mail (To, subject and text)" />
          </span>
        </div>

        {hasItems ? (
          <fieldset ref={itemsRef} tabIndex={-1} className="mw-row" style={{ border: 0, padding: 0, margin: 0 }} aria-invalid={!!errors.items} aria-describedby={errors.items ? "mw-items-err" : undefined}>
            <legend className="mw-k" style={{ float: "left", padding: "11px 0 0" }}>
              Asks for
            </legend>
            <div className="mw-box" aria-invalid={!!errors.items}>
              {v.allItems.map((i) => {
                const kept = fields.keepItems.includes(i.label);
                return edit ? (
                  <label key={i.id} className="mw-chk">
                    <input type="checkbox" checked={kept} onChange={() => toggleItem(i.label)} />
                    <span>{i.label}</span>
                  </label>
                ) : kept ? (
                  <div key={i.id} style={{ fontSize: 14, padding: "4px 0" }}>
                    · {i.label}
                  </div>
                ) : null;
              })}
              {edit ? <div className="mw-hint">Unticking an item removes its line from the mail; ticking it puts the line back.</div> : null}
              {err("items")}
            </div>
            <span />
          </fieldset>
        ) : null}

        <div className="mw-row">
          <span className="mw-k">Attached</span>
          <div>
            <div className="mw-chips">
              {attached.map((f) => (
                <span key={f.id} className="mw-chip">
                  <Icon name="paperclip" size={14} />
                  <a href={`/api/evidence/${f.id}/file`} target="_blank" rel="noopener" title={f.title}>
                    {f.fileName}
                  </a>
                  <span className="mut">{f.sizeBytes ? size(f.sizeBytes) : ""}</span>
                  {edit ? (
                    <button type="button" aria-label={`Remove ${f.fileName}`} title="Remove" onClick={() => attach(f.id)}>
                      <Icon name="x" size={14} />
                    </button>
                  ) : null}
                </span>
              ))}
              {!attached.length ? <span className="mut" style={{ fontSize: 14, paddingTop: 8 }}>Nothing attached.</span> : null}
            </div>
            {edit ? (
              <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button ref={attachRef} className="btn sm" type="button" aria-expanded={picking} aria-describedby={errors.attachments ? "mw-attachments-err" : undefined} style={errors.attachments ? { borderColor: "var(--c-red)", boxShadow: "0 0 0 1px var(--c-red)" } : undefined} onClick={() => setPicking((p) => !p)}>
                  <Icon name="paperclip" size={14} /> {picking ? "Done attaching" : "Attach a case file"}
                </button>
                <label className="btn sm" style={{ cursor: uploading ? "progress" : "pointer" }}>
                  <Icon name="upload" size={14} /> {uploading ? `Adding ${uploading}…` : "Attach from this computer"}
                  <input
                    type="file"
                    hidden
                    disabled={!!uploading}
                    accept=".pdf,.xlsx,.csv,.docx,.txt,.eml,.png,.jpg,.jpeg"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void upload(f);
                    }}
                  />
                </label>
                <span className="mut" style={{ fontSize: 12 }}>
                  {size(attachedBytes)} of about {size(MAX_ATTACH_BYTES)}. A file from this computer is also kept in the case files.
                </span>
              </div>
            ) : null}
            {edit && picking ? (
              <div className="mw-pick" role="group" aria-label="Case files to attach">
                {files.length ? (
                  files.map((f) => (
                    <label key={f.id}>
                      <input type="checkbox" checked={fields.attachmentIds.includes(f.id)} onChange={() => attach(f.id)} />
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                        {f.title || f.fileName}
                        <span className="mut" style={{ display: "block", fontSize: 12 }}>
                          {f.fileName} · {size(f.sizeBytes)}
                        </span>
                      </span>
                    </label>
                  ))
                ) : (
                  <span className="mut" style={{ fontSize: 14 }}>The case has no files yet. Attach one from this computer.</span>
                )}
              </div>
            ) : null}
            {err("attachments")}
          </div>
          <span />
        </div>

        {v.id ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="lbl" style={{ marginRight: 4 }}>
            Letter for printing
          </span>
          <a className="btn sm" href={`/api/requests/${v.id}/letter?format=pdf`} download onClick={() => void flush()}>
            <Icon name="download" size={14} /> PDF
          </a>
          <a className="btn sm" href={`/api/requests/${v.id}/letter?format=docx`} download onClick={() => void flush()}>
            <Icon name="download" size={14} /> Word
          </a>
        </div>
        ) : null}
        {gmailLine ? (
          <p role="status" style={{ margin: 0, fontSize: 13, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", color: !g.connected || g.note || g.missing || g.error ? "var(--c-orange)" : "var(--c-mut)" }}>
            <span style={{ flex: "1 1 240px" }}>{gmailMsg ?? gmailLine}</span>
            {v.editable && g.connected && !g.note ? (
              <button className="btn sm" type="button" onClick={() => void resync()}>
                Check Gmail now
              </button>
            ) : null}
          </p>
        ) : null}
        {v.editable && v.send.note ? <p className="mut" style={{ margin: 0, fontSize: 13 }}>{v.send.note}</p> : null}
      </div>

      {hideFooter ? null : confirmDiscard ? (
        <div style={{ ...footStyle, justifyContent: "flex-start", background: "var(--c-tint-red)" }}>
          <span style={{ flex: "1 1 240px", fontSize: 14 }}>Discard this mail? It is deleted here and from Gmail&apos;s Drafts; nothing was sent.</span>
          <button className="btn" type="button" onClick={() => setConfirmDiscard(false)} autoFocus>
            Keep it
          </button>
          <button className="btn danger" type="button" onClick={() => void discard()}>
            Discard the mail
          </button>
        </div>
      ) : (
        <div style={footStyle}>
          {v.editable ? (
            <span className="mw-status" data-tone={save.state === "error" ? "bad" : undefined} role="status" aria-live="polite">
              {save.state === "saving" ? (
                "Saving…"
              ) : save.state === "error" ? (
                <>
                  Not saved: {save.text}
                  {!conflict ? (
                    <button className="btn sm" type="button" onClick={() => void saveNow()}>
                      Try again
                    </button>
                  ) : null}
                </>
              ) : save.state === "saved" ? (
                save.at ? `Saved ${fmtWhen(save.at)}` : "Saved"
              ) : !v.id ? (
                "Kept once you start typing"
              ) : null}
            </span>
          ) : (
            <span style={{ marginRight: "auto" }} />
          )}
          {footerStart}
          {v.officerMail && v.editable ? (
            <button className="btn" type="button" onClick={() => setConfirmDiscard(true)}>
              Discard
            </button>
          ) : null}
          {!v.editable && v.id ? (
            <Link className="btn" href={`/cases/${v.caseId}/requests/${v.id}`}>
              View in Requests
            </Link>
          ) : null}
          {v.editable ? (
            <button className="btn" type="button" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
              {preview ? "Edit" : "Preview"}
            </button>
          ) : null}
          {v.editable && v.send.mode !== "NONE" ? (
            <button className="btn primary" type="button" onClick={() => void send()} aria-busy={sending} disabled={sending || v.send.mode === "WAITING"} title={v.send.note}>
              {sending ? "Sending…" : v.send.label}
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}
