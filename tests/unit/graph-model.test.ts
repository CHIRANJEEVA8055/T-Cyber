import { describe, expect, it } from "vitest";
import { buildGraphModel, discoveryLabel, type ResponseProvenance } from "@/features/graph/model";
import { shortHowFound } from "@/features/graph/presentation";
import type { GraphData, GraphIdentityEdge, GraphMoneyEdge, GraphNode } from "@/contracts/graph";

const T0 = "2026-10-03T06:00:00.000Z";
const resp = (leads: string[], findingType: string, organisation = "Demo Bank A"): ResponseProvenance => ({
  kind: "RESPONSE",
  responseId: `resp-${organisation}`,
  requestId: "req",
  requestReference: "REQ-2026-0002",
  organisation,
  appliedAt: T0,
  findingType,
  findingSummary: "summary",
  leadEntityIds: leads,
});
const n = (id: string, kind: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind,
  label: id,
  value: id,
  bank: null,
  caseRole: null,
  roles: [],
  verification: "UNVERIFIED",
  discoveryPhase: 0,
  discoveredAt: T0,
  layer: null,
  isVictimAccount: false,
  victimSide: false,
  isNew: false,
  hold: null,
  learnedFrom: null,
  sources: [],
  openActions: [],
  requests: [],
  ...extra,
});
const m = (id: string, source: string, target: string, rupees: number, extra: Partial<GraphMoneyEdge> = {}): GraphMoneyEdge => ({
  id,
  source,
  target,
  amountMinor: String(rupees * 100),
  occurredAt: T0,
  channel: "IMPS",
  reference: null,
  layer: 1,
  kind: "VICTIM_PAYMENT",
  status: "CONFIRMED_BY_BANK",
  discoveredAt: T0,
  discoveryPhase: 0,
  isNew: false,
  learnedFrom: null,
  sources: [],
  ...extra,
});
const r = (id: string, source: string, target: string, type: string): GraphIdentityEdge => ({ id, source, target, type, statement: `${source} ${type} ${target}`, status: "ASSERTED", discoveredAt: T0, discoveryPhase: 1, isNew: false, learnedFrom: null, sources: [] });

const data: GraphData = {
  reviewedAt: T0,
  phases: [
    { phase: 0, title: "Intake", detail: "FIR and complainant documents" },
    { phase: 1, title: "Phase 1", detail: "Demo Bank A response to REQ-2026-0002" },
    { phase: 2, title: "Phase 2", detail: "Demo Bank B response to REQ-2026-0003" },
  ],
  nodes: [
    n("V", "BANK_ACCOUNT", { layer: 0, isVictimAccount: true, victimSide: true }),
    n("A", "BANK_ACCOUNT", { layer: 1 }),
    n("B", "BANK_ACCOUNT", { layer: 1 }),
    n("D", "BANK_ACCOUNT", { layer: 2, discoveryPhase: 1, learnedFrom: resp(["A"], "TRANSACTION") }),
    n("E", "BANK_ACCOUNT", { layer: 2, discoveryPhase: 2, isNew: true, learnedFrom: resp(["B"], "TRANSACTION", "Demo Bank B") }),
    n("H", "PERSON", { discoveryPhase: 1, learnedFrom: resp(["A"], "KYC_RECORD") }),
    n("P", "PHONE", { discoveryPhase: 1, learnedFrom: resp(["A"], "RELATIONSHIP") }),
    n("I", "IP_ADDRESS", { discoveryPhase: 1 }),
  ],
  moneyEdges: [
    m("t1", "V", "A", 1000000),
    m("t2", "V", "B", 600000, { status: "REPORTED_BY_VICTIM" }),
    m("t3", "V", "B", 100000, { status: "REPORTED_BY_VICTIM", occurredAt: "2026-10-04T06:00:00.000Z" }),
    m("t4", "A", "D", 800000, { layer: 2, kind: "ONWARD_TRANSFER" }),
    m("t5", "B", "E", 400000, { layer: 2, kind: "ONWARD_TRANSFER", isNew: true }),
  ],
  identityEdges: [r("r1", "P", "A", "LINKED_IDENTIFIER"), r("r2", "A", "H", "REGISTERED_TO"), r("r3", "I", "A", "LINKED_IDENTIFIER")],
  locations: [],
};

const ids = (xs: { node: GraphNode }[]) => xs.map((x) => x.node.id).sort();
const at = (model: ReturnType<typeof buildGraphModel>, id: string) => model.nodes.find((x) => x.node.id === id)!;

describe("graph model: the accused's side", () => {
  it("leaves the victim's own records out unless asked, keeping their paying account as where the money came from", () => {
    const withPhone: GraphData = { ...data, nodes: [...data.nodes, n("VP", "PHONE", { victimSide: true })], identityEdges: data.identityEdges };
    expect(ids(buildGraphModel(withPhone, { view: "money", showVictim: false }).nodes)).toContain("V");
    expect(buildGraphModel(withPhone, { view: "identity", showVictim: false }).nodes.some((x) => x.node.id === "VP")).toBe(false);
    expect(buildGraphModel(withPhone, { view: "discovery", showVictim: false }).nodes.some((x) => x.node.id === "V")).toBe(false);
  });
});

describe("graph model: money flow", () => {
  it("shows only accounts that moved money, in columns by transfer depth", () => {
    const model = buildGraphModel(data, { view: "money" });
    expect(ids(model.nodes)).toEqual(["A", "B", "D", "E", "V"]);
    expect(model.columns.map((c) => c.title)).toEqual(["Victim accounts", "Layer 1", "Layer 2"]);
    expect([at(model, "V").column, at(model, "A").column, at(model, "B").column, at(model, "D").column]).toEqual([0, 1, 1, 2]);
  });

  it("combines repeated transfers between the same two accounts into one connection with the exact total", () => {
    const model = buildGraphModel(data, { view: "money" });
    const vb = model.edges.filter((e) => e.source === "V" && e.target === "B");
    expect(vb).toHaveLength(1);
    expect(vb[0]).toMatchObject({ type: "money", totalMinor: 70000000n, allConfirmed: false });
    expect(vb[0]!.type === "money" && vb[0]!.transfers.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(model.edges.find((e) => e.source === "V" && e.target === "A")).toMatchObject({ allConfirmed: true, totalMinor: 100000000n });
  });

  it("lines each onward account up with the account that paid it, without overlapping rows", () => {
    // "Zeta" sorts after E alphabetically, so only alignment with its payer (A) puts D on A's row.
    const model = buildGraphModel({ ...data, nodes: data.nodes.map((x) => (x.id === "D" ? { ...x, label: "Zeta" } : x)) }, { view: "money" });
    expect(at(model, "D").row).toBe(at(model, "A").row);
    expect(at(model, "E").row).toBe(at(model, "B").row);
    for (const col of [0, 1, 2]) {
      const rows = model.nodes.filter((x) => x.column === col).map((x) => x.row).sort((a, b) => a - b);
      rows.slice(1).forEach((row, i) => expect(row - rows[i]!).toBeGreaterThanOrEqual(1));
    }
  });

  it("focuses a branch on where the money came from and where it went", () => {
    const model = buildGraphModel(data, { view: "money", focus: "A" });
    expect(model.nodes.filter((x) => x.inBranch).map((x) => x.node.id).sort()).toEqual(["A", "D", "V"]);
    expect(model.edges.filter((e) => e.inBranch).map((e) => `${e.source}>${e.target}`).sort()).toEqual(["A>D", "V>A"]);
  });

  it("can show only what is new since the officer's last review", () => {
    const model = buildGraphModel(data, { view: "money", onlyNew: true });
    expect(model.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["B>E"]);
    expect(ids(model.nodes)).toEqual(["B", "E"]);
  });
});

describe("graph model: identity", () => {
  it("places identifiers, accounts and people in separate columns", () => {
    const model = buildGraphModel(data, { view: "identity" });
    expect(ids(model.nodes)).toEqual(["A", "H", "I", "P"]);
    expect(model.columns.map((c) => c.title)).toEqual(["Identifiers", "Accounts", "People and organisations"]);
    expect([at(model, "P").column, at(model, "A").column, at(model, "H").column]).toEqual([0, 1, 2]);
  });

  it("hides a kind of record together with its connections", () => {
    const model = buildGraphModel(data, { view: "identity", hiddenKinds: new Set(["PHONE"]) });
    expect(ids(model.nodes)).toEqual(["A", "H", "I"]);
    expect(model.edges.some((e) => e.source === "P" || e.target === "P")).toBe(false);
  });
});

describe("graph model: discovery", () => {
  it("draws one connection from each lead to what its response revealed, and nothing else", () => {
    const model = buildGraphModel(data, { view: "discovery" });
    expect(model.edges.map((e) => `${e.type}:${e.source}>${e.target}`).sort()).toEqual(["discovery:A>D", "discovery:A>H", "discovery:A>P", "discovery:B>E"]);
    expect(ids(model.nodes)).toEqual(["A", "B", "D", "E", "H", "I", "P", "V"]);
    expect(model.columns.map((c) => [c.title, c.detail])).toEqual([
      ["Intake", "FIR and complainant documents"],
      ["Phase 1", "Demo Bank A response to REQ-2026-0002"],
      ["Phase 2", "Demo Bank B response to REQ-2026-0003"],
    ]);
    expect(at(model, "I").column).toBe(1);
  });

  it("names how each record was found", () => {
    expect(discoveryLabel(resp([], "TRANSACTION"))).toBe("Transfer recipient");
    expect(discoveryLabel(resp([], "KYC_RECORD"))).toBe("Holder on record");
    expect(discoveryLabel(resp([], "RELATIONSHIP"))).toBe("Linked identifier");
    expect(discoveryLabel(resp([], "ENTITY"))).toBe("Named in response");
  });
});

describe("graph presentation", () => {
  it("says on each discovery card how the record was found", () => {
    const labelOf = (id: string) => (id === "A" ? "Account A" : undefined);
    expect(shortHowFound(n("D", "BANK_ACCOUNT", { learnedFrom: resp(["A"], "TRANSACTION") }), labelOf)).toBe("Transfer recipient of Account A");
    expect(shortHowFound(n("X", "BANK_ACCOUNT", { learnedFrom: { kind: "DOCUMENT", evidenceId: "e1", evidenceTitle: "FIR copy", appliedAt: T0 } }), labelOf)).toBe("From FIR copy");
    expect(shortHowFound(n("Y", "PHONE"), labelOf)).toBe("Entered by an officer");
  });
});
