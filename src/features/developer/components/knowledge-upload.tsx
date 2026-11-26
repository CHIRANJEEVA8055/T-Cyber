"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";

type Field = "file" | "title" | "docNumber" | "issuingBody" | "jurisdiction" | "version" | "effectiveFrom" | "category" | "summary" | "reviewNote";
const LABEL: Record<Field, string> = { file: "Document", title: "Title", docNumber: "Number", issuingBody: "Issued by", jurisdiction: "Applies in", version: "Version", effectiveFrom: "In force from", category: "Kind", summary: "What it covers", reviewNote: "Caution shown with it (optional)" };
const required: Field[] = ["file", "title", "docNumber", "issuingBody", "jurisdiction", "version", "effectiveFrom", "category", "summary"];
const message = (f: Field, v: string): string | null => {
  if (f === "reviewNote") return null;
  if (!v.trim()) return f === "file" ? "Choose the document to upload." : `Enter ${LABEL[f].toLowerCase()}.`;
  if (f === "effectiveFrom" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return "Enter the date it takes effect.";
  if (f === "summary" && v.trim().length < 10) return "Say in a sentence what it covers.";
  return null;
};

/** Developer console › Upload a document (pattern: form). The file is read and split into sections, then kept as a draft. */
export function KnowledgeUpload({ current }: { current: { id: string; title: string; version: string }[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<Record<Field, string>>({ file: "", title: "", docNumber: "", issuingBody: "", jurisdiction: "Telangana", version: "", effectiveFrom: "", category: "SOP", summary: "", reviewNote: "" });
  const [touched, setTouched] = useState<Partial<Record<Field, "blur" | "submit">>>({});
  const [serverErrors, setServerErrors] = useState<Partial<Record<Field, string>>>({});
  const [replacesId, setReplacesId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const err = (f: Field) => serverErrors[f] ?? (touched[f] ? message(f, values[f]) : null);
  const set = (f: Field, v: string) => {
    setValues((x) => ({ ...x, [f]: v }));
    setServerErrors((x) => ({ ...x, [f]: undefined }));
    if (touched[f] === "blur") setTouched((t) => ({ ...t, [f]: undefined }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const missing = required.filter((f) => message(f, values[f]));
    if (missing.length) {
      setTouched(Object.fromEntries(missing.map((f) => [f, "submit"])));
      document.getElementById(`kb-${missing[0]}`)?.focus();
      return;
    }
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.set("file", file);
    for (const f of required.concat("reviewNote")) if (f !== "file") body.set(f, values[f]);
    if (replacesId) body.set("replacesId", replacesId);
    try {
      const res = await fetch("/api/developer/knowledge/upload", { method: "POST", body });
      const r = (await res.json()) as { ok: true; data: { id: string } } | { ok: false; error: string; fieldErrors?: Partial<Record<Field, string>> };
      if (!r.ok) {
        setError(r.error);
        if (r.fieldErrors) setServerErrors(r.fieldErrors);
        setBusy(false);
        return;
      }
      router.push(`/developer/knowledge/${r.data.id}`);
    } catch {
      setError("The document could not be uploaded. Check the connection and try again.");
      setBusy(false);
    }
  };

  const input = (f: Field, type = "text", extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="lbl">
        {LABEL[f]}
        {required.includes(f) ? " *" : ""}
      </span>
      <input id={`kb-${f}`} className="input" type={type} value={values[f]} onChange={(e) => set(f, e.target.value)} onBlur={() => setTouched((t) => ({ ...t, [f]: "blur" }))} aria-invalid={!!err(f)} aria-describedby={err(f) ? `kb-${f}-err` : undefined} style={{ minHeight: 40 }} {...extra} />
      {err(f) ? (
        <span id={`kb-${f}-err`} role="alert" style={{ fontSize: 13, color: C.orange }}>
          {err(f)}
        </span>
      ) : null}
    </label>
  );

  return (
    <form onSubmit={submit} noValidate className="card" style={{ padding: 28, display: "flex", flexDirection: "column", gap: 18, maxWidth: 820 }}>
      {error ? (
        <div role="alert" className="inner" style={{ padding: "12px 14px", display: "flex", gap: 10, color: C.orange }}>
          <Icon name="alertCircle" size={18} /> <span>{error}</span>
        </div>
      ) : null}
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="lbl">Document *</span>
        <input
          id="kb-file"
          ref={fileRef}
          className="input"
          type="file"
          accept=".pdf,.docx,.txt,.md"
          onChange={(e) => {
            const f = e.target.files?.[0];
            set("file", f?.name ?? "");
            if (f && !values.title) set("title", f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
          }}
          onBlur={() => setTouched((t) => ({ ...t, file: "blur" }))}
          aria-invalid={!!err("file")}
          style={{ padding: 8, minHeight: 44 }}
        />
        <span className="mut" style={{ fontSize: 13 }}>PDF with a text layer, Word (.docx), text or Markdown, up to 25 MB. A scan without text cannot be read; type it into a .docx or .txt file.</span>
        {err("file") ? (
          <span role="alert" style={{ fontSize: 13, color: C.orange }}>
            {err("file")}
          </span>
        ) : null}
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
        {input("title")}
        {input("docNumber", "text", { placeholder: "ID.No. 35/SC-IV/TSCSB/2024, or —" })}
        {input("issuingBody", "text", { placeholder: "TS Cyber Security Bureau" })}
        {input("jurisdiction")}
        {input("version", "text", { placeholder: "13.04.2024" })}
        {input("effectiveFrom", "date")}
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="lbl">Kind *</span>
          <select id="kb-category" className="input" value={values.category} onChange={(e) => set("category", e.target.value)} style={{ minHeight: 40 }}>
            <option value="SOP">SOP</option>
            <option value="CIRCULAR">Circular</option>
            <option value="LAW">Law</option>
            <option value="PROVIDER">Provider or platform guide</option>
            <option value="OTHER">Other guide or training</option>
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="lbl">Replaces (optional)</span>
          <select className="input" value={replacesId} onChange={(e) => setReplacesId(e.target.value)} style={{ minHeight: 40 }}>
            <option value="">Nothing: a new document</option>
            {current.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title} ({d.version})
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="lbl">What it covers *</span>
        <textarea id="kb-summary" className="input" rows={2} value={values.summary} onChange={(e) => set("summary", e.target.value)} onBlur={() => setTouched((t) => ({ ...t, summary: "blur" }))} aria-invalid={!!err("summary")} style={{ padding: 10 }} />
        {err("summary") ? (
          <span role="alert" style={{ fontSize: 13, color: C.orange }}>
            {err("summary")}
          </span>
        ) : null}
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="lbl">Caution shown with it (optional)</span>
        <input className="input" value={values.reviewNote} onChange={(e) => set("reviewNote", e.target.value)} placeholder="Provider policies change: check the live page before quoting a period." style={{ minHeight: 40 }} />
      </label>
      <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
        <Link className="btn" href="/developer/knowledge">
          Cancel
        </Link>
        <button className="btn primary" type="submit" aria-busy={busy}>
          {busy ? <Icon name="spinner" size={16} className="spin" /> : null}
          {busy ? "Reading the document…" : "Upload and check the sections"}
        </button>
      </div>
      <p className="mut" style={{ fontSize: 13, margin: 0 }}>
        The document is kept as a draft. You check how it was split into sections before publishing it; until then the assistant does not answer from it.
      </p>
    </form>
  );
}
