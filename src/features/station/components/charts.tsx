"use client";

import type { KeyboardEvent } from "react";

/**
 * The dashboard's trend charts, drawn as the design draws them (520×220, plot area x 40–500, y 20–180), but
 * scaled from the data. Every bar or point opens its list; each is also reachable from the keyboard, and a
 * hidden table carries the figures for screen readers.
 */

export interface ChartDatum {
  key: string;
  label: string;
  short: string;
  value: number;
  title: string;
}

const STEPS = [1, 2, 5, 10, 20, 25, 40, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
function scale(max: number, maxTicks = 4) {
  const step = STEPS.find((s) => Math.ceil(Math.max(max, 1) / s) <= maxTicks) ?? Math.ceil(max / maxTicks);
  const top = Math.max(step, Math.ceil(Math.max(max, 1) / step) * step);
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  return { top, ticks };
}
const r1 = (n: number) => Math.round(n * 10) / 10;
/** A label in up to two lines of about 12 characters, split at a space ("Waiting for Reply" → "Waiting for", "Reply"). */
function lines(label: string, max = 12): string[] {
  if (label.length <= max) return [label];
  const words = label.split(" ");
  let best: [string, string] = [label, ""];
  let score = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const sc = Math.max(a.length, b.length);
    if (sc < score) {
      score = sc;
      best = [a, b];
    }
  }
  return best[1] ? best : [label];
}
const key = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

export function ColumnChart({ data, label, onPick, classes = ["c5", "c1", "c4", "c3", "c2"], id }: { data: ChartDatum[]; label: string; onPick: (key: string) => void; classes?: string[]; id: string }) {
  const { top, ticks } = scale(Math.max(...data.map((d) => d.value), 0));
  const y = (v: number) => r1(180 - (v / top) * 160);
  const slot = 460 / Math.max(data.length, 1);
  return (
    <svg viewBox="0 0 520 220" role="img" aria-label={`${label}: ${data.map((d) => `${d.label.toLowerCase()} ${d.value}`).join(", ")}`}>
      <defs>
        <clipPath id={id}>
          <rect x="40" y="0" width="470" height="180" />
        </clipPath>
      </defs>
      <g className="cg">
        {ticks.slice(1).map((t) => (
          <line key={t} x1="40" x2="500" y1={y(t)} y2={y(t)} />
        ))}
      </g>
      <line className="ax" x1="40" x2="500" y1="180" y2="180" />
      <g className="ct" textAnchor="end">
        {ticks.map((t) => (
          <text key={t} x="32" y={y(t) + 4}>
            {t}
          </text>
        ))}
      </g>
      <g clipPath={`url(#${id})`}>
        {data.map((d, i) => {
          const cx = 40 + slot * (i + 0.5);
          const h = Math.max(r1((d.value / top) * 160), d.value > 0 ? 2 : 0);
          return (
            <rect key={d.key} className={`bf ${classes[i % classes.length]}`} x={r1(cx - 30)} y={r1(184 - h)} width="60" height={h} rx="4" role="button" tabIndex={0} aria-label={`${d.title}: open the list`} onClick={() => onPick(d.key)} onKeyDown={key(() => onPick(d.key))}>
              <title>{d.title}</title>
            </rect>
          );
        })}
      </g>
      {/* The figures and the names open the same list as their bar (the bar itself is the keyboard stop). */}
      <g className="cv clk" textAnchor="middle">
        {data.map((d, i) => (
          <text key={d.key} x={r1(40 + slot * (i + 0.5))} y={y(d.value) - 7} onClick={() => onPick(d.key)}>
            {d.value}
          </text>
        ))}
      </g>
      <g className="ct clk" textAnchor="middle">
        {data.map((d, i) => {
          const ls = lines(d.short);
          return (
            <text key={d.key} x={r1(40 + slot * (i + 0.5))} y={ls.length > 1 ? 198 : 204} onClick={() => onPick(d.key)}>
              <title>{d.title}</title>
              {ls.map((l, j) => (
                <tspan key={j} x={r1(40 + slot * (i + 0.5))} dy={j ? 14 : 0}>
                  {l}
                </tspan>
              ))}
            </text>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * A pie (drawn as a ring) with the overall count in its middle. Every slice, its legend line and the middle open a
 * list: a slice or a legend line its own, the middle the largest. Slices are keyboard stops; the legend is a list of
 * buttons beside the ring.
 */
export function PieChart({ data, label, onPick, total, unit, id }: { data: ChartDatum[]; label: string; onPick: (key: string) => void; total: number; unit: string; id: string }) {
  const cx = 104;
  const cy = 110;
  const R = 96;
  const r = 58;
  const sum = data.reduce((s, d) => s + d.value, 0) || 1;
  const pt = (a: number, rad: number) => `${r1(cx + rad * Math.sin(a))} ${r1(cy - rad * Math.cos(a))}`;
  // Where each slice starts: the share of the slices before it.
  const starts = data.map((_, i) => (data.slice(0, i).reduce((t, d) => t + d.value, 0) / sum) * Math.PI * 2);
  const slices = data.map((d, i) => {
    const a0 = starts[i]!;
    const a1 = a0 + (d.value / sum) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    // A slice that is the whole ring is drawn as two halves (an arc cannot start and end at the same point).
    const path =
      d.value >= sum
        ? `M${pt(0, R)} A${R} ${R} 0 1 1 ${pt(Math.PI, R)} A${R} ${R} 0 1 1 ${pt(0, R)} Z M${pt(0, r)} A${r} ${r} 0 1 0 ${pt(Math.PI, r)} A${r} ${r} 0 1 0 ${pt(0, r)} Z`
        : `M${pt(a0, R)} A${R} ${R} 0 ${large} 1 ${pt(a1, R)} L${pt(a1, r)} A${r} ${r} 0 ${large} 0 ${pt(a0, r)} Z`;
    return { d, i, path };
  });
  const pct = (v: number) => `${Math.round((v / sum) * 100)}%`;
  const top = data[0];
  return (
    <div className="piewrap">
      <svg viewBox="0 0 208 220" role="img" aria-label={`${label}: ${total} ${unit}; ${data.map((d) => `${d.label} ${d.value}`).join(", ")}`} className="piesvg">
        <g>
          {slices.map(({ d, i, path }) => (
            <path key={d.key} className={`bf pc${(i % 8) + 1}`} d={path} fillRule="evenodd" role="button" tabIndex={0} aria-label={`${d.title}: open the list`} onClick={() => onPick(d.key)} onKeyDown={key(() => onPick(d.key))}>
              <title>{`${d.title} · ${pct(d.value)}`}</title>
            </path>
          ))}
        </g>
        <g className="clk" onClick={() => top && onPick(top.key)} aria-hidden="true">
          <circle cx={cx} cy={cy} r={r - 2} className="piehole" />
          <text x={cx} y={cy + 4} textAnchor="middle" className="pietotal">
            {total}
          </text>
          <text x={cx} y={cy + 24} textAnchor="middle" className="ct">
            {unit}
          </text>
        </g>
      </svg>
      <ul className="pielegend" aria-label={`${label}, by type`} id={id}>
        {data.map((d, i) => (
          <li key={d.key}>
            <button type="button" onClick={() => onPick(d.key)} title={`${d.title}: open the list`}>
              <span className={`sw pc${(i % 8) + 1}`} aria-hidden="true" />
              <span className="pl">{d.label}</span>
              <span className="pv">
                {d.value} <span className="pp">{pct(d.value)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface LineSeries {
  key: string;
  label: string;
  /** Colour class: l1 (money lost), l2 (put on hold), l3 (FIRs). */
  cls: "l1" | "l2" | "l3";
  /** Which scale it is read against: the money on the left, a count on the right. */
  axis: "left" | "right";
  points: ChartDatum[];
}

/**
 * Several lines over the same periods: amounts against the left scale, counts against the right. Every point opens
 * its own list (that period, that measure). The period names thin out when there are many (days of a month).
 */
export function MultiLineChart({ series, periods, label, onPick, formatLeft }: { series: LineSeries[]; periods: string[]; label: string; onPick: (key: string) => void; formatLeft: (v: number) => string }) {
  const left = scale(Math.max(0, ...series.filter((s) => s.axis === "left").flatMap((s) => s.points.map((p) => p.value))));
  const right = scale(Math.max(0, ...series.filter((s) => s.axis === "right").flatMap((s) => s.points.map((p) => p.value))), 4);
  const n = periods.length;
  const step = n > 1 ? 400 / (n - 1) : 0;
  const x = (i: number) => r1(64 + step * i);
  const y = (v: number, axis: "left" | "right") => r1(180 - (v / (axis === "left" ? left.top : right.top)) * 160);
  const every = Math.max(1, Math.ceil(n / 8));
  const hasRight = series.some((s) => s.axis === "right");
  return (
    <svg viewBox="0 0 520 220" role="img" aria-label={`${label}: ${series.map((s) => `${s.label} ${s.points.map((p) => p.title).join(", ")}`).join("; ")}`}>
      <g className="cg">
        {left.ticks.slice(1).map((t) => (
          <line key={t} x1="56" x2="472" y1={y(t, "left")} y2={y(t, "left")} />
        ))}
      </g>
      <line className="ax" x1="56" x2="472" y1="180" y2="180" />
      <g className="ct" textAnchor="end">
        {left.ticks.map((t) => (
          <text key={t} x="50" y={y(t, "left") + 4}>
            {t === 0 ? "0" : formatLeft(t)}
          </text>
        ))}
      </g>
      {hasRight ? (
        <g className="ct" textAnchor="start">
          {right.ticks.map((t) => (
            <text key={t} x="478" y={y(t, "right") + 4}>
              {t}
            </text>
          ))}
        </g>
      ) : null}
      {series.map((s) => (
        <g key={s.key} className={`ml ${s.cls}`}>
          <path className="mlf" d={s.points.map((p, i) => `${i ? "L" : "M"}${x(i)} ${y(p.value, s.axis)}`).join(" ")} />
          {s.points.map((p, i) => (
            <g key={p.key}>
              <circle className="hit" cx={x(i)} cy={y(p.value, s.axis)} r="10" role="button" tabIndex={0} aria-label={`${s.label}, ${p.title}: open the list`} onClick={() => onPick(p.key)} onKeyDown={key(() => onPick(p.key))}>
                <title>{`${s.label} · ${p.title}`}</title>
              </circle>
              <circle className="mpt" cx={x(i)} cy={y(p.value, s.axis)} r="3.5" />
            </g>
          ))}
        </g>
      ))}
      <g className="ct" textAnchor="middle">
        {periods.map((p, i) =>
          i % every === 0 || i === n - 1 ? (
            <text key={`${p}:${i}`} x={x(i)} y="204">
              {p}
            </text>
          ) : null,
        )}
      </g>
    </svg>
  );
}
