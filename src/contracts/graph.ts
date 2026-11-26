/**
 * Read model for the case graph. The graph is a view over canonical records and stores nothing itself.
 * Money is a decimal string of paise (never a float). Timestamps are ISO-8601 strings in UTC.
 */

export interface GraphSource {
  evidenceId: string;
  evidenceTitle: string;
  locator: string;
  excerpt: string | null;
  stance: string;
}

/** Where a record was learned from. Intake records have no provenance (`null`). */
export type GraphProvenance =
  | {
      kind: "RESPONSE";
      responseId: string;
      requestId: string | null;
      requestReference: string | null;
      organisation: string | null;
      appliedAt: string;
      findingType: string;
      findingSummary: string;
      /** The records the request was about: the leads that produced this record. */
      leadEntityIds: string[];
    }
  | { kind: "DOCUMENT"; evidenceId: string; evidenceTitle: string; appliedAt: string };

export interface GraphHoldSummary {
  /** Sum of confirmed held amounts that are known; null when none is known. */
  heldMinor: string | null;
  /** A hold or restriction is confirmed but at least one amount is unknown (unknown is not zero). */
  amountUnknown: boolean;
  /** A hold has been requested and not yet confirmed. */
  requested: boolean;
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  value: string;
  bank: string | null;
  caseRole: string | null;
  roles: string[];
  verification: string;
  discoveryPhase: number;
  discoveredAt: string;
  /** Transfer depth: 0 for the victim's own accounts, 1 for first recipients, and so on. */
  layer: number | null;
  isVictimAccount: boolean;
  /** The victim's own (their accounts, numbers, email, themselves): kept out of the investigation views by default. */
  victimSide: boolean;
  isNew: boolean;
  hold: GraphHoldSummary | null;
  learnedFrom: GraphProvenance | null;
  sources: GraphSource[];
  openActions: { id: string; title: string; status: string }[];
  requests: { id: string; reference: string; status: string }[];
}

export interface GraphMoneyEdge {
  id: string;
  source: string;
  target: string;
  amountMinor: string;
  occurredAt: string;
  channel: string;
  reference: string | null;
  layer: number;
  kind: string;
  status: string;
  discoveredAt: string;
  discoveryPhase: number;
  isNew: boolean;
  learnedFrom: GraphProvenance | null;
  sources: GraphSource[];
}

export interface GraphIdentityEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  statement: string;
  status: string;
  discoveredAt: string;
  discoveryPhase: number;
  isNew: boolean;
  learnedFrom: GraphProvenance | null;
  sources: GraphSource[];
}

export interface GraphLocation {
  id: string;
  entityId: string | null;
  description: string;
  eventAt: string | null;
  /** How the event time should be read, e.g. "Time as recorded by the bank". */
  eventAtNote: string | null;
  /** The event time is a calendar date only; show it without a time of day. */
  eventDateOnly: boolean;
  receivedAt: string;
}

export interface GraphPhase {
  phase: number;
  title: string;
  detail: string;
}

export interface GraphData {
  reviewedAt: string | null;
  phases: GraphPhase[];
  nodes: GraphNode[];
  moneyEdges: GraphMoneyEdge[];
  identityEdges: GraphIdentityEdge[];
  locations: GraphLocation[];
}
