"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";

/**
 * A date filter: one day, or a range, picked from ready choices (today, last 7 days, this month, last month, last
 * 3 or 6 months, this year, last year) or typed. Until one is chosen the view keeps its usual period; "Clear"
 * returns to it. Dates are the Indian calendar day (IST).
 */

export interface DateRange {
  /** YYYY-MM-DD, first day included. */
  from: string;
  /** YYYY-MM-DD, last day included. */
  to: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ist = () => new Date(Date.now() + 330 * 60 * 1000);
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const monthStart = (d: Date, back = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
const monthEnd = (d: Date, back = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back + 1, 0));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dateLabel = (s: string) => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return `${pad(d)} ${MON[m - 1]} ${y}`;
};
export const rangeLabel = (r: DateRange) => (r.from === r.to ? dateLabel(r.from) : `${dateLabel(r.from)} – ${dateLabel(r.to)}`);
const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function presets(): { label: string; r: DateRange }[] {
  const t = ist();
  const today = ymd(t);
  return [
    { label: "Today", r: { from: today, to: today } },
    { label: "Yesterday", r: { from: ymd(addDays(t, -1)), to: ymd(addDays(t, -1)) } },
    { label: "Last 7 days", r: { from: ymd(addDays(t, -6)), to: today } },
    { label: "Last 30 days", r: { from: ymd(addDays(t, -29)), to: today } },
    { label: "This month", r: { from: ymd(monthStart(t)), to: today } },
    { label: "Last month", r: { from: ymd(monthStart(t, 1)), to: ymd(monthEnd(t, 1)) } },
    { label: "Last 3 months", r: { from: ymd(monthStart(t, 2)), to: today } },
    { label: "Last 6 months", r: { from: ymd(monthStart(t, 5)), to: today } },
    { label: "This year", r: { from: `${t.getUTCFullYear()}-01-01`, to: today } },
    { label: "Last year", r: { from: `${t.getUTCFullYear() - 1}-01-01`, to: `${t.getUTCFullYear() - 1}-12-31` } },
  ];
}

export function DateRangeFilter({ value, onChange, label, usual }: { value: DateRange | null; onChange: (r: DateRange | null) => void; label: string; usual: string }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value?.from ?? "");
  const [to, setTo] = useState(value?.to ?? "");
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (r: DateRange | null) => {
    setOpen(false);
    setErr(null);
    onChange(r);
  };
  const apply = () => {
    const f = from || to;
    const t = to || from;
    if (!valid(f) || !valid(t)) return setErr("Choose a date, or both ends of a range.");
    if (f > t) return setErr("The first date is after the last.");
    pick({ from: f, to: t });
  };
  const today = ymd(ist());
  return (
    <div ref={box} className="drf" style={{ position: "relative" }}>
      <button
        type="button"
        className={`drf-btn icon${value ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        // An icon only: the period in use is written where its figures are; the name and tooltip say it too.
        aria-label={value ? `${label}: ${rangeLabel(value)}. Change or clear it` : `${label}: ${usual.toLowerCase()}. Choose a date or range`}
        title={value ? `${label}: ${rangeLabel(value)}` : `${label}: ${usual.toLowerCase()}. Choose a date or range`}
        onClick={() => {
          setFrom(value?.from ?? "");
          setTo(value?.to ?? "");
          setErr(null);
          setOpen((o) => !o);
        }}
      >
        <Icon name="calendar" size={16} />
        {value ? <span className="drf-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label={label} className="drf-pop">
          <div className="drf-grid">
            {presets().map((p) => (
              <button key={p.label} type="button" className={`drf-opt${value && value.from === p.r.from && value.to === p.r.to ? " on" : ""}`} onClick={() => pick(p.r)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="drf-custom">
            <label>
              <span>From</span>
              <input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          {err ? (
            <div role="alert" className="drf-err">
              {err}
            </div>
          ) : (
            <div className="drf-hint">One day: fill one date. A range: fill both.</div>
          )}
          <div className="drf-foot">
            <button type="button" className="drf-opt" onClick={() => pick(null)} disabled={!value}>
              Clear ({usual})
            </button>
            <button type="button" className="drf-apply" onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
