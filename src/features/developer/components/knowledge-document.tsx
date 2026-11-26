"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal } from "@/components/design/modal";
import type { KnowledgeDocumentView } from "@/server/services/knowledge-admin";
import { deleteDraftAction, newVersionAction, publishAction, restoreAction, retireAction, saveDraftAction } from "../actions";

const CAT: Record<string, string> = { SOP: "SOP", CIRCULAR: "Circular", LAW: "Law", PROVIDER: "Provider or platform guide", OTHER: "Other guide or training" };
const STATUS: Record<string, [string, string]> = { DRAFT: ["Draft", "wait"], CURRENT: ["Current", "ok"], SUPERSEDED: ["Superseded", "neutral"], WITHDRAWN: ["Retired", "gap"] };
const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));
const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

type Section = { id?: string; sectionRef: string; heading: string; text: string };

/** Developer console › one knowledge-base document (pattern: detail / record). */
export function KnowledgeDocument({ doc }: { doc: KnowledgeDocumentView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editMeta, setEditMeta] = useState(false);
  const [meta, setMeta] = useState({ title: doc.title, docNumber: doc.docNumber, issuingBody: doc.issuingBody, jurisdiction: doc.jurisdiction, version: doc.version, effectiveFrom: doc.effectiveFrom.slice(0, 10), category: doc.category as string, summary: doc.summary, reviewNote: doc.reviewNote ?? "" });
  const [metaErrors, setMetaErrors] = useState<Record<string, string>>({});
  const [sections, setSections] = useState<Section[] | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "retire" | null>(null);
  const [reason, setReason] = useState("");
  const draft = doc.status === "DRAFT";
  const run = (fn: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string; fieldErrors?: Record<string, string> }>, after?: (data: unknown) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) {
        setError(r.error);
        if (r.fieldErrors) setMetaErrors(r.fieldErrors);
        return;
      }
      after?.((r as { data?: unknown }).data);
    });
  const [label, tone] = STATUS[doc.status] ?? [doc.status, "neutral"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 420px" }}>
          <Link href="/developer/knowledge" className="more">
            Knowledge base
          </Link>
          <div className="row" style={{ gap: 10, marginTop: 6, flexWrap: "wrap" }}>
            <h1 className="h" style={{ fontSize: 26, margin: 0 }}>{doc.title}</h1>
            <span className={`pill ${tone}`}>{label}</span>
            {doc.isSynthetic ? <span className="pill neutral">Illustrative</span> : null}
          </div>
          <p className="sec" style={{ margin: "6px 0 0" }}>
            {doc.issuingBody} · {doc.docNumber} · version {doc.version} · in force from {day(doc.effectiveFrom)} · {CAT[doc.category] ?? doc.category}
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {doc.hasOriginal ? (
            <a className="btn" href={`/api/developer/knowledge/${doc.id}/original`} download>
              <Icon name="download" size={16} /> Download the original
            </a>
          ) : null}
          {draft ? (
            <>
              <button className="btn" type="button" onClick={() => setConfirm("delete")}>
                Delete draft
              </button>
              <button className="btn primary" type="button" aria-busy={pending} onClick={() => run(() => publishAction(doc.id), () => router.refresh())}>
                Publish: the assistant answers from it
              </button>
            </>
          ) : doc.status === "CURRENT" ? (
            <>
              <button className="btn" type="button" onClick={() => setConfirm("retire")}>
                Retire…
              </button>
              <button className="btn primary" type="button" aria-busy={pending} onClick={() => run(() => newVersionAction(doc.id), (d) => router.push(`/developer/knowledge/${(d as { id: string }).id}`))}>
                Start a new version
              </button>
            </>
          ) : doc.status === "WITHDRAWN" ? (
            <button className="btn primary" type="button" aria-busy={pending} onClick={() => run(() => restoreAction(doc.id), () => router.refresh())}>
              Restore to current
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div role="alert" className="inner" style={{ padding: "12px 14px", display: "flex", gap: 10, color: C.orange }}>
          <Icon name="alertCircle" size={18} /> <span style={{ flex: 1 }}>{error}</span>
          <button className="btn sm" type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {doc.status === "SUPERSEDED" && doc.successor ? (
        <div className="inner" style={{ padding: "12px 14px" }}>
          Superseded by <Link className="more" href={`/developer/knowledge/${doc.successor.id}`}>version {doc.successor.version}</Link>. It stays searchable as history and is labelled whenever it is cited.
        </div>
      ) : null}
      {doc.status === "WITHDRAWN" ? <div className="inner" style={{ padding: "12px 14px" }}>Retired: {doc.retiredReason}. The assistant does not answer from it.</div> : null}
      {doc.replaces ? (
        <div className="inner" style={{ padding: "12px 14px" }}>
          {draft ? "Publishing this supersedes" : "This version replaced"} <Link className="more" href={`/developer/knowledge/${doc.replaces.id}`}>{doc.replaces.title} ({doc.replaces.version})</Link>.
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)", gap: 20 }} className="stack-narrow">
        <section className="card" aria-label="Sections" style={{ overflow: "hidden" }}>
          <div className="row" style={{ justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${C.line}`, gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>
              {doc.sections.length} {doc.sections.length === 1 ? "section" : "sections"}
              <span className="mut" style={{ fontWeight: 400 }}> · as the assistant cites them</span>
            </span>
            {draft && !sections ? (
              <button className="btn sm" type="button" onClick={() => setSections(doc.sections.map((s) => ({ ...s })))}>
                <Icon name="pencil" size={14} /> Edit sections
              </button>
            ) : null}
          </div>
          {sections ? (
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
              {sections.map((s, i) => (
                <div key={i} className="inner" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, width: 110 }}>
                      <span className="lbl">Reference</span>
                      <input className="input" value={s.sectionRef} onChange={(e) => setSections(sections.map((x, k) => (k === i ? { ...x, sectionRef: e.target.value } : x)))} style={{ minHeight: 36 }} />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                      <span className="lbl">Heading</span>
                      <input className="input" value={s.heading} onChange={(e) => setSections(sections.map((x, k) => (k === i ? { ...x, heading: e.target.value } : x)))} style={{ minHeight: 36 }} />
                    </label>
                    <button className="btn sm" type="button" aria-label={`Remove section ${s.sectionRef}`} onClick={() => setSections(sections.filter((_, k) => k !== i))} style={{ alignSelf: "flex-end" }}>
                      Remove
                    </button>
                  </div>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="lbl">Text</span>
                    <textarea className="input" rows={5} value={s.text} onChange={(e) => setSections(sections.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} style={{ padding: 10 }} />
                  </label>
                </div>
              ))}
              <div className="row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
                <button className="btn sm" type="button" onClick={() => setSections([...sections, { sectionRef: `§${sections.length + 1}`, heading: "", text: "" }])}>
                  <Icon name="plus" size={14} /> Add a section
                </button>
                <span className="row" style={{ gap: 8 }}>
                  <button className="btn" type="button" onClick={() => setSections(null)}>
                    Cancel
                  </button>
                  <button className="btn primary" type="button" aria-busy={pending} onClick={() => run(() => saveDraftAction(doc.id, { sections }), () => (setSections(null), router.refresh()))}>
                    Save sections
                  </button>
                </span>
              </div>
            </div>
          ) : (
            <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
              {doc.sections.map((s) => (
                <article key={s.id} style={{ padding: "14px 20px", borderTop: `1px solid ${C.lineSoft}` }}>
                  <div style={{ fontWeight: 500 }}>
                    <span className="cite" style={{ marginRight: 8 }}>{s.sectionRef}</span>
                    {s.heading}
                  </div>
                  {s.text.split(/\n{2,}/).map((p, k) => (
                    <p key={k} className="sec" style={{ margin: "6px 0 0", whiteSpace: "pre-line", fontSize: 14 }}>
                      {p}
                    </p>
                  ))}
                </article>
              ))}
            </div>
          )}
        </section>

        <aside style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <section className="card" aria-label="Details" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600 }}>Details</span>
              {draft && !editMeta ? (
                <button className="btn sm" type="button" onClick={() => setEditMeta(true)}>
                  <Icon name="pencil" size={14} /> Edit
                </button>
              ) : null}
            </div>
            {editMeta ? (
              <>
                {(["title", "docNumber", "issuingBody", "jurisdiction", "version"] as const).map((k) => (
                  <label key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="lbl">{{ title: "Title", docNumber: "Number", issuingBody: "Issued by", jurisdiction: "Applies in", version: "Version" }[k]}</span>
                    <input className="input" value={meta[k]} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} aria-invalid={!!metaErrors[k]} style={{ minHeight: 36 }} />
                    {metaErrors[k] ? <span role="alert" style={{ fontSize: 13, color: C.orange }}>{metaErrors[k]}</span> : null}
                  </label>
                ))}
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="lbl">In force from</span>
                  <input className="input" type="date" value={meta.effectiveFrom} onChange={(e) => setMeta({ ...meta, effectiveFrom: e.target.value })} style={{ minHeight: 36 }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="lbl">Kind</span>
                  <select className="input" value={meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value })} style={{ minHeight: 36 }}>
                    {Object.entries(CAT).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="lbl">What it covers</span>
                  <textarea className="input" rows={3} value={meta.summary} onChange={(e) => setMeta({ ...meta, summary: e.target.value })} aria-invalid={!!metaErrors.summary} style={{ padding: 8 }} />
                  {metaErrors.summary ? <span role="alert" style={{ fontSize: 13, color: C.orange }}>{metaErrors.summary}</span> : null}
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="lbl">Caution shown with it</span>
                  <input className="input" value={meta.reviewNote} onChange={(e) => setMeta({ ...meta, reviewNote: e.target.value })} style={{ minHeight: 36 }} />
                </label>
                <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
                  <button className="btn" type="button" onClick={() => setEditMeta(false)}>
                    Cancel
                  </button>
                  <button className="btn primary" type="button" aria-busy={pending} onClick={() => run(() => saveDraftAction(doc.id, { meta }), () => (setEditMeta(false), setMetaErrors({}), router.refresh()))}>
                    Save details
                  </button>
                </div>
              </>
            ) : (
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: "8px 14px", fontSize: 14 }}>
                <dt className="mut">Covers</dt>
                <dd style={{ margin: 0 }}>{doc.summary}</dd>
                {doc.reviewNote ? (
                  <>
                    <dt className="mut">Caution</dt>
                    <dd style={{ margin: 0 }}>{doc.reviewNote}</dd>
                  </>
                ) : null}
                {doc.fileName ? (
                  <>
                    <dt className="mut">File</dt>
                    <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{doc.fileName}</dd>
                  </>
                ) : null}
                {doc.readNote ? (
                  <>
                    <dt className="mut">Read</dt>
                    <dd style={{ margin: 0 }}>{doc.readNote}</dd>
                  </>
                ) : null}
                {doc.sha256 ? (
                  <>
                    <dt className="mut">SHA-256</dt>
                    <dd style={{ margin: 0, fontFamily: "monospace", fontSize: 12, overflowWrap: "anywhere" }}>{doc.sha256}</dd>
                  </>
                ) : null}
              </dl>
            )}
          </section>
          <section className="card" aria-label="History" style={{ padding: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>History</div>
            {doc.history.length ? (
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                {doc.history.map((h) => (
                  <li key={h.id} style={{ fontSize: 14 }}>
                    <div>{h.summary}</div>
                    <div className="mut" style={{ fontSize: 12 }}>
                      {when(h.at)} · {h.by}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mut" style={{ margin: 0, fontSize: 14 }}>No changes recorded for this document yet.</p>
            )}
          </section>
        </aside>
      </div>

      <DesignModal open={confirm === "delete"} onClose={() => setConfirm(null)} scope="scr-dashboard" maxWidth={520} title={`Delete the draft “${doc.title}”?`}>
        <div className="mhead">
          <h2 className="h" style={{ fontSize: 20, margin: 0 }}>Delete the draft “{doc.title}”?</h2>
        </div>
        <div className="mbody">
          <p className="sec" style={{ margin: 0 }}>The draft and its {doc.sections.length} sections are removed. The upload stays in the audit log. This cannot be undone.</p>
        </div>
        <div className="mfoot">
          <button className="btn" type="button" autoFocus onClick={() => setConfirm(null)}>
            Cancel
          </button>
          <button className="btn" type="button" style={{ background: "#dc2626", color: "#fff", borderColor: "transparent" }} onClick={() => run(() => deleteDraftAction(doc.id), () => router.push("/developer/knowledge"))}>
            Delete draft
          </button>
        </div>
      </DesignModal>
      <DesignModal open={confirm === "retire"} onClose={() => setConfirm(null)} scope="scr-dashboard" maxWidth={560} title={`Retire “${doc.title}”?`}>
        <div className="mhead">
          <h2 className="h" style={{ fontSize: 20, margin: 0 }}>Retire “{doc.title}”?</h2>
        </div>
        <div className="mbody" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p className="sec" style={{ margin: 0 }}>The assistant stops answering from it. It stays in the knowledge base as retired, and you can restore it.</p>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="lbl">Why it is retired *</span>
            <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Withdrawn by the DGP's office on 10 November." style={{ padding: 10 }} />
          </label>
        </div>
        <div className="mfoot">
          <button className="btn" type="button" autoFocus onClick={() => setConfirm(null)}>
            Cancel
          </button>
          <button className="btn" type="button" style={{ background: "#dc2626", color: "#fff", borderColor: "transparent" }} onClick={() => run(() => retireAction(doc.id, reason), () => (setConfirm(null), router.refresh()))}>
            Retire document
          </button>
        </div>
      </DesignModal>
    </div>
  );
}
