"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import { newId } from "@/lib/browser";
import type { CaseFileView } from "@/server/services/case-files";
import type { Proposal } from "@/domain/file-reading";
import { applyCaseFilesAction } from "../actions";
import { inputStyle } from "./import-reply-file";

/**
 * "Add files" in the case window: the officer drops in whatever they found for this FIR (a bank statement, call
 * records, KYC, a letter, a screenshot). Each file is read on this computer against the case; only what relates to
 * this FIR is offered, ticked, with its row or line. Nothing is added until the officer presses "Add to the case".
 */

const ACCEPT = ".pdf,.xlsx,.csv,.docx,.txt,.eml,.png,.jpg,.jpeg";
const MAX_FILES = 10;
const MAX_MB = 25;
const KIND: Record<string, { label: string; tone: string }> = {
  BANK_STATEMENT: { label: "Bank statement", tone: "info" },
  CALL_RECORDS: { label: "Call records", tone: "info" },
  NCRP_TRAIL: { label: "NCRP money trail", tone: "info" },
  DOCUMENT: { label: "Document", tone: "neutral" },
  NOTHING_READABLE: { label: "Not readable", tone: "gap" },
};

type Item = { id: string; file: File; status: "queued" | "reading" | "done" | "failed"; error?: string; view?: CaseFileView };
type Stage = "pick" | "reading" | "review" | "done";
type Outcome = { fileName: string; ok: boolean; text: string; skipped: string[] };

const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export function AddFilesButton({ caseId, caseRef }: { caseId: string; caseRef: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <button className="btn" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)} title="Add a bank statement, call records or any document you found: only what relates to this FIR is added">
        <Icon name="fileUpload" size={16} />
        Add files
      </button>
      <DesignModal
        open={open}
        onClose={() => {
          setOpen(false);
          router.refresh();
        }}
        scope="scr-main"
        maxWidth={920}
        title="Add files to the case"
      >
        {open ? <AddFiles caseId={caseId} caseRef={caseRef} onClose={() => (setOpen(false), router.refresh())} /> : null}
      </DesignModal>
    </>
  );
}

function AddFiles({ caseId, caseRef, onClose }: { caseId: string; caseRef: string; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>("pick");
  const [items, setItems] = useState<Item[]>([]);
  const [source, setSource] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, Set<string>>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const next = [...items];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      if (next.length >= MAX_FILES) {
        problems.push(`Up to ${MAX_FILES} files at a time.`);
        break;
      }
      const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
      if (ext === ".xls") problems.push(`${f.name} is an old-style Excel file: save it as .xlsx first.`);
      else if (!ACCEPT.split(",").includes(ext)) problems.push(`${f.name} is not a type that can be read (PDF, Excel, CSV, Word, text, email, JPG or PNG).`);
      else if (f.size === 0) problems.push(`${f.name} is empty.`);
      else if (f.size > MAX_MB * 1024 * 1024) problems.push(`${f.name} is larger than ${MAX_MB} MB.`);
      else if (!next.some((x) => x.file.name === f.name && x.file.size === f.size)) next.push({ id: newId(), file: f, status: "queued" });
    }
    setItems(next);
    setPickError(problems.length ? problems.join(" ") : null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const readOne = async (it: Item): Promise<Item> => {
    const fd = new FormData();
    fd.set("file", it.file);
    fd.set("source", source);
    try {
      const res = await fetch(`/api/cases/${caseId}/files`, { method: "POST", body: fd });
      const j = (await res.json().catch(() => null)) as { ok: boolean; data?: CaseFileView; error?: string } | null;
      if (j?.ok && j.data) return { ...it, status: "done", view: j.data, error: undefined };
      return { ...it, status: "failed", error: j?.error ?? `The server could not read it (status ${res.status}).` };
    } catch {
      return { ...it, status: "failed", error: "The connection was lost while sending it. Try again." };
    }
  };

  // Files are read one after another, so each shows its own progress and one failure does not stop the rest.
  const readAll = async (list: Item[]) => {
    setStage("reading");
    let cur = list;
    for (const it of list) {
      if (it.status === "done") continue;
      cur = cur.map((x) => (x.id === it.id ? { ...x, status: "reading" } : x));
      setItems(cur);
      const done = await readOne(it);
      cur = cur.map((x) => (x.id === it.id ? done : x));
      setItems(cur);
      if (done.view) {
        const v = done.view;
        setChosen((c) => ({ ...c, [v.readingId]: new Set(v.status === "READ" ? v.result.proposals.map((p) => p.key) : []) }));
      }
    }
    setStage("review");
  };

  const retry = async (it: Item) => {
    const cur = items.map((x) => (x.id === it.id ? { ...x, status: "reading" as const, error: undefined } : x));
    setItems(cur);
    const done = await readOne(it);
    setItems((xs) => xs.map((x) => (x.id === it.id ? done : x)));
    if (done.view) {
      const v = done.view;
      setChosen((c) => ({ ...c, [v.readingId]: new Set(v.status === "READ" ? v.result.proposals.map((p) => p.key) : []) }));
    }
  };

  const toggle = (readingId: string, proposals: Proposal[], p: Proposal) => {
    setChosen((c) => {
      const set = new Set(c[readingId] ?? []);
      if (set.has(p.key)) {
        // Leaving something out leaves out what depends on it.
        const drop = (k: string) => {
          set.delete(k);
          for (const q of proposals) if (q.needs.includes(k) && set.has(q.key)) drop(q.key);
        };
        drop(p.key);
      } else {
        const take = (q: Proposal) => {
          set.add(q.key);
          for (const n of q.needs) {
            const dep = proposals.find((x) => x.key === n);
            if (dep && !set.has(dep.key)) take(dep);
          }
        };
        take(p);
      }
      return { ...c, [readingId]: set };
    });
  };

  const readings = items.filter((i) => i.view).map((i) => i.view!);
  const open = readings.filter((v) => v.status === "READ");
  const total = open.reduce((s, v) => s + (chosen[v.readingId]?.size ?? 0), 0);

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    const list = open.map((v) => ({ readingId: v.readingId, keys: [...(chosen[v.readingId] ?? [])] }));
    const r = await applyCaseFilesAction(list);
    setApplying(false);
    if (!r.ok) return setApplyError(r.error);
    setOutcomes(
      r.data.map((o) => {
        const v = readings.find((x) => x.readingId === o.readingId)!;
        return { fileName: v.fileName, ok: o.ok, text: o.ok ? o.summary!.text : (o.error ?? "Not added."), skipped: o.summary?.skipped ?? [] };
      }),
    );
    setStage("done");
  };

  if (stage === "pick")
    return (
      <>
        <div className="mhead">
          <span className="lbl">Add files · {caseRef}</span>
          <ModalTitle style={{ fontSize: 20 }}>Add What You Found to This FIR</ModalTitle>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            A bank statement, call records (CDR), KYC, a letter, an NCRP export, a screenshot or any document. Each file is read on this computer against the case: only what relates to this FIR is offered, and nothing is added until you choose.
          </p>
        </div>
        <div className="mbody" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden aria-hidden tabIndex={-1} onChange={(e) => add(e.target.files)} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => (e.preventDefault(), setDragging(true))}
            onDragLeave={() => setDragging(false)}
            onDrop={(e: DragEvent) => (e.preventDefault(), setDragging(false), add(e.dataTransfer.files))}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "32px 20px", borderRadius: 12, border: `1.5px dashed ${dragging ? C.blue : C.lineStrong}`, background: dragging ? C.tintBlue : "transparent", color: "inherit", font: "inherit", cursor: "pointer", width: "100%", textAlign: "center" }}
          >
            <span style={{ width: 44, height: 44, borderRadius: 12, background: C.tintBlue, color: C.blue, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="fileUpload" size={22} />
            </span>
            <span style={{ fontSize: 15, fontWeight: 500 }}>Choose files, or drop them here</span>
            <span className="mut" style={{ fontSize: 13 }}>
              PDF, Excel (.xlsx), CSV, Word, text, email, JPG or PNG · up to {MAX_FILES} files of {MAX_MB} MB each
            </span>
          </button>
          {pickError ? (
            <p role="alert" style={{ margin: 0, fontSize: 13, color: C.orange }}>
              {pickError}
            </p>
          ) : null}
          {items.length ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }} aria-label="Files to read">
              {items.map((it) => (
                <li key={it.id} className="inner" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", fontSize: 14 }}>
                  <Icon name="file" size={16} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.file.name}</span>
                  <span className="mut num" style={{ fontSize: 12 }}>
                    {size(it.file.size)}
                  </span>
                  <button className="iconbtn" type="button" aria-label={`Remove ${it.file.name}`} onClick={() => setItems(items.filter((x) => x.id !== it.id))} style={{ width: 28, height: 28 }}>
                    <Icon name="x" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="af-src" style={{ fontSize: 13, fontWeight: 500, color: C.fg2 }}>
              Where they came from <span className="mut" style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <input id="af-src" className="in" style={inputStyle} type="text" maxLength={200} placeholder="For example: statement given by the bank's nodal officer on 18 Nov" value={source} onChange={(e) => setSource(e.target.value)} />
            <span className="mut" style={{ fontSize: 12 }}>
              Kept with each file as its source, for the record.
            </span>
          </div>
        </div>
        <div className="mfoot">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="button" disabled={!items.length} onClick={() => void readAll(items)}>
            {items.length ? `Read ${items.length} ${items.length === 1 ? "file" : "files"}` : "Read the files"}
          </button>
        </div>
      </>
    );

  if (stage === "reading") {
    const n = items.filter((i) => i.status === "done" || i.status === "failed").length;
    return (
      <>
        <div className="mhead">
          <span className="lbl">Add files · {caseRef}</span>
          <ModalTitle style={{ fontSize: 20 }}>
            Reading {n + 1 > items.length ? items.length : n + 1} of {items.length}
          </ModalTitle>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            Each file is kept with the case&apos;s evidence and read against what the case knows. A scanned page or a long document takes longer: the local model on this computer reads it.
          </p>
        </div>
        <div className="mbody">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }} aria-live="polite">
            {items.map((it) => (
              <li key={it.id} className="inner" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", fontSize: 14 }}>
                <Icon name={it.status === "reading" ? "spinner" : it.status === "done" ? "check" : it.status === "failed" ? "alert" : "clock"} size={16} className={it.status === "reading" ? "spin" : undefined} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.file.name}</span>
                  <span className="mut" style={{ display: "block", fontSize: 12, color: it.status === "failed" ? C.orange : undefined }}>
                    {it.status === "queued" ? "Waiting" : it.status === "reading" ? "Reading…" : it.status === "failed" ? it.error : it.view!.result.summary}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="mfoot">
          <span className="mut" style={{ fontSize: 13, marginRight: "auto" }}>
            Closing now keeps the files read so far with the evidence.
          </span>
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </>
    );
  }

  if (stage === "done")
    return (
      <>
        <div className="mhead">
          <span className="lbl">Add files · {caseRef}</span>
          <ModalTitle style={{ fontSize: 20 }}>{outcomes.some((o) => o.ok && !/nothing was added/.test(o.text)) ? "Added to the case" : "Nothing was added"}</ModalTitle>
          <p className="sec" style={{ margin: 0, fontSize: 14 }}>
            The case card, next actions, money trail and graph now include what was added. Every record points back to its row or line in the file.
          </p>
        </div>
        <div className="mbody" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {outcomes.map((o) => (
            <div key={o.fileName} className="inner" style={{ padding: "12px 14px", fontSize: 14, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <Icon name={o.ok ? "check" : "alert"} size={16} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", color: o.ok ? undefined : C.orange }}>{o.text}</span>
                {o.skipped.length ? (
                  <span className="mut" style={{ display: "block", fontSize: 12, marginTop: 4 }}>
                    {o.skipped.slice(0, 4).join(" · ")}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
        <div className="mfoot">
          <button
            className="btn"
            type="button"
            onClick={() => {
              setItems([]);
              setChosen({});
              setOutcomes([]);
              setStage("pick");
            }}
          >
            Add more files
          </button>
          <button className="btn primary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </>
    );

  // Review: what each file adds, ticked; what was left out, and why.
  return (
    <>
      <div className="mhead">
        <span className="lbl">Add files · {caseRef}</span>
        <ModalTitle style={{ fontSize: 20 }}>What These Files Add to the Case</ModalTitle>
        <p className="sec" style={{ margin: 0, fontSize: 14 }}>
          Only what relates to this FIR is listed, with the row or line it comes from. Untick anything you do not want. The files themselves are already kept with the evidence.
        </p>
      </div>
      <div className="mbody" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {applyError ? (
          <div className="banner warn" role="alert">
            <Icon name="alert" />
            <div>{applyError}</div>
          </div>
        ) : null}
        {items.map((it) =>
          it.view ? (
            <FileCard key={it.id} v={it.view} chosen={chosen[it.view.readingId] ?? new Set()} onToggle={(p) => toggle(it.view!.readingId, it.view!.result.proposals, p)} />
          ) : (
            <div key={it.id} className="inner" style={{ padding: "12px 14px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <Icon name="alert" size={16} />
              <span style={{ flex: "1 1 260px", minWidth: 0, fontSize: 14 }}>
                <span style={{ display: "block", fontWeight: 500 }}>{it.file.name}</span>
                <span style={{ display: "block", color: C.orange, fontSize: 13 }}>{it.status === "reading" ? "Reading…" : it.error}</span>
              </span>
              <button className="btn sm" type="button" onClick={() => void retry(it)} disabled={it.status === "reading"} aria-busy={it.status === "reading"}>
                Try again
              </button>
            </div>
          ),
        )}
      </div>
      <div className="mfoot">
        <button className="btn" type="button" onClick={onClose}>
          {open.length ? "Keep the files only" : "Close"}
        </button>
        {open.length ? (
          <button className="btn primary" type="button" onClick={() => void apply()} disabled={applying} aria-busy={applying}>
            {applying ? "Adding…" : total ? `Add ${total} ${total === 1 ? "item" : "items"} to the case` : "Keep the files, add nothing"}
          </button>
        ) : null}
      </div>
    </>
  );
}

function FileCard({ v, chosen, onToggle }: { v: CaseFileView; chosen: Set<string>; onToggle: (p: Proposal) => void }) {
  const r = v.result;
  const k = KIND[r.kind] ?? KIND.DOCUMENT!;
  const locked = v.status !== "READ";
  return (
    <section className="inner" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }} aria-label={v.fileName}>
      <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <Icon name="file" size={18} />
        <span style={{ flex: "1 1 240px", minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 15, fontWeight: 600, overflowWrap: "anywhere" }}>{r.title}</span>
          <span className="mut" style={{ display: "block", fontSize: 12, overflowWrap: "anywhere" }}>
            {[v.fileName, ...r.about].join(" · ")}
          </span>
        </span>
        <span className={`pill ${k.tone}`}>{k.label}</span>
        {r.total ? (
          <span className="mut num" style={{ fontSize: 12 }}>
            {r.relevant} of {r.total} relate
          </span>
        ) : null}
      </div>
      {v.duplicate || locked ? (
        <p style={{ margin: 0, fontSize: 13, color: C.amber }}>
          {v.status === "APPLIED" ? `This file was already added to the case (read on ${when(v.readAt)}). ${v.applied?.text ?? ""}` : v.status === "KEPT" ? `This file was already added on ${when(v.readAt)} and kept without adding anything. Its reading is shown again below.` : `This file was already added on ${when(v.readAt)}; its reading is shown again. It is not stored twice.`}
        </p>
      ) : null}
      <p className="sec" style={{ margin: 0, fontSize: 14 }}>
        {r.summary}
      </p>
      {r.proposals.length && !locked ? (
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <legend className="lbl" style={{ marginBottom: 6 }}>
            To add to the case
          </legend>
          {r.proposals.map((p) => (
            <label key={p.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 4px", fontSize: 14, cursor: "pointer", borderRadius: 6 }}>
              <input type="checkbox" checked={chosen.has(p.key)} onChange={() => onToggle(p)} style={{ marginTop: 3, flex: "none" }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block" }}>{p.text}</span>
                <span className="mut" style={{ display: "block", fontSize: 12, overflowWrap: "anywhere" }} title={p.src.excerpt}>
                  {p.src.locator}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {r.insights.length ? (
        <div>
          <div className="lbl" style={{ marginBottom: 4 }}>
            Also worth knowing (not added as records)
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "flex", flexDirection: "column", gap: 3 }} className="sec">
            {r.insights.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.leftOut ? (
        <p className="mut" style={{ margin: 0, fontSize: 13 }}>
          {r.leftOut}
        </p>
      ) : null}
      {v.model ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13, color: C.blue }}>What the local model read in it</summary>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            {v.model.what ? <p style={{ margin: 0 }}>{v.model.what}</p> : null}
            {v.model.points.map((p, i) => (
              <p key={i} style={{ margin: 0 }}>
                {p.text}
                <span className="mut" style={{ display: "block", fontSize: 12 }}>
                  “{p.quote}”
                </span>
              </p>
            ))}
            <p className="mut" style={{ margin: 0, fontSize: 12 }}>
              Written by the local model ({v.model.model}) on this computer. Every point&apos;s quote was checked against the file{v.model.dropped ? `; ${v.model.dropped} point${v.model.dropped === 1 ? "" : "s"} without a matching quote ${v.model.dropped === 1 ? "was" : "were"} dropped` : ""}. These points are not added as records.
            </p>
          </div>
        </details>
      ) : v.modelNote && r.kind === "DOCUMENT" ? (
        <p className="mut" style={{ margin: 0, fontSize: 12 }}>
          {v.modelNote}
        </p>
      ) : null}
      {r.notes.map((n, i) => (
        <p key={i} style={{ margin: 0, fontSize: 13, color: C.orange }}>
          {n}
        </p>
      ))}
      <p className="mut" style={{ margin: 0, fontSize: 12 }}>
        {v.how}.
      </p>
    </section>
  );
}
