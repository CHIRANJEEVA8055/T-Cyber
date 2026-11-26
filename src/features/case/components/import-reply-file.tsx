"use client";

import { useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import type { ImportedReply } from "@/server/services/import-summary";

/**
 * "Import a reply" from a file, inside the case window: a reply that came another way (a letter, a portal download,
 * a pen drive) is filed against one of this case's sent requests, or matched automatically. The originals are kept
 * with their hashes; nothing in the case changes until the officer accepts what the reply says.
 */

const ACCEPT = ".pdf,.csv,.txt,.eml,.png,.jpg,.jpeg,.docx,.xlsx";
const MAX_FILES = 5;
const MAX_MB = 25;

export const inputStyle: CSSProperties = { width: "100%", boxSizing: "border-box", minHeight: 40, padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, color: C.fg, font: "inherit", fontSize: 14 };

function nowIstInput() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

export function Field({ id, label, hint, error, children, optional }: { id: string; label: string; hint?: string; error?: string; optional?: boolean; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <label htmlFor={id} style={{ fontSize: 13, fontWeight: 500, color: C.fg2 }}>
        {label}
        {optional ? <span className="mut" style={{ fontWeight: 400 }}> (optional)</span> : null}
      </label>
      {children}
      {error ? (
        <span id={`${id}-err`} role="alert" style={{ fontSize: 13, color: C.orange }}>
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className="mut" style={{ fontSize: 12 }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

type Result = { kind: "imported"; summary: ImportedReply } | { kind: "duplicate"; responseId: string };

export function ImportReplyFromFile({ caseId, targets, initialRequestId, onImported, footer }: { caseId: string; targets: { id: string; label: string; from: string }[]; initialRequestId: string | null; onImported: (r: Result) => void; footer: (submit: ReactNode) => ReactNode }) {
  const [requestId, setRequestId] = useState(initialRequestId && targets.some((t) => t.id === initialRequestId) ? initialRequestId : "");
  const [from, setFrom] = useState(() => targets.find((t) => t.id === initialRequestId)?.from ?? "");
  const [receivedAt, setReceivedAt] = useState(nowIstInput);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      if (next.length >= MAX_FILES) {
        problems.push(`Only ${MAX_FILES} files can go with one reply.`);
        break;
      }
      if (f.size === 0) problems.push(`${f.name} is empty.`);
      else if (f.size > MAX_MB * 1024 * 1024) problems.push(`${f.name} is larger than ${MAX_MB} MB.`);
      else if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setFiles(next);
    setErrors((e) => ({ ...e, attachments: problems.join(" ") }));
    if (fileRef.current) fileRef.current.value = "";
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from.trim())) e.fromAddress = "Enter the sender's email address, as it appears on the reply.";
    if (subject.trim().length < 3) e.subject = "Enter the subject or a short title for the reply.";
    if (body.trim().length < 5) e.bodyText = "Paste or type what the reply says (at least a line).";
    if (!receivedAt) e.receivedAt = "Enter when it was received.";
    return e;
  };

  const submit = async () => {
    const e = validate();
    setErrors(e);
    setError(null);
    if (Object.keys(e).length) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("caseId", caseId);
    fd.set("requestId", requestId);
    fd.set("fromAddress", from.trim());
    fd.set("receivedAt", receivedAt);
    fd.set("subject", subject.trim());
    fd.set("bodyText", body);
    for (const f of files) fd.append("attachments", f);
    try {
      const res = await fetch("/api/correspondence/import", { method: "POST", body: fd });
      const j = (await res.json().catch(() => null)) as { ok: boolean; error?: string; fieldErrors?: Record<string, string>; data?: { status: string; responseId: string; summary: ImportedReply } } | null;
      if (!j) return setError("The server did not answer properly. Nothing was imported; try again.");
      if (!j.ok || !j.data) {
        if (j.fieldErrors && Object.keys(j.fieldErrors).length) setErrors(j.fieldErrors);
        return setError(j.fieldErrors && Object.keys(j.fieldErrors).length ? "Some details need attention. Nothing was imported." : (j.error ?? "The reply could not be imported. Nothing was changed."));
      }
      onImported(j.data.status === "DUPLICATE" ? { kind: "duplicate", responseId: j.data.responseId } : { kind: "imported", summary: j.data.summary });
    } catch {
      setError("The connection was lost before the reply was imported. Nothing was changed; try again.");
    } finally {
      setBusy(false);
    }
  };

  const described = (id: string) => (errors[id] ? `${id}-err` : undefined);
  return (
    <>
      <div className="mbody" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {error ? (
          <div className="banner warn" role="alert">
            <Icon name="alert" />
            <div>{error}</div>
          </div>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          <Field id="ir-req" label="In reply to" hint={targets.length ? "Leave on automatic to match it by the reference it quotes and the sender." : "No request has been sent yet, so it will wait for you to match it."}>
            <select
              id="ir-req"
              className="in"
              style={inputStyle}
              value={requestId}
              onChange={(e) => {
                const id = e.target.value;
                setRequestId(id);
                const t = targets.find((x) => x.id === id);
                // The sender is usually the request's recipient: filled in only while the box is empty or untouched.
                if (t?.from && (!from || targets.some((x) => x.from === from))) setFrom(t.from);
              }}
            >
              <option value="">Match automatically</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="ir-at" label="Received on (IST)" error={errors.receivedAt}>
            <input id="ir-at" className="in" style={inputStyle} type="datetime-local" value={receivedAt} max={nowIstInput()} onChange={(e) => setReceivedAt(e.target.value)} aria-invalid={!!errors.receivedAt} aria-describedby={described("receivedAt")} />
          </Field>
        </div>
        <Field id="ir-from" label="From (sender's email)" error={errors.fromAddress} hint="As printed on the letter or email.">
          <input id="ir-from" className="in" style={inputStyle} type="email" autoComplete="off" placeholder="nodal.officer@bank.example.invalid" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={!!errors.fromAddress} aria-describedby={described("fromAddress")} />
        </Field>
        <Field id="ir-subject" label="Subject" error={errors.subject}>
          <input id="ir-subject" className="in" style={inputStyle} type="text" autoComplete="off" placeholder="Reply to your letter dated …" value={subject} onChange={(e) => setSubject(e.target.value)} aria-invalid={!!errors.subject} aria-describedby={described("subject")} />
        </Field>
        <Field id="ir-body" label="What the reply says" error={errors.bodyText} hint="Paste the full text, including any reference number it quotes. It is read as data; nothing in it is followed.">
          <textarea id="ir-body" className="in" style={{ ...inputStyle, minHeight: 120, resize: "vertical", lineHeight: 1.5 }} value={body} onChange={(e) => setBody(e.target.value)} aria-invalid={!!errors.bodyText} aria-describedby={described("bodyText")} />
        </Field>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: C.fg2 }}>
            Files that came with it <span className="mut" style={{ fontWeight: 400 }}>(optional)</span>
          </span>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden aria-hidden tabIndex={-1} onChange={(e) => addFiles(e.target.files)} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => (e.preventDefault(), setDragging(true))}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 10, border: `1.5px dashed ${dragging ? C.blue : C.lineStrong}`, background: dragging ? C.tintBlue : "transparent", color: "inherit", font: "inherit", cursor: "pointer", textAlign: "left", width: "100%" }}
          >
            <Icon name="upload" size={18} />
            <span>
              <span style={{ display: "block", fontSize: 14, fontWeight: 500 }}>Add the statement, letter or export</span>
              <span className="mut" style={{ display: "block", fontSize: 12 }}>
                PDF, Excel, CSV, Word, text, email or a photo · up to {MAX_FILES} files of {MAX_MB} MB · or drop them here
              </span>
            </span>
          </button>
          {errors.attachments ? (
            <span role="alert" style={{ fontSize: 13, color: C.orange }}>
              {errors.attachments}
            </span>
          ) : null}
          {files.length ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {files.map((f) => (
                <li key={`${f.name}:${f.size}`} className="inner" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", fontSize: 14 }}>
                  <Icon name="file" size={16} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                  <span className="mut num" style={{ fontSize: 12 }}>
                    {f.size >= 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`}
                  </span>
                  <button className="iconbtn" type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x !== f))} style={{ width: 28, height: 28 }}>
                    <Icon name="x" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {footer(
        <button className="btn primary" type="button" onClick={() => void submit()} aria-busy={busy} disabled={busy}>
          {busy ? "Reading it in…" : "Read it in"}
        </button>,
      )}
    </>
  );
}
