import type { GraphData, GraphIdentityEdge, GraphMoneyEdge, GraphNode, GraphProvenance } from "@/contracts/graph";

/**
 * Pure view model for the case graph, shared by the diagram and the list presentation.
 * It decides what is shown (view, filters, "new since review"), how repeated transfers are combined,
 * which records belong to a focused branch, and where each record sits (column and row).
 */

export type GraphView = "money" | "identity" | "discovery";
export type ResponseProvenance = Extract<GraphProvenance, { kind: "RESPONSE" }>;

export const KIND_GROUPS: { key: string; label: string; kinds: string[] }[] = [
  { key: "accounts", label: "Accounts", kinds: ["BANK_ACCOUNT", "UPI_ID", "WALLET"] },
  { key: "cash", label: "Cash", kinds: ["CASH"] },
  { key: "people", label: "People", kinds: ["PERSON", "ORGANISATION"] },
  { key: "phones", label: "Phone numbers", kinds: ["PHONE"] },
  { key: "online", label: "Emails, profiles, websites", kinds: ["EMAIL", "PLATFORM_PROFILE", "WEBSITE"] },
  { key: "technical", label: "IP addresses, devices", kinds: ["IP_ADDRESS", "DEVICE"] },
];
const groupIndex = (kind: string) => {
  const i = KIND_GROUPS.findIndex((g) => g.kinds.includes(kind));
  return i === -1 ? KIND_GROUPS.length : i;
};

export interface ModelOptions {
  view: GraphView;
  /** Show the victim's own records (false: the accused's side only; the victim's paying accounts stay as the source of the money). */
  showVictim?: boolean;
  hiddenKinds?: ReadonlySet<string>;
  onlyNew?: boolean;
  focus?: string | null;
}
export interface ModelColumn {
  index: number;
  title: string;
  detail: string;
}
export interface ModelNode {
  node: GraphNode;
  column: number;
  row: number;
  inBranch: boolean;
}
interface EdgeBase {
  id: string;
  source: string;
  target: string;
  isNew: boolean;
  inBranch: boolean;
}
export type ModelEdge =
  | (EdgeBase & { type: "money"; transfers: GraphMoneyEdge[]; totalMinor: bigint; allConfirmed: boolean })
  | (EdgeBase & { type: "identity"; relation: GraphIdentityEdge })
  | (EdgeBase & { type: "discovery"; provenance: ResponseProvenance });
export interface GraphModel {
  columns: ModelColumn[];
  nodes: ModelNode[];
  edges: ModelEdge[];
  /** Highest row index used, for sizing the canvas. */
  maxRow: number;
}

export function discoveryLabel(p: ResponseProvenance): string {
  switch (p.findingType) {
    case "TRANSACTION":
      return "Transfer recipient";
    case "KYC_RECORD":
    case "SUBSCRIBER_RECORD":
      return "Holder on record";
    case "RELATIONSHIP":
      return "Linked identifier";
    default:
      return "Named in response";
  }
}

export const moneyEdgeId = (source: string, target: string) => `m:${source}>${target}`;
export const discoveryEdgeId = (source: string, target: string) => `d:${source}>${target}`;
export const identityEdgeId = (relationshipId: string) => `i:${relationshipId}`;

function moneyColumnTitle(col: number): ModelColumn {
  if (col === 0) return { index: 0, title: "Victim accounts", detail: "Where the money came from" };
  if (col === 1) return { index: 1, title: "Layer 1", detail: "Paid by the victim" };
  return { index: col, title: `Layer ${col}`, detail: "Onward transfers" };
}
const IDENTITY_COLUMNS: ModelColumn[] = [
  { index: 0, title: "Identifiers", detail: "Phones, emails, profiles, IP addresses" },
  { index: 1, title: "Accounts", detail: "Bank accounts, UPI IDs, wallets" },
  { index: 2, title: "People and organisations", detail: "As named in records" },
];
const identityColumn = (kind: string) => (["PERSON", "ORGANISATION"].includes(kind) ? 2 : ["BANK_ACCOUNT", "UPI_ID", "WALLET", "CASH"].includes(kind) ? 1 : 0);

export function buildGraphModel(data: GraphData, opts: ModelOptions): GraphModel {
  const hidden = opts.hiddenKinds ?? new Set<string>();
  const keepVictim = (n: GraphData["nodes"][number]) => opts.showVictim !== false || !n.victimSide || (opts.view === "money" && n.isVictimAccount);
  const byId = new Map(data.nodes.filter((n) => !hidden.has(n.kind) && keepVictim(n)).map((n) => [n.id, n]));
  const visible = (id: string) => byId.has(id);

  // 1. Candidate edges for the view, between visible records only.
  let edges: ModelEdge[] = [];
  if (opts.view === "money") {
    const pairs = new Map<string, GraphMoneyEdge[]>();
    for (const t of data.moneyEdges) {
      if (!visible(t.source) || !visible(t.target)) continue;
      const key = moneyEdgeId(t.source, t.target);
      pairs.set(key, [...(pairs.get(key) ?? []), t]);
    }
    for (const [id, transfers] of pairs) {
      transfers.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      const first = transfers[0]!;
      edges.push({
        type: "money",
        id,
        source: first.source,
        target: first.target,
        transfers,
        totalMinor: transfers.reduce((s, t) => s + BigInt(t.amountMinor), 0n),
        allConfirmed: transfers.every((t) => t.status === "CONFIRMED_BY_BANK"),
        isNew: transfers.some((t) => t.isNew),
        inBranch: true,
      });
    }
  } else if (opts.view === "identity") {
    for (const rel of data.identityEdges) {
      if (!visible(rel.source) || !visible(rel.target)) continue;
      edges.push({ type: "identity", id: identityEdgeId(rel.id), source: rel.source, target: rel.target, relation: rel, isNew: rel.isNew, inBranch: true });
    }
  } else {
    for (const n of byId.values()) {
      if (n.learnedFrom?.kind !== "RESPONSE") continue;
      for (const lead of n.learnedFrom.leadEntityIds) {
        if (lead === n.id || !visible(lead)) continue;
        edges.push({ type: "discovery", id: discoveryEdgeId(lead, n.id), source: lead, target: n.id, provenance: n.learnedFrom, isNew: n.isNew, inBranch: true });
      }
    }
  }

  // 2. Records shown in the view.
  let nodeIds: Set<string>;
  if (opts.view === "discovery") nodeIds = new Set(byId.keys());
  else nodeIds = new Set(edges.flatMap((e) => [e.source, e.target]));
  if (opts.onlyNew) {
    edges = edges.filter((e) => e.isNew || byId.get(e.source)!.isNew || byId.get(e.target)!.isNew);
    const touched = new Set(edges.flatMap((e) => [e.source, e.target]));
    nodeIds = new Set([...nodeIds].filter((id) => byId.get(id)!.isNew || touched.has(id)));
  }

  // 3. Branch focus: everything upstream and downstream of the focused record.
  let branch: Set<string> | null = null;
  if (opts.focus && nodeIds.has(opts.focus)) {
    branch = new Set([opts.focus]);
    for (const dir of ["down", "up"] as const) {
      const queue = [opts.focus];
      const seen = new Set(queue);
      while (queue.length) {
        const cur = queue.shift()!;
        for (const e of edges) {
          const next = dir === "down" ? (e.source === cur ? e.target : null) : e.target === cur ? e.source : null;
          if (next && !seen.has(next)) {
            seen.add(next);
            branch.add(next);
            queue.push(next);
          }
        }
      }
    }
    for (const e of edges) e.inBranch = branch.has(e.source) && branch.has(e.target);
  }

  // 4. Columns.
  const columnOf = (n: GraphNode) => {
    if (opts.view === "money") return n.isVictimAccount ? 0 : Math.max(1, n.layer ?? 1);
    if (opts.view === "identity") return identityColumn(n.kind);
    return n.discoveryPhase;
  };
  const nodes: ModelNode[] = [...nodeIds].map((id) => {
    const node = byId.get(id)!;
    return { node, column: columnOf(node), row: 0, inBranch: !branch || branch.has(id) };
  });
  const present = [...new Set(nodes.map((x) => x.column))].sort((a, b) => a - b);
  const columns: ModelColumn[] =
    opts.view === "money"
      ? present.map(moneyColumnTitle)
      : opts.view === "identity"
        ? present.map((c) => IDENTITY_COLUMNS[c]!)
        : present.map((c) => {
            const p = data.phases.find((x) => x.phase === c);
            return { index: c, title: p?.title ?? `Phase ${c}`, detail: p?.detail ?? "" };
          });

  // 5. Rows: place columns in order; each record lines up with the records it is connected to.
  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    neighbours.set(e.source, [...(neighbours.get(e.source) ?? []), e.target]);
    neighbours.set(e.target, [...(neighbours.get(e.target) ?? []), e.source]);
  }
  const order = opts.view === "identity" ? [1, 2, 0].filter((c) => present.includes(c)) : present;
  const rowOf = new Map<string, number>();
  const sortKey = (n: GraphNode) => `${String(groupIndex(n.kind)).padStart(2, "0")}|${n.isVictimAccount ? 0 : 1}|${n.label}`;
  for (const col of order) {
    const inCol = nodes.filter((x) => x.column === col);
    const desired = new Map(
      inCol.map((x) => {
        const placed = (neighbours.get(x.node.id) ?? []).filter((id) => rowOf.has(id)).map((id) => rowOf.get(id)!);
        return [x.node.id, placed.length ? placed.reduce((a, b) => a + b, 0) / placed.length : Number.POSITIVE_INFINITY];
      }),
    );
    inCol.sort((a, b) => desired.get(a.node.id)! - desired.get(b.node.id)! || sortKey(a.node).localeCompare(sortKey(b.node)));
    let last = Number.NEGATIVE_INFINITY;
    for (const x of inCol) {
      const d = desired.get(x.node.id)!;
      const row = Number.isFinite(d) ? Math.max(d, last + 1) : Math.max(0, last + 1);
      x.row = row;
      rowOf.set(x.node.id, row);
      last = row;
    }
  }

  return { columns, nodes, edges, maxRow: Math.max(0, ...nodes.map((x) => x.row)) };
}
