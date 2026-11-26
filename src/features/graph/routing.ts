import type { GraphModel } from "./model";

/** Diagram geometry, in diagram units (pixels at 100% zoom). */
export const CARD_W = 240;
export const CARD_H = 96;
export const COL_STEP = 420;
export const ROW_STEP = 120;
/** Distance from a card edge to a trunk or lane turn. */
export const TRUNK_GAP = 22;
/** Space kept between a line and any card it passes. */
const CLEARANCE = 6;

/**
 * How a connection is drawn.
 * - trunk-source: a fan-out shares a vertical trunk just after the source; each branch carries its label on
 *   its own target's row.
 * - trunk-target: the mirror image for fan-in.
 * - lane: a connection that skips a column travels in the clear band between card rows, never through a card.
 * - curve: a plain curve from the source, used when a trunk would run past other records and so seem to
 *   start from (or end at) a record it has nothing to do with.
 */
export type Route = { kind: "trunk-source" } | { kind: "trunk-target" } | { kind: "curve" } | { kind: "lane"; y: number };

export function planRoutes(model: GraphModel): Map<string, Route> {
  const placed = new Map(model.nodes.map((x) => [x.node.id, x]));
  const byColumn = new Map<number, { id: string; row: number }[]>();
  for (const x of model.nodes) byColumn.set(x.column, [...(byColumn.get(x.column) ?? []), { id: x.node.id, row: x.row }]);
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const e of model.edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);
  }

  const passesOthers = (column: number, self: string, fromRow: number, toRow: number) =>
    (byColumn.get(column) ?? []).some((o) => o.id !== self && o.row > Math.min(fromRow, toRow) - 0.45 && o.row < Math.max(fromRow, toRow) + 0.45);

  const laneFor = (fromColumn: number, toColumn: number, targetRow: number): number | null => {
    const spans: [number, number][] = [];
    for (let c = fromColumn + 1; c < toColumn; c++) for (const o of byColumn.get(c) ?? []) spans.push([o.row * ROW_STEP - CLEARANCE, o.row * ROW_STEP + CARD_H + CLEARANCE]);
    const free = (y: number) => spans.every(([top, bottom]) => y < top || y > bottom);
    const base = Math.round(targetRow);
    for (let d = 0; d <= 8; d++) {
      for (const k of d === 0 ? [base] : [base - d, base + d]) {
        const y = k * ROW_STEP - (ROW_STEP - CARD_H) / 2;
        if (free(y)) return y;
      }
    }
    return null;
  };

  const routes = new Map<string, Route>();
  for (const e of model.edges) {
    const s = placed.get(e.source)!;
    const t = placed.get(e.target)!;
    let route: Route = { kind: "curve" };
    if (t.column >= s.column + 2) {
      const y = laneFor(s.column, t.column, t.row);
      if (y !== null) route = { kind: "lane", y };
    } else if (t.column === s.column + 1) {
      if ((inDegree.get(e.target) ?? 0) <= 1) route = passesOthers(s.column, s.node.id, s.row, t.row) ? { kind: "curve" } : { kind: "trunk-source" };
      else if ((outDegree.get(e.source) ?? 0) <= 1) route = passesOthers(t.column, t.node.id, t.row, s.row) ? { kind: "curve" } : { kind: "trunk-target" };
    }
    routes.set(e.id, route);
  }
  return routes;
}

/** An orthogonal polyline as an SVG path with rounded corners; repeated and in-line points are dropped. */
export function roundedPath(raw: [number, number][], radius = 8): string {
  const pts: [number, number][] = [];
  for (const p of raw) {
    const last = pts.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  const simple = pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const a = pts[i - 1]!;
    const b = pts[i + 1]!;
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
  });
  let d = `M ${simple[0]![0]} ${simple[0]![1]}`;
  for (let i = 1; i < simple.length - 1; i++) {
    const [x0, y0] = simple[i - 1]!;
    const [x1, y1] = simple[i]!;
    const [x2, y2] = simple[i + 1]!;
    const r = Math.min(radius, Math.hypot(x1 - x0, y1 - y0) / 2, Math.hypot(x2 - x1, y2 - y1) / 2);
    const ax = x1 - Math.sign(x1 - x0) * r;
    const ay = y1 - Math.sign(y1 - y0) * r;
    const bx = x1 + Math.sign(x2 - x1) * r;
    const by = y1 + Math.sign(y2 - y1) * r;
    d += ` L ${ax} ${ay} Q ${x1} ${y1} ${bx} ${by}`;
  }
  const last = simple.at(-1)!;
  return `${d} L ${last[0]} ${last[1]}`;
}
