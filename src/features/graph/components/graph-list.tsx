"use client";

import { PanelRightOpen } from "lucide-react";
import { DataTable, type Column } from "@/components/app/data-table";
import { StatusBadge } from "@/components/app/status-badge";
import { AmountDisplay } from "@/components/app/amount";
import { DateTime } from "@/components/app/datetime";
import { EvidenceLink } from "@/components/app/evidence-link";
import { IconButton } from "@/components/ui/button";
import type { GraphIdentityEdge, GraphMoneyEdge, GraphNode } from "@/contracts/graph";
import type { GraphModel, GraphView } from "../model";
import { howFound, kindLabel, relationText, type GraphSelection } from "../presentation";

type Select = (s: GraphSelection) => void;

function RecordButton({ node, onSelect }: { node: GraphNode | undefined; onSelect: Select }) {
  if (!node) return <span className="text-ink-3">Not shown</span>;
  return (
    <button type="button" onClick={() => onSelect({ kind: "node", id: node.id })} className="rounded-[var(--radius-chip)] text-left font-medium text-action hover:underline">
      {node.label}
    </button>
  );
}

function DetailsButton({ id, onSelect }: { id: string; onSelect: Select }) {
  return (
    <IconButton label="Open connection details" onClick={() => onSelect({ kind: "edge", id })}>
      <PanelRightOpen aria-hidden="true" />
    </IconButton>
  );
}

function FirstSource({ caseId, sources }: { caseId: string; sources: GraphMoneyEdge["sources"] }) {
  return sources[0] ? <EvidenceLink caseId={caseId} source={sources[0]} /> : <span className="text-label text-ink-3">No document source</span>;
}

type TransferRow = { edgeId: string; t: GraphMoneyEdge };
type RelationRow = { edgeId: string; r: GraphIdentityEdge };

export function GraphList({ view, model, caseId, onSelect }: { view: GraphView; model: GraphModel; caseId: string; onSelect: Select }) {
  const byId = new Map(model.nodes.map((x) => [x.node.id, x.node]));
  const focused = model.nodes.some((x) => !x.inBranch);
  const edges = model.edges.filter((e) => !focused || e.inBranch);

  if (view === "money") {
    const rows: TransferRow[] = edges
      .flatMap((e) => (e.type === "money" ? e.transfers.map((t) => ({ edgeId: e.id, t })) : []))
      .sort((a, b) => a.t.layer - b.t.layer || a.t.occurredAt.localeCompare(b.t.occurredAt));
    const columns: Column<TransferRow>[] = [
      { key: "from", header: "From", cell: (r) => <RecordButton node={byId.get(r.t.source)} onSelect={onSelect} /> },
      { key: "to", header: "To", cell: (r) => <RecordButton node={byId.get(r.t.target)} onSelect={onSelect} /> },
      { key: "amount", header: "Amount", align: "right", cell: (r) => <AmountDisplay minor={r.t.amountMinor} className="font-medium text-ink" /> },
      { key: "when", header: "Date and time", cell: (r) => <DateTime iso={r.t.occurredAt} /> },
      { key: "layer", header: "Layer", hideBelow: "lg", cell: (r) => <span className="tabular-nums">{r.t.layer}</span> },
      { key: "status", header: "Status", cell: (r) => <StatusBadge kind="transaction" value={r.t.status} /> },
      { key: "source", header: "Source", hideBelow: "lg", cell: (r) => <FirstSource caseId={caseId} sources={r.t.sources} /> },
      { key: "open", header: <span className="sr-only">Details</span>, cell: (r) => <DetailsButton id={r.edgeId} onSelect={onSelect} /> },
    ];
    return (
      <DataTable
        caption="Transfers in this view"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.t.id}
        minWidth={860}
        mobileCard={(r) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start justify-between gap-3">
              <p className="text-body text-ink">
                <RecordButton node={byId.get(r.t.source)} onSelect={onSelect} /> <span className="text-ink-3">to</span> <RecordButton node={byId.get(r.t.target)} onSelect={onSelect} />
              </p>
              <AmountDisplay minor={r.t.amountMinor} className="text-body font-semibold text-ink" />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-ink-2">
              <DateTime iso={r.t.occurredAt} />
              <span>Layer {r.t.layer}</span>
              <StatusBadge kind="transaction" value={r.t.status} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <FirstSource caseId={caseId} sources={r.t.sources} />
              <DetailsButton id={r.edgeId} onSelect={onSelect} />
            </div>
          </div>
        )}
      />
    );
  }

  if (view === "identity") {
    const rows: RelationRow[] = edges.flatMap((e) => (e.type === "identity" ? [{ edgeId: e.id, r: e.relation }] : []));
    const columns: Column<RelationRow>[] = [
      { key: "from", header: "Record", cell: (x) => <RecordButton node={byId.get(x.r.source)} onSelect={onSelect} /> },
      { key: "rel", header: "Relationship", cell: (x) => <span className="text-ink-2">{relationText(x.r)}</span> },
      { key: "to", header: "Related record", cell: (x) => <RecordButton node={byId.get(x.r.target)} onSelect={onSelect} /> },
      { key: "recorded", header: "Recorded", hideBelow: "lg", cell: (x) => <DateTime iso={x.r.discoveredAt} /> },
      { key: "source", header: "Source", hideBelow: "lg", cell: (x) => <FirstSource caseId={caseId} sources={x.r.sources} /> },
      { key: "open", header: <span className="sr-only">Details</span>, cell: (x) => <DetailsButton id={x.edgeId} onSelect={onSelect} /> },
    ];
    return (
      <DataTable
        caption="Identity relationships in this view"
        columns={columns}
        rows={rows}
        rowKey={(x) => x.r.id}
        minWidth={760}
        mobileCard={(x) => (
          <div className="flex flex-col gap-1.5">
            <p className="text-body text-ink">
              <RecordButton node={byId.get(x.r.source)} onSelect={onSelect} /> <span className="text-ink-2">{relationText(x.r).toLowerCase()}</span> <RecordButton node={byId.get(x.r.target)} onSelect={onSelect} />
            </p>
            <p className="text-label text-ink-2">
              Recorded <DateTime iso={x.r.discoveredAt} />
            </p>
            <div className="flex items-center justify-between gap-3">
              <FirstSource caseId={caseId} sources={x.r.sources} />
              <DetailsButton id={x.edgeId} onSelect={onSelect} />
            </div>
          </div>
        )}
      />
    );
  }

  const labelOf = (id: string) => byId.get(id)?.label;
  return (
    <div className="flex flex-col gap-4">
      {model.columns.map((c) => {
        const items = model.nodes.filter((x) => x.column === c.index && (!focused || x.inBranch)).sort((a, b) => a.row - b.row);
        if (!items.length) return null;
        return (
          <section key={c.index} aria-labelledby={`phase-${c.index}`} className="panel overflow-hidden">
            <header className="border-b border-line px-5 py-3">
              <h3 id={`phase-${c.index}`} className="text-section font-semibold tracking-tight text-ink">
                {c.title}
              </h3>
              {c.detail ? <p className="text-label text-ink-3">{c.detail}</p> : null}
            </header>
            <ul className="divide-y divide-line">
              {items.map(({ node }) => (
                <li key={node.id} className="flex flex-col gap-0.5 px-5 py-3 md:flex-row md:items-baseline md:gap-4">
                  <span className="min-w-0 md:w-64 md:shrink-0">
                    <RecordButton node={node} onSelect={onSelect} />
                    <span className="block text-label text-ink-3">
                      {kindLabel(node.kind)}
                      {node.value !== node.label ? `, ${node.value}` : ""}
                    </span>
                  </span>
                  <span className="text-label text-ink-2">{howFound(node, labelOf)}</span>
                  {node.isNew ? <span className="graph-chip border-action bg-action text-white md:ml-auto">New</span> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
