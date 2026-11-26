import { Banknote, Building2, Globe, Laptop, Mail, Phone, User, UserSquare2, Wallet, Wifi } from "lucide-react";
import { formatInr } from "@/domain/money";
import { formatDateIST, formatDateTimeIST } from "@/domain/time";
import { IDENTIFIER_KIND_LABELS } from "@/contracts/case";
import type { GraphIdentityEdge, GraphNode } from "@/contracts/graph";
import { RELATIONSHIP_LABELS } from "@/lib/labels";
import { discoveryLabel, type ModelEdge } from "./model";

/** What the details drawer is showing. Edge ids are prefixed by type (m:, i:, d:) so they never collide. */
export type GraphSelection = { kind: "node"; id: string } | { kind: "edge"; id: string };

export const KIND_ICONS: Record<string, typeof User> = {
  PERSON: User,
  ORGANISATION: Building2,
  BANK_ACCOUNT: Wallet,
  UPI_ID: Wallet,
  WALLET: Wallet,
  PHONE: Phone,
  EMAIL: Mail,
  PLATFORM_PROFILE: UserSquare2,
  WEBSITE: Globe,
  IP_ADDRESS: Wifi,
  DEVICE: Laptop,
  CASH: Banknote,
};

export function relationText(rel: GraphIdentityEdge): string {
  const base = RELATIONSHIP_LABELS[rel.type] ?? rel.type;
  return rel.status === "ASSERTED" ? base : `${base} (${rel.status.toLowerCase()})`;
}

function compactDateRange(a: Date, b: Date): string {
  const fa = formatDateIST(a);
  const fb = formatDateIST(b);
  if (fa === fb) return fa;
  const [da, ma, ya] = fa.split(" ");
  const [db, mb, yb] = fb.split(" ");
  if (ya === yb && ma === mb) return `${da}–${db} ${mb} ${yb}`;
  if (ya === yb) return `${da} ${ma} to ${db} ${mb} ${yb}`;
  return `${fa} to ${fb}`;
}

/**
 * The words on a connection, one entry per line. The same text appears on the diagram and is read
 * by screen readers, so the two never disagree.
 */
export function edgeLines(e: ModelEdge): string[] {
  if (e.type === "money") {
    const first = new Date(e.transfers[0]!.occurredAt);
    const n = e.transfers.length;
    if (n === 1) return [formatInr(e.totalMinor), formatDateTimeIST(first)];
    return [formatInr(e.totalMinor), `${n} transfers`, compactDateRange(first, new Date(e.transfers.at(-1)!.occurredAt))];
  }
  if (e.type === "identity") return [relationText(e.relation)];
  return [discoveryLabel(e.provenance)];
}

export function kindLabel(kind: string): string {
  return IDENTIFIER_KIND_LABELS[kind] ?? kind;
}

export function nodeDescription(n: GraphNode): string {
  return `${kindLabel(n.kind)}: ${n.label}${n.value !== n.label ? `, ${n.value}` : ""}`;
}

/** One line on how a record entered the case, naming the lead when a response revealed it. */
export function howFound(n: GraphNode, labelOf: (id: string) => string | undefined): string {
  const p = n.learnedFrom;
  if (!p) return "Entered by an officer";
  if (p.kind === "DOCUMENT") return `Extracted from ${p.evidenceTitle}`;
  const leads = p.leadEntityIds.map(labelOf).filter(Boolean);
  const via = `${p.organisation ?? "Provider"} response${p.requestReference ? ` to ${p.requestReference}` : ""}`;
  return leads.length ? `${discoveryLabel(p)} of ${leads.join(", ")}, from the ${via}` : `${discoveryLabel(p)}, from the ${via}`;
}

/** The short form shown on a discovery card; the column header already names the response or step. */
export function shortHowFound(n: GraphNode, labelOf: (id: string) => string | undefined): string {
  const p = n.learnedFrom;
  if (!p) return "Entered by an officer";
  if (p.kind === "DOCUMENT") return `From ${p.evidenceTitle}`;
  const leads = p.leadEntityIds.map(labelOf).filter(Boolean);
  return leads.length ? `${discoveryLabel(p)} of ${leads.join(", ")}` : discoveryLabel(p);
}
