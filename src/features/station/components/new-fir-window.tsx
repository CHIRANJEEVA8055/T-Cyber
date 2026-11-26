"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Dialog as D } from "radix-ui";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { formatInr } from "@/domain/money";
import type { FirReading, StepEvent } from "@/server/services/fir-reading";
import { complaintForFirAction } from "../actions";
import { ManualFirForm, type ManualPrefill } from "./manual-fir-form";
import { NcrpTrailPicker } from "./ncrp-trail-picker";
import type { TrailPreview } from "@/server/services/ncrp-trail";
import { formatSections } from "@/domain/legal-sections";

/**
 * The New FIR window (design: Dashboard artboard). Upload: the copy is read on the server and each step is shown
 * as it finishes; then a brief, the details found and the first steps. Opening the case keeps the copy and its hash
 * and takes the officer to check what was read. Manual: the officer types the FIR in. Nothing is sent from here.
 */

type Stage = "empty" | "reading" | "done" | "failed";
export interface Ack {
  ack: string;
  complainant: string | null;
  category: string;
  lossMinor: string;
  heldMinor: string;
  receivedAt: string;
  channelLabel: string;
}

const ORDER: StepEvent["key"][] = ["read", "brief", "classify", "details", "plan"];
const PENDING: Record<StepEvent["key"], { label: string; sub: string }> = {
  read: { label: "Reading the copy", sub: "Page by page; Telugu and Hindi are translated, scans are transcribed" },
  brief: { label: "Writing the brief", sub: "Who, what, when and how much, in a few lines" },
  classify: { label: "Placing it in a vertical", sub: "From the station's MO table: as the FIR states it, or by the local model" },
  details: { label: "Pulling out the details", sub: "Names, numbers, accounts, payments and dates, with page references" },
  plan: { label: "Planning the first steps", sub: "Statements and panchanama, then hold and record requests" },
};
const MB = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function NewFirWindow({ open, onClose, initialAck }: { open: boolean; onClose: () => void; initialAck: Ack | null }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"upload" | "manual">("upload");
  const [stage, setStage] = useState<Stage>("empty");
  const [file, setFile] = useState<File | null>(null);
  const [steps, setSteps] = useState<Record<string, StepEvent>>({});
  const [reading, setReading] = useState<FirReading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState<Ack | null>(initialAck);
  const [ackInput, setAckInput] = useState("");
  const [ackMsg, setAckMsg] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // The copy itself, shown beside what was read from it: a local object URL, never uploaded again.
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [docPage, setDocPage] = useState(1);
  const [docView, setDocView] = useState<"original" | "text">("original");
  const [docText, setDocText] = useState<string | null>(null);
  const docRef = useRef<HTMLElement>(null);
  const urlRef = useRef<string | null>(null);
  const showCopy = (f: File | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = f ? URL.createObjectURL(f) : null;
    setDocUrl(urlRef.current);
    setDocPage(1);
    // A browser that cannot show a PDF inside the page (some phones) starts on the text the rules read.
    setDocView(f && f.type === "application/pdf" && typeof navigator !== "undefined" && navigator.pdfViewerEnabled === false ? "text" : "original");
    setDocText(null);
    if (f && (f.type === "text/plain" || /\.txt$/i.test(f.name))) void f.text().then(setDocText);
  };
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  const showPage = (n: number) => {
    setDocPage(n);
    if (docView === "text") requestAnimationFrame(() => document.getElementById(`nf-pg-${n}`)?.scrollIntoView({ block: "start" }));
    // On a narrow screen the copy sits above the details: bring it into view.
    if (window.matchMedia("(max-width: 1023.98px)").matches) docRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  // The NCRP money-trail export, added to the case when it opens (either tab).
  const [trailFile, setTrailFile] = useState<File | null>(null);
  const [trailPreview, setTrailPreview] = useState<TrailPreview | null>(null);
  const [opened, setOpened] = useState<{ caseId: string; href: string; error: string } | null>(null);
  /** After the case opens: add the NCRP export, then go to the case (or say plainly what failed). */
  const finishOpen = async (caseId: string, href: string) => {
    if (trailFile) {
      const body = new FormData();
      body.set("file", trailFile);
      const res = await fetch(`/api/cases/${caseId}/ncrp-trail`, { method: "POST", body }).catch(() => null);
      const j = (await res?.json().catch(() => null)) as { ok: boolean; error?: string } | null;
      if (!j?.ok) {
        setOpened({ caseId, href, error: j?.error ?? "The connection was lost." });
        return;
      }
    }
    onClose();
    router.push(href);
  };
  // Manual tab: what a register complaint already gives, to start from.
  const [prefill, setPrefill] = useState<ManualPrefill | null>(null);

  const loadAck = async (value: string, switchToManual: boolean) => {
    setAckMsg(null);
    const r = await complaintForFirAction(value);
    if (!r.ok) return setAckMsg(r.error);
    if (!r.data) return setAckMsg(`No complaint ${value} is in the station's register. Check the number, or enter the FIR by hand.`);
    if (!r.data.details) return setAckMsg(`Complaint ${value} is already registered as an FIR.`);
    const d = r.data.details;
    setAck({ ack: r.data.ack, complainant: d.complainant, category: d.category, lossMinor: d.lossMinor, heldMinor: d.heldMinor, receivedAt: d.receivedAt, channelLabel: d.channel === "HELPLINE_1930" ? "1930 complaint" : "NCRP acknowledgement" });
    if (switchToManual) {
      setTab("manual");
      setPrefill({ ack: r.data.ack, complainant: d.complainant, lossRupees: BigInt(d.lossMinor) > 0n ? Number(BigInt(d.lossMinor) / 100n).toLocaleString("en-IN") : null });
    }
  };

  const reset = () => {
    setStage("empty");
    setFile(null);
    showCopy(null);
    setSteps({});
    setReading(null);
    setError(null);
    setExistingId(null);
  };

  const read = async (f: File) => {
    reset();
    setFile(f);
    showCopy(f);
    setStage("reading");
    const body = new FormData();
    body.set("file", f);
    try {
      const res = await fetch("/api/fir/read", { method: "POST", body });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(j?.error ?? "The copy could not be read. Try again, or enter the FIR by hand.");
        setStage("failed");
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as ({ type: "step" } & StepEvent) | { type: "result"; data: FirReading } | { type: "error"; error: string };
          if (msg.type === "step") setSteps((s) => ({ ...s, [msg.key]: msg }));
          else if (msg.type === "result") {
            setReading(msg.data);
            if (msg.data.readable) setStage("done");
            else {
              setError(msg.data.note);
              setStage("failed");
            }
          } else {
            setError(msg.error);
            setStage("failed");
          }
        }
      }
    } catch {
      setError("The connection was lost while reading. Nothing was stored. Try again.");
      setStage("failed");
    }
  };

  const pick = (list: FileList | null) => {
    const f = list?.[0];
    if (f) void read(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files);
  };
  const trySample = async () => {
    const res = await fetch("/api/fir/sample");
    if (!res.ok) return setError("The sample copy could not be loaded.");
    const blob = await res.blob();
    void read(new File([blob], "FIR_421_2026_sample.pdf", { type: "application/pdf" }));
  };

  const openFromCopy = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.set("file", file);
    if (ack) body.set("ack", ack.ack);
    const res = await fetch("/api/fir/open", { method: "POST", body });
    const j = (await res.json().catch(() => null)) as { ok: boolean; data?: { caseId: string }; error?: string; existingCaseId?: string | null } | null;
    setBusy(false);
    if (j?.ok && j.data) {
      await finishOpen(j.data.caseId, `/cases/${j.data.caseId}/intake`);
      return;
    }
    setError(j?.error ?? "The case could not be opened. Nothing was created. Try again.");
    setExistingId(j?.existingCaseId ?? null);
  };

  const note =
    stage === "done"
        ? "The copy and its hash are kept when the case opens. Nothing is drafted or sent until you approve it."
        : stage === "reading"
          ? "Reading. Nothing is stored yet."
          : "Nothing is stored until you open the case.";

  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <div className="scr-dashboard">
          <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(5,5,7,0.74)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", boxSizing: "border-box", overflowY: "auto" }}>
            <D.Content className="card" aria-describedby={undefined} style={{ width: "100%", maxWidth: tab === "upload" && stage === "done" ? 1440 : 960, background: C.card, display: "flex", flexDirection: "column", boxShadow: "inset 0 1px 0 0 rgba(255,255,255,0.06), 0 24px 64px -12px rgba(0,0,0,0.7)" }} onDragOver={(e) => e.preventDefault()}>
              <div style={{ padding: "22px 28px 18px", display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 16, borderBottom: `1px solid ${C.line}` }}>
                <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                  <D.Title id="firTitle" className="h" style={{ fontSize: 22 }}>
                    New FIR
                  </D.Title>
                  <p className="sec" style={{ margin: "6px 0 0", fontSize: 14 }}>
                    Upload the FIR and it is read, briefed, its details pulled out and the first steps laid out. Or type it in yourself.
                  </p>
                  {ack && (
                    <div className="ackbar" style={{ margin: "12px 0 0" }}>
                      <Icon name="file" />
                      <span>
                        Starting from {ack.channelLabel} {ack.ack}: {ack.complainant ?? "complainant withheld"} · {ack.category} · {formatInr(BigInt(ack.lossMinor))} lost
                        {BigInt(ack.heldMinor) > 0n ? ` · ${formatInr(BigInt(ack.heldMinor))} held by 1930` : ""}. The FIR will be linked to it.
                      </span>
                    </div>
                  )}
                </div>
                <D.Close className="btn icon" aria-label="Close">
                  <Icon name="x" />
                </D.Close>
                <div className="row" role="tablist" aria-label="How to add the FIR" style={{ flex: "1 1 100%", gap: 4, padding: 4, borderRadius: 12, background: C.panel, border: `1px solid ${C.line}`, width: "fit-content", maxWidth: "100%" }}>
                  <button className={`seg${tab === "upload" ? " on" : ""}`} type="button" role="tab" aria-selected={tab === "upload"} onClick={() => setTab("upload")}>
                    <Icon name="upload" />
                    Upload
                  </button>
                  <button className={`seg${tab === "manual" ? " on" : ""}`} type="button" role="tab" aria-selected={tab === "manual"} onClick={() => setTab("manual")}>
                    <Icon name="pen" />
                    Manual
                  </button>
                </div>
              </div>

              {tab === "upload" && (
                <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20 }}>
                  <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.txt,application/pdf,image/jpeg,image/png,text/plain" hidden aria-hidden tabIndex={-1} onChange={(e) => pick(e.target.files)} />
                  {(stage === "empty" || stage === "failed") && (
                    <>
                      {stage === "failed" && error && (
                        <div className="ackbar" role="alert" style={{ margin: 0, borderColor: "rgba(248,113,113,0.35)" }}>
                          <Icon name="alertCircle" />
                          <span>
                            {file ? `${file.name}: ` : ""}
                            {error}{" "}
                            <button className="tab" type="button" style={{ minHeight: 28, padding: "0 8px", color: C.blue }} onClick={() => setTab("manual")}>
                              Enter it by hand
                            </button>
                          </span>
                        </div>
                      )}
                      <button type="button" className="drop" onClick={() => fileRef.current?.click()} onDragOver={(e) => (e.preventDefault(), setDragging(true))} onDragLeave={() => setDragging(false)} onDrop={onDrop} style={dragging ? { borderColor: C.blue } : undefined}>
                        <span style={{ width: 56, height: 56, borderRadius: 16, background: C.tintBlue, color: C.blue, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                          <Icon name="fileUpload" size={26} strokeWidth={1.75} />
                        </span>
                        <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>Drop the FIR here</span>
                        <span className="sec" style={{ fontSize: 15 }}>
                          or <span style={{ color: C.blue, textDecoration: "underline", textDecorationColor: "rgba(147,197,253,0.4)" }}>browse your computer</span>
                        </span>
                        <span className="mut" style={{ fontSize: 13, maxWidth: 520 }}>
                          PDF, scanned images (JPG or PNG) or text, up to 25 MB. English is read by rules; Telugu, Hindi and scans are read by the local model on this server. The original file and its hash are kept as evidence.
                        </span>
                      </button>
                      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                        <button className="btn sm" type="button" onClick={trySample}>
                          Try it with a sample FIR (421/2026, synthetic)
                        </button>
                        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                          <label className="mut" htmlFor="ncrp" style={{ fontSize: 13 }}>
                            No FIR copy yet?
                          </label>
                          <input id="ncrp" className="in" type="text" inputMode="numeric" placeholder="NCRP acknowledgement no." value={ackInput} onChange={(e) => setAckInput(e.target.value)} style={{ width: 220, minHeight: 36 }} />
                          <button className="btn sm" type="button" onClick={() => (ackInput.trim() ? loadAck(ackInput, true) : setAckMsg("Enter the acknowledgement number first."))}>
                            Start from NCRP
                          </button>
                        </div>
                      </div>
                      {ackMsg && (
                        <p className="sec" role="status" style={{ margin: 0, fontSize: 13 }}>
                          {ackMsg}
                        </p>
                      )}
                    </>
                  )}

                  {stage === "reading" && file && (
                    <>
                      <div className="inner" style={{ padding: "16px 18px", display: "flex", alignItems: "center", gap: 14 }}>
                        <span style={{ width: 44, height: 44, borderRadius: 12, background: C.tintViolet, color: C.violet, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                          <Icon name="spinner" size={22} className="spin" />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 16, fontWeight: 600 }}>{file.name}</div>
                          <div className="sec" style={{ fontSize: 13 }}>
                            {MB(file.size)} · being read
                          </div>
                        </div>
                        <span className="pill ai">Reading</span>
                      </div>
                      <ol className="list" aria-live="polite">
                        {ORDER.map((k, i) => {
                          const s = steps[k];
                          const done = s?.status === "done";
                          const now = s?.status === "start";
                          return (
                            <li key={k}>
                              {done ? (
                                <span className="n done">
                                  <Icon name="check" size={14} strokeWidth={3} />
                                </span>
                              ) : now ? (
                                <span className="n now">
                                  <Icon name="spinner" size={14} strokeWidth={3} className="spin" />
                                </span>
                              ) : (
                                <span className="n">{i + 1}</span>
                              )}
                              <span className="t">
                                {s?.label ?? PENDING[k].label}
                                <span className="s">{s?.sub ?? PENDING[k].sub}</span>
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                    </>
                  )}

                  {stage === "done" && reading && reading.brief && reading.found && (
                    <>
                      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                        <div className="row" style={{ gap: 14 }}>
                          <span style={{ width: 44, height: 44, borderRadius: 12, background: C.tintTeal, color: C.teal, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                            <Icon name="file" size={22} strokeWidth={1.75} />
                          </span>
                          <div>
                            <div style={{ fontSize: 16, fontWeight: 600 }}>{reading.fileName}</div>
                            <div className="sec" style={{ fontSize: 13 }}>
                              {reading.pages ? `${reading.pages} ${reading.pages === 1 ? "page" : "pages"} · ` : ""}
                              {MB(reading.sizeBytes)} · {reading.how === "TRANSLATED" ? `${reading.language}, translated by the local model` : reading.how === "TRANSCRIBED" ? "scanned, transcribed by the local model" : `${reading.language}, read from its text`} · read in {Math.max(1, Math.round(reading.ms / 1000))} {Math.round(reading.ms / 1000) <= 1 ? "second" : "seconds"}
                            </div>
                          </div>
                        </div>
                        <button className="btn sm" type="button" onClick={() => (reset(), fileRef.current?.click())}>
                          Replace
                        </button>
                      </div>
                      {reading.modelUsed && (
                        <div className="ackbar" style={{ margin: 0 }}>
                          <Icon name="info" />
                          <span>
                            The local model ({reading.modelUsed}) {reading.how === "TRANSLATED" ? "translated" : "transcribed"} this copy. Its reading is kept beside the original; check each detail against the original on the next screen.
                          </span>
                        </div>
                      )}
                      <div className="nfsplit">
                        <section ref={docRef} className="inner nfdoc" aria-label={`The FIR copy, ${reading.fileName}`}>
                          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                            <h3 className="h" style={{ fontSize: 16 }}>
                              The FIR Copy
                            </h3>
                            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                              {(file?.type === "application/pdf" || file?.type.startsWith("image/")) && reading.pageTexts.length > 0 && (
                                <div className="row" role="group" aria-label="Which view of the copy to show" style={{ gap: 4 }}>
                                  <button className={`tab${docView === "original" ? " on" : ""}`} type="button" aria-pressed={docView === "original"} onClick={() => setDocView("original")}>
                                    Original
                                  </button>
                                  <button className={`tab${docView === "text" ? " on" : ""}`} type="button" aria-pressed={docView === "text"} onClick={() => (setDocView("text"), requestAnimationFrame(() => document.getElementById(`nf-pg-${docPage}`)?.scrollIntoView({ block: "start" })))}>
                                    {reading.how === "TRANSLATED" ? "English translation" : reading.how === "TRANSCRIBED" ? "Transcription" : "Text as read"}
                                  </button>
                                </div>
                              )}
                              {docView === "original" && file?.type === "application/pdf" && (reading.pages ?? 1) > 1 && (
                                <div className="row" style={{ gap: 4 }}>
                                  <button className="btn sm icon" type="button" aria-label="Previous page" disabled={docPage <= 1} onClick={() => setDocPage((n) => Math.max(1, n - 1))}>
                                    <Icon name="chevronLeft" />
                                  </button>
                                  <span className="mut num" aria-live="polite" style={{ fontSize: 13, minWidth: 92, textAlign: "center" }}>
                                    Page {docPage} of {reading.pages}
                                  </span>
                                  <button className="btn sm icon" type="button" aria-label="Next page" disabled={docPage >= (reading.pages ?? 1)} onClick={() => setDocPage((n) => Math.min(reading.pages ?? 1, n + 1))}>
                                    <Icon name="chevronRight" />
                                  </button>
                                </div>
                              )}
                              {docUrl && (
                                <a className="btn sm" href={docUrl} target="_blank" rel="noopener">
                                  Open in a new tab
                                </a>
                              )}
                            </div>
                          </div>
                          {docView === "text" || (!file?.type.startsWith("image/") && file?.type !== "application/pdf" && !docText) ? (
                            <div className="nfscroll nftext" tabIndex={0} role="document" aria-label={reading.how === "TRANSLATED" ? "English translation by the local model" : reading.how === "TRANSCRIBED" ? "Transcription by the local model" : "The text read from the copy"}>
                              {reading.how !== "TEXT" && <p style={{ margin: "0 0 10px", fontFamily: "inherit" }}>Made by the local model ({reading.modelUsed}). Check it against the original.</p>}
                              {reading.pageTexts.map((p) => (
                                <div key={p.page} id={`nf-pg-${p.page}`} style={{ scrollMarginTop: 8 }}>
                                  <div className="mut" style={{ margin: p.page === reading.pageTexts[0]!.page ? "0 0 6px" : "16px 0 6px", fontWeight: 600 }}>
                                    Page {p.page}
                                  </div>
                                  {p.text}
                                </div>
                              ))}
                            </div>
                          ) : !docUrl ? null : file?.type === "application/pdf" ? (
                            <iframe key={`${docUrl}#${docPage}`} className="nfscroll nfframe" src={`${docUrl}#page=${docPage}&view=FitH`} title={`${reading.fileName}, page ${docPage}`} />
                          ) : file?.type.startsWith("image/") ? (
                            <div className="nfscroll" tabIndex={0} aria-label="The scanned copy">
                              {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not a remote image */}
                              <img src={docUrl} alt={`The FIR copy, ${reading.fileName}`} style={{ width: "100%", height: "auto", display: "block" }} />
                            </div>
                          ) : (
                            <pre className="nfscroll nftext" tabIndex={0} aria-label="The copy's text">
                              {docText ?? ""}
                            </pre>
                          )}
                          <span className="hint">
                            {file?.type === "application/pdf" && typeof navigator !== "undefined" && navigator.pdfViewerEnabled === false ? "This browser does not show a PDF inside the page, so the text read from it is shown; open the original in a new tab to see it. " : ""}
                            Compare each detail with the copy. Select a page reference beside a detail to show that page here.
                          </span>
                        </section>
                        <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
                          <div className="inner" style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
                            <div className="row" style={{ justifyContent: "space-between" }}>
                              <h3 className="h" style={{ fontSize: 16 }}>
                                Brief
                              </h3>
                              <span className="pill ai">From the FIR, by rules</span>
                            </div>
                            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: C.fg2 }}>
                              {reading.brief.headline}{" "}
                              {reading.brief.sentences.map((s, i) => (
                                <span key={i} title={`From ${s.source}`}>
                                  {s.text}{" "}
                                </span>
                              ))}
                            </p>
                            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: C.fg2 }}>
                              <span className="mut">Investigation vertical: </span>
                              <strong style={{ fontWeight: 600 }}>{reading.brief.vertical.label}</strong>
                              <span className="mut"> · {reading.brief.vertical.why}</span>
                            </p>
                            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                              {reading.brief.tags.map((t) => (
                                <span className="pill neutral" key={t}>
                                  {t}
                                </span>
                              ))}
                              <span className="pill info">{reading.brief.sections.stated ? `Sections in the FIR: ${formatSections(reading.brief.sections.text)}` : "Sections: not stated in the FIR"}</span>
                            </div>
                            <span className="hint">Hover a sentence for the page it comes from. Each one links to its page once the case opens.</span>
                          </div>
                          <div className="inner" style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6 }}>
                            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                              <h3 className="h" style={{ fontSize: 16 }}>
                                Details Found
                              </h3>
                              <span className="mut" style={{ fontSize: 13 }}>
                                {reading.found.total} found · {reading.found.read} clean · <span style={{ color: C.orange }}>{reading.found.check} to check</span>
                              </span>
                            </div>
                            <div>
                              {reading.found.items.map((d, i) => (
                                <div className="kv" key={i}>
                                  <span>
                                    {d.title}
                                    <span className="k" style={{ display: "block" }}>
                                      {d.sub}
                                    </span>
                                  </span>
                                  <span className="row" style={{ gap: 6, flex: "none" }}>
                                    {(() => {
                                      const pg = /\bpp?\. (\d+)/.exec(d.sub);
                                      return pg && reading.pageTexts.length > 0 ? (
                                        <button className="tab" type="button" aria-label={`Show page ${pg[1]} of the copy`} onClick={() => showPage(Number(pg[1]))} style={{ minHeight: 32, padding: "0 8px", fontSize: 13, color: C.blue }}>
                                          p. {pg[1]}
                                        </button>
                                      ) : null;
                                    })()}
                                    <span className={`pill ${d.status === "READ" ? "ok" : "gap"}`}>{d.status === "READ" ? "Read" : "Check"}</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="inner" style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                          <div className="row" style={{ justifyContent: "space-between" }}>
                            <h3 className="h" style={{ fontSize: 16 }}>
                              What to Do Next
                            </h3>
                            <span className="pill ai">Guided</span>
                          </div>
                          <ol className="list">
                            {reading.steps.map((s, i) => (
                              <li key={i}>
                                <span className={`n${s.request ? (i === 2 ? " now" : "") : " first"}`}>{i + 1}</span>
                                <span className="t">
                                  {s.title}
                                  <span className="s">{s.sub}</span>
                                </span>
                                {s.request && <span className="pill neutral">Drafted on opening</span>}
                              </li>
                            ))}
                          </ol>
                          <span className="hint">Requests are drafted once you confirm the details. Nothing is sent until you approve each one.</span>
                        </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {tab === "manual" && (
                <ManualFirForm
                  key={prefill?.ack ?? "blank"}
                  prefill={prefill ?? (ack ? { ack: ack.ack, complainant: ack.complainant, lossRupees: BigInt(ack.lossMinor) > 0n ? Number(BigInt(ack.lossMinor) / 100n).toLocaleString("en-IN") : null } : null)}
                  onOpened={(caseId) => void finishOpen(caseId, `/cases/${caseId}`)}
                />
              )}

              {stage !== "reading" && (
                <div style={{ padding: tab === "manual" ? "0 28px 20px" : "0 28px 16px" }}>
                  {opened ? (
                    <div className="ackbar" role="alert" style={{ margin: "0 0 12px", borderColor: "rgba(248,113,113,0.35)" }}>
                      <Icon name="alertCircle" />
                      <span>
                        The case is open, but the NCRP export was not added: {opened.error}{" "}
                        <a href={opened.href} style={{ color: C.blue }}>
                          Go to the case
                        </a>
                      </span>
                    </div>
                  ) : null}
                  <NcrpTrailPicker
                    file={trailFile}
                    preview={trailPreview}
                    onChange={(f, p) => {
                      setTrailFile(f);
                      setTrailPreview(p);
                    }}
                  />
                </div>
              )}

              {tab === "upload" && error && stage !== "failed" && (
                <div className="ackbar" role="alert" style={{ margin: "0 28px 16px", borderColor: "rgba(248,113,113,0.35)" }}>
                  <Icon name="alertCircle" />
                  <span>
                    {error}
                    {existingId && (
                      <>
                        {" "}
                        <a href={`/cases/${existingId}`} style={{ color: C.blue }}>
                          Open that case
                        </a>
                      </>
                    )}
                  </span>
                </div>
              )}

              {tab === "upload" && (
              <div style={{ padding: "16px 28px", borderTop: `1px solid ${C.line}`, display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                <span className="mut" style={{ marginRight: "auto", fontSize: 13 }}>
                  {note}
                </span>
                <D.Close className="btn" type="button">
                  Cancel
                </D.Close>
                {tab === "upload" && (
                  <button className="btn primary" type="button" onClick={stage === "done" ? openFromCopy : stage === "reading" ? undefined : () => fileRef.current?.click()} aria-busy={busy || stage === "reading"}>
                    {busy ? "Opening the case…" : stage === "done" ? "Check details and open the case" : stage === "reading" ? "Reading the copy…" : "Choose the FIR copy"}
                  </button>
                )}
              </div>
              )}
            </D.Content>
          </div>
        </div>
      </D.Portal>
    </D.Root>
  );
}
