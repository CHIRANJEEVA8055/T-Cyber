"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { AmountDisplay } from "@/components/app/amount";
import { DateTime } from "@/components/app/datetime";
import { EvidenceLink } from "@/components/app/evidence-link";
import { formatInr } from "@/domain/money";
import { PARTY_ROLE_TEXT, PAYMENT_CHANNEL_LABELS, RELATIONSHIP_STATUS_TEXT } from "@/lib/labels";
import type { GraphData, GraphMoneyEdge, GraphNode, GraphProvenance, GraphSource } from "@/contracts/graph";
import { discoveryLabel, type ModelEdge } from "../model";
import { relationText } from "../presentation";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-label font-semibold text-ink-2">{title}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

function Sources({ caseId, sources }: { caseId: string; sources: GraphSource[] }) {
  if (!sources.length) return <p className="text-body text-ink-2">No document source is linked to this record.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {sources.map((s, i) => (
        <li key={i}>
          <EvidenceLink caseId={caseId} source={s} showExcerpt />
        </li>
      ))}
    </ul>
  );
}

function Provenance({ p, caseId, labelOf }: { p: GraphProvenance | null; caseId: string; labelOf: (id: string) => string | undefined }) {
  if (!p) return <p className="text-body text-ink-2">Entered by an officer. No document or response is linked to how it was found.</p>;
  if (p.kind === "DOCUMENT")
    return (
      <p className="text-body text-ink">
        Extracted from{" "}
        <Link href={`/cases/${caseId}/evidence/${p.evidenceId}`} className="font-medium text-action hover:underline">
          {p.evidenceTitle}
        </Link>
        , applied <DateTime iso={p.appliedAt} />.
      </p>
    );
  const leads = p.leadEntityIds.map(labelOf).filter(Boolean);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body text-ink">
        <Link href={`/cases/${caseId}/responses/${p.responseId}`} className="font-medium text-action hover:underline">
          {p.organisation ?? "Provider"} response{p.requestReference ? ` to ${p.requestReference}` : ""}
        </Link>
        {leads.length ? `, requested about ${leads.join(", ")}` : ""}. Applied <DateTime iso={p.appliedAt} />.
      </p>
      <p className="rounded-[var(--radius-control)] bg-surface-sunken px-3 py-2 text-label text-ink-2">{p.findingSummary}</p>
    </div>
  );
}

function Terms({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7.5rem,auto)_1fr] gap-x-4 gap-y-1.5 text-body">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-ink-3">{term}</dt>
          <dd className="min-w-0 break-words text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function moneySummary(edges: GraphMoneyEdge[]): ReactNode {
  if (!edges.length) return null;
  const total = edges.reduce((s, t) => s + BigInt(t.amountMinor), 0n);
  const reported = edges.filter((t) => t.status !== "CONFIRMED_BY_BANK").reduce((s, t) => s + BigInt(t.amountMinor), 0n);
  return (
    <>
      <span className="font-medium tabular-nums">{formatInr(total)}</span> in {edges.length} transfer{edges.length === 1 ? "" : "s"}
      {reported > 0n ? <span className="block text-label text-ink-2">Includes {formatInr(reported)} reported by the victim and not yet confirmed by a bank.</span> : null}
    </>
  );
}

export function NodeDetails({ node, data, caseId }: { node: GraphNode; data: GraphData; caseId: string }) {
  const labelOf = (id: string) => data.nodes.find((n) => n.id === id)?.label;
  const incoming = data.moneyEdges.filter((t) => t.target === node.id);
  const outgoing = data.moneyEdges.filter((t) => t.source === node.id);
  const phase = data.phases.find((p) => p.phase === node.discoveryPhase);
  const money: [string, ReactNode][] = [];
  if (incoming.length) money.push(["Received", moneySummary(incoming)]);
  if (outgoing.length) money.push([node.isVictimAccount ? "Paid out" : "Sent onward", moneySummary(outgoing)]);
  if (node.hold)
    money.push([
      "Hold",
      node.hold.heldMinor ? (
        <>
          <AmountDisplay minor={node.hold.heldMinor} className="font-medium" /> confirmed held{node.hold.amountUnknown ? "; another hold has an unknown amount" : ""}
        </>
      ) : node.hold.amountUnknown ? (
        "Confirmed, amount unknown. Unknown is not treated as ₹0."
      ) : (
        "Requested, awaiting the bank’s confirmation"
      ),
    ]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-1.5">
        <StatusBadge kind="verification" value={node.verification} />
        {node.roles.map((r) => (
          <Tag key={r} tone="info">
            {PARTY_ROLE_TEXT[r] ?? r}
          </Tag>
        ))}
        {node.isNew ? <Tag tone="info">New since your review</Tag> : null}
      </div>
      <Terms
        items={[
          ["Why it is in the case", node.caseRole ?? "Recorded at intake"],
          ["First recorded", <><DateTime iso={node.discoveredAt} />{phase ? `, ${phase.title.toLowerCase()}` : ""}</>],
          ...(node.layer !== null && !node.isVictimAccount ? ([["Transfer depth", `Layer ${node.layer}`]] as [string, ReactNode][]) : []),
          ...(node.bank ? ([["Bank", node.bank]] as [string, ReactNode][]) : []),
        ]}
      />
      <Section title="How It Was Found">
        <Provenance p={node.learnedFrom} caseId={caseId} labelOf={labelOf} />
      </Section>
      {money.length ? (
        <Section title="Money">
          <Terms items={money} />
        </Section>
      ) : null}
      <Section title="Sources">
        <Sources caseId={caseId} sources={node.sources} />
      </Section>
      <Section title="Requests About This Record">
        {node.requests.length ? (
          <ul className="flex flex-col gap-1.5">
            {node.requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3">
                <Link className="text-body font-medium text-action hover:underline" href={`/cases/${caseId}/requests/${r.id}`}>
                  {r.reference}
                </Link>
                <StatusBadge kind="request" value={r.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-ink-2">No request has been prepared about this record.</p>
        )}
      </Section>
      <Section title="Open Next Actions">
        {node.openActions.length ? (
          <ul className="flex flex-col gap-1.5">
            {node.openActions.map((t) => (
              <li key={t.id}>
                <Link className="text-body text-action hover:underline" href={`/cases/${caseId}/actions?task=${t.id}`}>
                  {t.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-ink-2">No open next actions about this record.</p>
        )}
      </Section>
    </div>
  );
}

export function edgeHeading(e: ModelEdge, labelOf: (id: string) => string): { title: string; subtitle: string } {
  if (e.type === "money") {
    const n = e.transfers.length;
    return { title: n === 1 ? `Transfer to ${labelOf(e.target)}` : `${n} transfers to ${labelOf(e.target)}`, subtitle: `From ${labelOf(e.source)}, ${formatInr(e.totalMinor)} in total` };
  }
  if (e.type === "identity") return { title: `${labelOf(e.source)}: ${relationText(e.relation).toLowerCase()} ${labelOf(e.target)}`, subtitle: "Identity relationship" };
  return { title: `How ${labelOf(e.target)} was found`, subtitle: discoveryLabel(e.provenance) };
}

export function EdgeDetails({ edge, data, caseId }: { edge: ModelEdge; data: GraphData; caseId: string }) {
  const labelOf = (id: string) => data.nodes.find((n) => n.id === id)?.label;
  if (edge.type === "money")
    return (
      <ul className="flex flex-col gap-3">
        {edge.transfers.map((t) => (
          <li key={t.id} className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-line p-4">
            <div className="flex items-start justify-between gap-3">
              <AmountDisplay minor={t.amountMinor} className="text-section font-semibold text-ink" />
              <StatusBadge kind="transaction" value={t.status} />
            </div>
            <Terms
              items={[
                ["Date and time", <DateTime key="d" iso={t.occurredAt} />],
                ["Channel", PAYMENT_CHANNEL_LABELS[t.channel] ?? t.channel],
                ["Reference", t.reference ? <span className="font-mono text-label">{t.reference}</span> : <span className="text-ink-3">Not recorded</span>],
                ["Transfer depth", `Layer ${t.layer}`],
                ["Recorded in case", <DateTime key="r" iso={t.discoveredAt} />],
              ]}
            />
            <Section title="How It Was Found">
              <Provenance p={t.learnedFrom} caseId={caseId} labelOf={labelOf} />
            </Section>
            <Section title="Sources">
              <Sources caseId={caseId} sources={t.sources} />
            </Section>
          </li>
        ))}
      </ul>
    );
  if (edge.type === "identity") {
    const r = edge.relation;
    return (
      <div className="flex flex-col gap-5">
        <Section title="Exact Statement Recorded">
          <blockquote className="border-l-2 border-line-strong pl-3 text-body text-ink">{r.statement}</blockquote>
        </Section>
        <Terms
          items={[
            ["Status", RELATIONSHIP_STATUS_TEXT[r.status] ?? r.status],
            ["Recorded in case", <DateTime key="r" iso={r.discoveredAt} />],
          ]}
        />
        <Section title="How It Was Found">
          <Provenance p={r.learnedFrom} caseId={caseId} labelOf={labelOf} />
        </Section>
        <Section title="Sources">
          <Sources caseId={caseId} sources={r.sources} />
        </Section>
      </div>
    );
  }
  const p = edge.provenance;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-body text-ink">
        {labelOf(edge.target)} was found in the {p.organisation ?? "provider"} response{p.requestReference ? ` to ${p.requestReference}` : ""}, which was requested about {labelOf(edge.source)}.
      </p>
      <Section title="What the Response Said">
        <p className="rounded-[var(--radius-control)] bg-surface-sunken px-3 py-2 text-body text-ink-2">{p.findingSummary}</p>
      </Section>
      <Terms items={[["Applied to the case", <DateTime key="a" iso={p.appliedAt} />]]} />
      <Link href={`/cases/${caseId}/responses/${p.responseId}`} className="text-body font-medium text-action hover:underline">
        Open the response review
      </Link>
    </div>
  );
}
