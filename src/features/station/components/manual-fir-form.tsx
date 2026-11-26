"use client";

import { useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { formatInr, parseRupeesToMinor } from "@/domain/money";
import { classifyMo, MO_VERTICALS } from "@/domain/mo-verticals";
import { manualFirSchema, PAYMENT_MODES } from "@/contracts/manual-fir";
import { openCaseManuallyAction } from "../actions";

/**
 * The New FIR window's Manual tab: an FIR typed in from the registered copy, field by field in the order of the
 * CCTNS form, so any FIR fits (several victims, several accused, several payments). Each field is checked when the
 * officer leaves it, never while typing. The draft is kept in this browser tab only (it holds personal details) and
 * is cleared once the case opens. A printable copy can be downloaded at any point; the same copy is kept with the
 * case, marked as prepared by hand.
 */

interface Victim { name: string; relative: string; age: string; occupation: string; address: string; mobile: string; email: string }
interface Accused { name: string; phones: string; emails: string; accounts: string; profiles: string; address: string }
interface Payment { amount: string; mode: string; paidOn: string; paidTime: string; payer: string; fromAccount: string; fromBank: string; to: string; toIfsc: string; toBank: string; reference: string }
interface Form {
  fir: string;
  registeredOn: string;
  registeredTime: string;
  gdEntry: string;
  sections: string;
  ack: string;
  occurredFrom: string;
  occurredTo: string;
  place: string;
  delayReason: string;
  victims: Victim[];
  narrative: string;
  payments: Payment[];
  accused: Accused[];
  moVertical: string;
  moSubtype: string;
}
export interface ManualPrefill {
  ack: string;
  complainant: string | null;
  lossRupees: string | null;
}

const V0: Victim = { name: "", relative: "", age: "", occupation: "", address: "", mobile: "", email: "" };
const A0: Accused = { name: "", phones: "", emails: "", accounts: "", profiles: "", address: "" };
const P0: Payment = { amount: "", mode: "UPI", paidOn: "", paidTime: "", payer: "0", fromAccount: "", fromBank: "", to: "", toIfsc: "", toBank: "", reference: "" };
const KEY = "tc-newfir-manual-draft";
const blank = (prefill: ManualPrefill | null): Form => ({
  fir: "",
  registeredOn: "",
  registeredTime: "",
  gdEntry: "",
  sections: "",
  ack: prefill?.ack ?? "",
  occurredFrom: "",
  occurredTo: "",
  place: "",
  delayReason: "",
  victims: [{ ...V0, name: prefill?.complainant ?? "" }],
  narrative: "",
  payments: [{ ...P0, amount: prefill?.lossRupees ?? "" }],
  accused: [{ ...A0 }],
  moVertical: "",
  moSubtype: "",
});
const hasContent = (f: Form) => !!(f.fir || f.narrative || f.victims.some((v) => v.name) || f.payments.some((p) => p.to || p.reference) || f.accused.some((a) => Object.values(a).some(Boolean)));

function payloadOf(f: Form) {
  const m = /^(\d{1,6})\s*\/\s*(\d{4})$/.exec(f.fir.trim());
  return {
    firNumber: m?.[1] ?? "",
    firYear: m?.[2] ?? "",
    registeredOn: f.registeredOn,
    registeredTime: f.registeredTime,
    gdEntry: f.gdEntry,
    sections: f.sections,
    ack: f.ack,
    occurredFrom: f.occurredFrom,
    occurredTo: f.occurredTo,
    place: f.place,
    delayReason: f.delayReason,
    victims: f.victims,
    narrative: f.narrative,
    payments: f.payments,
    accused: f.accused,
    moVertical: f.moVertical,
    moSubtype: f.moSubtype,
  };
}

/** Every problem in the form, keyed by field ("victims.1.email"); the FIR number and year are one field, "fir". */
function problems(f: Form): Record<string, string> {
  const out: Record<string, string> = {};
  if (!/^(\d{1,6})\s*\/\s*(\d{4})$/.test(f.fir.trim())) out.fir = "Enter the FIR number as number/year, like 412/2026.";
  const r = manualFirSchema.safeParse(payloadOf(f));
  if (!r.success)
    for (const i of r.error.issues) {
      const k = i.path[0] === "firNumber" || i.path[0] === "firYear" ? "fir" : i.path.join(".");
      out[k] ??= i.message;
    }
  return out;
}
const idOf = (key: string) => `nf-${key.replace(/\./g, "-")}`;

export function ManualFirForm({ prefill, onOpened }: { prefill: ManualPrefill | null; onOpened: (caseId: string) => void }) {
  const [f, setF] = useState<Form>(() => {
    try {
      const saved = typeof window !== "undefined" ? window.sessionStorage.getItem(KEY) : null;
      if (saved && !prefill) return { ...blank(null), ...(JSON.parse(saved) as Partial<Form>) };
    } catch {
      /* a draft that cannot be read is ignored */
    }
    return blank(prefill);
  });
  const [restored] = useState(() => !prefill && hasContent(f));
  const [showRestored, setShowRestored] = useState(restored);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"open" | "copy" | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // The draft is kept for this tab only, a moment after each change.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        if (hasContent(f)) window.sessionStorage.setItem(KEY, JSON.stringify(f));
      } catch {
        /* storage may be full or blocked; the form still works */
      }
    }, 600);
    return () => window.clearTimeout(t);
  }, [f]);

  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const setRow = <K extends "victims" | "payments" | "accused">(k: K, i: number, patch: Partial<Form[K][number]>) => setF((x) => ({ ...x, [k]: (x[k] as Form[K][number][]).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addRow = (k: "victims" | "payments" | "accused") => setF((x) => ({ ...x, [k]: [...x[k], k === "victims" ? { ...V0 } : k === "payments" ? { ...P0 } : { ...A0 }] }));
  const removeRow = (k: "victims" | "payments" | "accused", i: number) => {
    setF((x) => ({ ...x, [k]: x[k].filter((_, j) => j !== i), ...(k === "victims" ? { payments: x.payments.map((p) => ({ ...p, payer: Number(p.payer) === i ? "0" : Number(p.payer) > i ? String(Number(p.payer) - 1) : p.payer })) } : {}) }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([key]) => !key.startsWith(`${k}.`))));
  };

  // Checked when the officer leaves a field; the message clears as soon as they come back to it.
  const onBlur = (e: FocusEvent<HTMLFormElement>) => {
    const target = e.target as unknown as HTMLInputElement;
    const key = target.name;
    if (!key) return;
    const p = problems(f)[key];
    // An optional field left empty is not an error; a required one is.
    const required = key === "fir" || key === "registeredOn" || key === "registeredTime" || /^victims\.\d+\.name$/.test(key) || key === "narrative";
    setErrors((x) => {
      const { [key]: _, ...rest } = x;
      return p && (target.value || required) ? { ...rest, [key]: p } : rest;
    });
  };
  const onFocus = (e: FocusEvent<HTMLFormElement>) => {
    const key = (e.target as unknown as HTMLInputElement).name;
    if (key && errors[key]) setErrors(({ [key]: _, ...rest }) => rest);
  };

  const check = (): boolean => {
    const p = problems(f);
    setErrors(p);
    const first = Object.keys(p)[0];
    if (first) {
      setError(Object.keys(p).length > 1 ? `${Object.keys(p).length} fields need attention. Each is marked below.` : "One field needs attention. It is marked below.");
      const el = document.getElementById(idOf(first));
      el?.scrollIntoView({ block: "center" });
      el?.focus({ preventScroll: true });
      return false;
    }
    setError(null);
    return true;
  };

  const open = async () => {
    if (busy || !check()) return;
    setBusy("open");
    const r = await openCaseManuallyAction(payloadOf(f));
    setBusy(null);
    if (r.ok) {
      try {
        window.sessionStorage.removeItem(KEY);
      } catch {
        /* nothing to clear */
      }
      onOpened(r.data.caseId);
      return;
    }
    setError(r.error);
    setErrors(Object.fromEntries(Object.entries(r.fieldErrors ?? {}).map(([k, v]) => [k === "firNumber" || k === "firYear" ? "fir" : k, v])));
  };

  const downloadCopy = async () => {
    if (busy || !check()) return;
    setBusy("copy");
    try {
      const res = await fetch("/api/fir/copy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadOf(f)) });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string; fieldErrors?: Record<string, string> } | null;
        setError(j?.error ?? "The copy could not be made. Try again.");
        if (j?.fieldErrors) setErrors(j.fieldErrors);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `FIR_${payloadOf(f).firNumber}_${payloadOf(f).firYear}_prepared.pdf`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      setError("The connection was lost while making the copy. Nothing was stored. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const discard = () => {
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
    setF(blank(prefill));
    setErrors({});
    setError(null);
    setShowRestored(false);
  };

  const auto = useMemo(() => classifyMo({ facts: f.narrative, sections: f.sections }), [f.narrative, f.sections]);
  const kinds = MO_VERTICALS.find((v) => v.key === f.moVertical)?.kinds ?? [];
  const total = f.payments.reduce((s, p) => {
    const m = parseRupeesToMinor(p.amount);
    return m.ok ? s + m.value : s;
  }, 0n);

  // A labelled control with its hint or error underneath, wired for screen readers.
  const field = (key: string, label: ReactNode, control: (a: { id: string; name: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode, opts: { required?: boolean; hint?: string; className?: string } = {}) => {
    const id = idOf(key);
    const msg = errors[key];
    return (
      <label className={`f${opts.className ? ` ${opts.className}` : ""}`} htmlFor={id}>
        <span>
          {label} {opts.required && <span className="req">required</span>}
        </span>
        {control({ id, name: key, "aria-invalid": !!msg, "aria-describedby": msg ? `${id}-err` : opts.hint ? `${id}-hint` : undefined })}
        {msg ? (
          <span className="hint" id={`${id}-err`} role="alert" style={{ color: C.red }}>
            {msg}
          </span>
        ) : opts.hint ? (
          <span className="hint" id={`${id}-hint`}>
            {opts.hint}
          </span>
        ) : null}
      </label>
    );
  };
  const section = (title: string, children: ReactNode, action?: ReactNode, sub?: string) => (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h3 className="h" style={{ fontSize: 16 }}>
            {title}
          </h3>
          {sub && <p className="mut" style={{ margin: "2px 0 0", fontSize: 13 }}>{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
  const rowHead = (title: string, onRemove: (() => void) | null, removeLabel: string) => (
    <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      {onRemove && (
        <button className="tab" type="button" onClick={onRemove} style={{ minHeight: 32, padding: "0 10px", fontSize: 13, color: C.red }}>
          {removeLabel}
        </button>
      )}
    </div>
  );

  return (
    <>
      <form ref={formRef} style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 26 }} aria-label="FIR details" noValidate onBlur={onBlur} onFocus={onFocus} onSubmit={(e) => (e.preventDefault(), void open())}>
        {showRestored && (
          <div className="ackbar" role="status" style={{ margin: 0 }}>
            <Icon name="info" />
            <span>
              The details you were typing in this tab are back.{" "}
              <button className="tab" type="button" onClick={discard} style={{ minHeight: 28, padding: "0 8px", color: C.blue }}>
                Discard and start again
              </button>
            </span>
          </div>
        )}

        {section(
          "The FIR",
          <div className="g3">
            {field("fir", "FIR number", (a) => <input {...a} className="in" type="text" inputMode="numeric" placeholder="412/2026" autoComplete="off" value={f.fir} onChange={(e) => set({ fir: e.target.value })} />, { required: true })}
            {field("registeredOn", "Date registered", (a) => <input {...a} className="in" type="date" value={f.registeredOn} onChange={(e) => set({ registeredOn: e.target.value })} />, { required: true })}
            {field("registeredTime", "Time registered", (a) => <input {...a} className="in" type="time" value={f.registeredTime} onChange={(e) => set({ registeredTime: e.target.value })} />, { required: true, hint: "As on the FIR, 24-hour." })}
            {field("sections", "Acts & sections", (a) => <input {...a} className="in" type="text" placeholder="BNS 318(4), 319(2); IT Act 66D" value={f.sections} onChange={(e) => set({ sections: e.target.value })} />, { className: "span2", hint: "Exactly as the FIR states them. T-CYBER never adds sections." })}
            {field("gdEntry", "GD entry no.", (a) => <input {...a} className="in" type="text" value={f.gdEntry} onChange={(e) => set({ gdEntry: e.target.value })} />)}
            {field("ack", "NCRP acknowledgement no.", (a) => <input {...a} className="in num" type="text" inputMode="numeric" value={f.ack} onChange={(e) => set({ ack: e.target.value })} />, { hint: "Links the FIR to the complaint in the register." })}
          </div>,
        )}

        {section(
          "When and where",
          <div className="g3">
            {field("occurredFrom", "Occurrence from", (a) => <input {...a} className="in" type="datetime-local" value={f.occurredFrom} onChange={(e) => set({ occurredFrom: e.target.value })} />)}
            {field("occurredTo", "Occurrence to", (a) => <input {...a} className="in" type="datetime-local" value={f.occurredTo} onChange={(e) => set({ occurredTo: e.target.value })} />)}
            {field("place", "Place of occurrence", (a) => <input {...a} className="in" type="text" placeholder="Online, or the address" value={f.place} onChange={(e) => set({ place: e.target.value })} />)}
            {field("delayReason", "Reason for delay in reporting", (a) => <input {...a} className="in" type="text" placeholder="If the FIR gives one" value={f.delayReason} onChange={(e) => set({ delayReason: e.target.value })} />, { className: "span3" })}
          </div>,
        )}

        {section(
          f.victims.length > 1 ? "The complainant and other victims" : "The complainant",
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {f.victims.map((v, i) => (
              <div key={i} className="inner" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                {rowHead(i === 0 ? "Complainant" : `Victim ${i + 1}`, i === 0 ? null : () => removeRow("victims", i), `Remove victim ${i + 1}`)}
                <div className="g3">
                  {field(`victims.${i}.name`, "Full name", (a) => <input {...a} className="in" type="text" autoComplete="off" placeholder="As written in the FIR" value={v.name} onChange={(e) => setRow("victims", i, { name: e.target.value })} />, { required: true })}
                  {field(`victims.${i}.relative`, "Father's or husband's name", (a) => <input {...a} className="in" type="text" autoComplete="off" placeholder="S/o, D/o or W/o …" value={v.relative} onChange={(e) => setRow("victims", i, { relative: e.target.value })} />)}
                  {field(`victims.${i}.age`, "Age", (a) => <input {...a} className="in num" type="text" inputMode="numeric" value={v.age} onChange={(e) => setRow("victims", i, { age: e.target.value })} />)}
                  {field(`victims.${i}.occupation`, "Occupation", (a) => <input {...a} className="in" type="text" value={v.occupation} onChange={(e) => setRow("victims", i, { occupation: e.target.value })} />)}
                  {field(`victims.${i}.mobile`, "Mobile number", (a) => <input {...a} className="in" type="tel" autoComplete="off" placeholder="+91 98XXXXXX10" value={v.mobile} onChange={(e) => setRow("victims", i, { mobile: e.target.value })} />, { hint: "Noted as their own; never requested." })}
                  {field(`victims.${i}.email`, "Email", (a) => <input {...a} className="in" type="email" autoComplete="off" placeholder="name@domain.in" value={v.email} onChange={(e) => setRow("victims", i, { email: e.target.value })} />)}
                  {field(`victims.${i}.address`, "Address", (a) => <input {...a} className="in" type="text" autoComplete="off" value={v.address} onChange={(e) => setRow("victims", i, { address: e.target.value })} />, { className: "span3" })}
                </div>
              </div>
            ))}
          </div>,
          <button className="btn sm" type="button" onClick={() => addRow("victims")}>
            Add another victim
          </button>,
        )}

        {section(
          "What happened",
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {field("narrative", "First information (brief facts)", (a) => <textarea {...a} className="ta" rows={7} placeholder="As the FIR records it: what was promised or threatened, and in what order things happened" value={f.narrative} onChange={(e) => set({ narrative: e.target.value })} />, { required: true })}
            <p className="mut" style={{ margin: 0, fontSize: 13 }} aria-live="polite">
              Investigation vertical:{" "}
              <strong style={{ fontWeight: 600, color: "inherit" }}>
                {f.moVertical ? `${MO_VERTICALS.find((v) => v.key === f.moVertical)?.label}${f.moSubtype ? ` · ${f.moSubtype}` : ""}, as you chose` : auto.vertical ? `${auto.vertical.label}${auto.subtype ? ` · ${auto.subtype}` : ""}` : "not clear yet"}
              </strong>
              {!f.moVertical && auto.vertical ? ` · ${auto.basis === "SECTIONS" ? `from the stated ${auto.signs[0]}` : `from the facts: ${auto.signs.slice(0, 3).join(", ")}`}` : ""}
            </p>
            <div className="g3">
              {field("moVertical", "Set the vertical yourself", (a) => (
                <select {...a} className="sel" value={f.moVertical} onChange={(e) => set({ moVertical: e.target.value, moSubtype: "" })}>
                  <option value="">Read from the facts</option>
                  {MO_VERTICALS.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.label}
                    </option>
                  ))}
                </select>
              ))}
              {f.moVertical && kinds.length > 0 &&
                field("moSubtype", "Kind of fraud", (a) => (
                  <select {...a} className="sel" value={f.moSubtype} onChange={(e) => set({ moSubtype: e.target.value })}>
                    <option value="">Not specified</option>
                    {kinds.map((k) => (
                      <option key={k.label} value={k.label}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                ))}
            </div>
          </div>,
        )}

        {section(
          "The money",
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {f.payments.map((p, i) => (
              <div key={i} className="inner" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                {rowHead(f.payments.length > 1 ? `Payment ${i + 1}` : "Payment", f.payments.length > 1 ? () => removeRow("payments", i) : null, `Remove payment ${i + 1}`)}
                <div className="g3">
                  {field(`payments.${i}.amount`, "Amount (₹)", (a) => <input {...a} className="in num" type="text" inputMode="decimal" placeholder="48,000" value={p.amount} onChange={(e) => setRow("payments", i, { amount: e.target.value })} />)}
                  {field(`payments.${i}.mode`, "Paid by", (a) => (
                    <select {...a} className="sel" value={p.mode} onChange={(e) => setRow("payments", i, { mode: e.target.value })}>
                      {PAYMENT_MODES.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ))}
                  {f.victims.length > 1 &&
                    field(`payments.${i}.payer`, "Paid by whom", (a) => (
                      <select {...a} className="sel" value={p.payer} onChange={(e) => setRow("payments", i, { payer: e.target.value })}>
                        {f.victims.map((v, j) => (
                          <option key={j} value={String(j)}>
                            {v.name || (j === 0 ? "The complainant" : `Victim ${j + 1}`)}
                          </option>
                        ))}
                      </select>
                    ))}
                  {field(`payments.${i}.paidOn`, "Paid on", (a) => <input {...a} className="in" type="date" value={p.paidOn} onChange={(e) => setRow("payments", i, { paidOn: e.target.value })} />)}
                  {field(`payments.${i}.paidTime`, "At", (a) => <input {...a} className="in" type="time" value={p.paidTime} onChange={(e) => setRow("payments", i, { paidTime: e.target.value })} />)}
                  {field(`payments.${i}.reference`, "Transaction reference", (a) => <input {...a} className="in num" type="text" autoComplete="off" placeholder="UTR or UPI reference" value={p.reference} onChange={(e) => setRow("payments", i, { reference: e.target.value })} />)}
                  {field(`payments.${i}.fromAccount`, "From account (the payer's own)", (a) => <input {...a} className="in num" type="text" autoComplete="off" placeholder="If the FIR gives it" value={p.fromAccount} onChange={(e) => setRow("payments", i, { fromAccount: e.target.value })} />)}
                  {field(`payments.${i}.fromBank`, "Payer's bank", (a) => <input {...a} className="in" type="text" value={p.fromBank} onChange={(e) => setRow("payments", i, { fromBank: e.target.value })} />, { className: "span2" })}
                  {field(`payments.${i}.to`, "To account or UPI ID", (a) => <input {...a} className="in num" type="text" autoComplete="off" placeholder="Account number, or name@bank" value={p.to} onChange={(e) => setRow("payments", i, { to: e.target.value })} />)}
                  {field(`payments.${i}.toIfsc`, "IFSC", (a) => <input {...a} className="in num" type="text" autoComplete="off" placeholder="SBIN0001234" value={p.toIfsc} onChange={(e) => setRow("payments", i, { toIfsc: e.target.value.toUpperCase() })} />)}
                  {field(`payments.${i}.toBank`, "Beneficiary bank", (a) => <input {...a} className="in" type="text" value={p.toBank} onChange={(e) => setRow("payments", i, { toBank: e.target.value })} />)}
                </div>
              </div>
            ))}
            {total > 0n && (
              <p className="mut" style={{ margin: 0, fontSize: 13 }}>
                Total entered: <strong style={{ fontWeight: 600, color: "inherit" }}>{formatInr(total)}</strong> across {f.payments.filter((p) => p.amount).length} {f.payments.filter((p) => p.amount).length === 1 ? "payment" : "payments"}.
              </p>
            )}
          </div>,
          <button className="btn sm" type="button" onClick={() => addRow("payments")}>
            Add another payment
          </button>,
        )}

        {section(
          "The accused",
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {f.accused.map((x, i) => (
              <div key={i} className="inner" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                {rowHead(`Accused ${i + 1}`, f.accused.length > 1 ? () => removeRow("accused", i) : null, `Remove accused ${i + 1}`)}
                <div className="g3">
                  {field(`accused.${i}.name`, "Name, as the FIR gives it", (a) => <input {...a} className="in" type="text" autoComplete="off" placeholder="If known" value={x.name} onChange={(e) => setRow("accused", i, { name: e.target.value })} />, { hint: "Kept as “stated to be”, until KYC confirms it." })}
                  {field(`accused.${i}.phones`, "Phone numbers", (a) => <input {...a} className="in" type="text" autoComplete="off" placeholder="Separate with commas" value={x.phones} onChange={(e) => setRow("accused", i, { phones: e.target.value })} />)}
                  {field(`accused.${i}.emails`, "Email addresses", (a) => <input {...a} className="in" type="text" autoComplete="off" placeholder="Separate with commas" value={x.emails} onChange={(e) => setRow("accused", i, { emails: e.target.value })} />)}
                  {field(`accused.${i}.accounts`, "Bank accounts or UPI IDs", (a) => <input {...a} className="in" type="text" autoComplete="off" placeholder="Number and IFSC, or name@bank" value={x.accounts} onChange={(e) => setRow("accused", i, { accounts: e.target.value })} />)}
                  {field(`accused.${i}.profiles`, "Profiles, websites or apps", (a) => <input {...a} className="in" type="text" autoComplete="off" placeholder="Handle, https://…" value={x.profiles} onChange={(e) => setRow("accused", i, { profiles: e.target.value })} />)}
                  {field(`accused.${i}.address`, "Address", (a) => <input {...a} className="in" type="text" autoComplete="off" placeholder="If the FIR gives one" value={x.address} onChange={(e) => setRow("accused", i, { address: e.target.value })} />)}
                </div>
              </div>
            ))}
          </div>,
          <button className="btn sm" type="button" onClick={() => addRow("accused")}>
            Add another accused
          </button>,
          "Unknown accused are entered by what is known of them: a number, an account, a profile.",
        )}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>

      {error && (
        <div className="ackbar" role="alert" style={{ margin: "0 28px 16px", borderColor: "rgba(248,113,113,0.35)" }}>
          <Icon name="alertCircle" />
          <span>{error}</span>
        </div>
      )}

      <div style={{ padding: "16px 28px", borderTop: `1px solid ${C.line}`, display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
        <span className="mut" style={{ marginRight: "auto", fontSize: 13, flex: "1 1 260px" }}>
          Required fields are marked. A copy of these details is kept with the case, marked as prepared by hand. Nothing is sent when the case opens.
        </span>
        <D.Close className="btn" type="button">
          Cancel
        </D.Close>
        <button className="btn" type="button" onClick={downloadCopy} aria-busy={busy === "copy"}>
          <Icon name="download" />
          {busy === "copy" ? "Making the copy…" : "Download FIR copy (PDF)"}
        </button>
        <button className="btn primary" type="button" onClick={open} aria-busy={busy === "open"}>
          {busy === "open" ? "Opening the case…" : "Open the case"}
        </button>
      </div>
    </>
  );
}
