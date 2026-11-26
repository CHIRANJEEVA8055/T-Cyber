"use client";

import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import type { TrailPreview } from "@/server/services/ncrp-trail";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "");

/**
 * The NCRP money-trail export (Excel or CSV), added with the FIR: read at once and summed up here (accounts, layers,
 * transfers, holds, withdrawals, and rows that could not be used), then added to the case when it opens.
 */
export function NcrpTrailPicker({ file, preview, onChange }: { file: File | null; preview: TrailPreview | null; onChange: (file: File | null, preview: TrailPreview | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setBusy(true);
    const body = new FormData();
    body.set("file", f);
    try {
      const res = await fetch("/api/ncrp-trail/preview", { method: "POST", body });
      const j = (await res.json().catch(() => null)) as { ok: boolean; data?: TrailPreview; error?: string; fieldErrors?: Record<string, string> } | null;
      if (j?.ok && j.data) onChange(f, j.data);
      else {
        setError(j?.fieldErrors?.file && j.error === "Some fields need attention." ? j.fieldErrors.file : (j?.error ?? "The file could not be read."));
        onChange(null, null);
      }
    } catch {
      setError("The connection was lost while reading the file. Try again.");
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  };
  const p = preview;
  return (
    <section aria-labelledby="ncrp-trail-h" className="inner" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <input ref={ref} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden aria-hidden tabIndex={-1} onChange={(e) => void pick(e.target.files?.[0])} />
      <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ width: 36, height: 36, borderRadius: 10, background: C.tintTeal, color: C.teal, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
          <Icon name="file" size={18} />
        </span>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <div id="ncrp-trail-h" style={{ fontSize: 15, fontWeight: 600 }}>
            NCRP money trail <span className="mut" style={{ fontWeight: 400 }}>(optional)</span>
          </div>
          <div className="sec" style={{ fontSize: 13 }}>
            {file && p ? `${file.name}: added to the case when it opens.` : "The Excel export from NCRP showing where the money went, layer by layer. Its accounts, transfers and holds are linked into the case from the start."}
          </div>
        </div>
        {file && p ? (
          <>
            <button className="btn sm" type="button" onClick={() => ref.current?.click()} disabled={busy}>
              Replace
            </button>
            <button className="btn sm" type="button" onClick={() => (onChange(null, null), setError(null))}>
              Remove
            </button>
          </>
        ) : (
          <button className="btn sm" type="button" onClick={() => ref.current?.click()} aria-busy={busy}>
            {busy ? "Reading…" : "Add the NCRP Excel"}
          </button>
        )}
      </div>
      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: C.orange }}>
          {error}
        </p>
      ) : null}
      {p ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
          <p style={{ margin: 0 }}>
            {p.rowCount} {p.rowCount === 1 ? "row" : "rows"}
            {p.layers.length ? `, layers ${p.layers[0]}${p.layers.length > 1 ? ` to ${p.layers.at(-1)}` : ""}` : ""}: {p.accounts} accounts · {p.transfers.count} onward {p.transfers.count === 1 ? "transfer" : "transfers"} ({p.transfers.total}) · {p.holds.count} on hold ({p.holds.total}) · {p.cash.count} cash {p.cash.count === 1 ? "withdrawal" : "withdrawals"} ({p.cash.total})
            {p.acks.length ? ` · ack ${p.acks.join(", ")}` : ""}.
          </p>
          <ol className="mut" style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "flex", flexDirection: "column", gap: 2 }}>
            {(all ? p.rows : p.rows.slice(0, 6)).map((r) => (
              <li key={r.line}>
                {r.layer ? `Layer ${r.layer}: ` : ""}
                {r.text}
                {r.when ? `, ${when(r.when)}` : ""} <span style={{ opacity: 0.7 }}>(row {r.line})</span>
              </li>
            ))}
          </ol>
          {p.rows.length > 6 ? (
            <button className="tab" type="button" style={{ alignSelf: "flex-start", minHeight: 28, padding: "0 8px", color: C.blue }} onClick={() => setAll((x) => !x)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${p.rows.length}${p.rowCount > p.rows.length ? ` of ${p.rowCount}` : ""} rows`}
            </button>
          ) : null}
          {p.skipped.length ? (
            <p style={{ margin: 0, fontSize: 13, color: C.orange }}>
              {p.skipped.length} {p.skipped.length === 1 ? "row" : "rows"} cannot be used: {p.skipped.slice(0, 3).map((s) => `row ${s.line} (${s.reason.replace(/\.$/, "")})`).join("; ")}
              {p.skipped.length > 3 ? "; …" : ""}. Check them in the file.
            </p>
          ) : null}
          <p className="mut" style={{ margin: 0, fontSize: 12 }}>
            Columns read: {p.columns.map((c) => `${c.header} → ${c.meaning}`).join(" · ")}
            {p.sheet ? ` (sheet "${p.sheet}", headings on row ${p.headerRow})` : ""}.
          </p>
        </div>
      ) : null}
    </section>
  );
}
