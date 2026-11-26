"use client";

import { useState } from "react";
import { PanelRightOpen } from "lucide-react";
import { DateTime } from "@/components/app/datetime";
import { EvidenceLink } from "@/components/app/evidence-link";
import { IconButton } from "@/components/ui/button";
import { formatInr } from "@/domain/money";
import { RELATIONSHIP_LABELS } from "@/lib/labels";
import type { GraphData, GraphSource } from "@/contracts/graph";
import { cn } from "@/lib/cn";
import { identityEdgeId, moneyEdgeId } from "../model";
import type { GraphSelection } from "../presentation";

interface Item {
  id: string;
  kind: string;
  text: string;
  eventAt: string | null;
  eventDateOnly?: boolean;
  eventNote?: string | null;
  recordedAt: string;
  isNew: boolean;
  sources: GraphSource[];
  open: GraphSelection | null;
}

/** When something happened is kept separate from when the case learned of it. */
export function GraphTimeline({ data, caseId, onSelect }: { data: GraphData; caseId: string; onSelect: (s: GraphSelection) => void }) {
  const [order, setOrder] = useState<"event" | "recorded">("event");
  const label = (id: string) => data.nodes.find((n) => n.id === id)?.label ?? "an unnamed record";
  const reviewedAt = data.reviewedAt;
  const items: Item[] = [
    ...data.moneyEdges.map((t) => ({
      id: t.id,
      kind: t.kind === "CASH_WITHDRAWAL" ? "Cash withdrawal" : "Transfer",
      text: `${formatInr(BigInt(t.amountMinor))} from ${label(t.source)} to ${label(t.target)}`,
      eventAt: t.occurredAt,
      recordedAt: t.discoveredAt,
      isNew: t.isNew,
      sources: t.sources,
      open: { kind: "edge", id: moneyEdgeId(t.source, t.target) } as const,
    })),
    ...data.identityEdges.map((r) => ({
      id: r.id,
      kind: RELATIONSHIP_LABELS[r.type] ?? r.type,
      text: r.statement,
      eventAt: null,
      recordedAt: r.discoveredAt,
      isNew: r.isNew,
      sources: r.sources,
      open: { kind: "edge", id: identityEdgeId(r.id) } as const,
    })),
    ...data.locations.map((l) => ({
      id: l.id,
      kind: "Location observation",
      text: `${l.description}${l.entityId ? ` (${label(l.entityId)})` : ""}`,
      eventAt: l.eventAt,
      eventDateOnly: l.eventDateOnly,
      eventNote: l.eventAtNote,
      recordedAt: l.receivedAt,
      isNew: !!reviewedAt && l.receivedAt > reviewedAt,
      sources: [],
      open: l.entityId ? ({ kind: "node", id: l.entityId } as const) : null,
    })),
  ];
  const byRecorded = (a: Item, b: Item) => a.recordedAt.localeCompare(b.recordedAt);
  const groups =
    order === "event"
      ? [
          { title: null, items: items.filter((i) => i.eventAt).sort((a, b) => a.eventAt!.localeCompare(b.eventAt!)) },
          { title: "Recorded without an event time", items: items.filter((i) => !i.eventAt).sort(byRecorded) },
        ]
      : [{ title: null, items: [...items].sort(byRecorded) }];

  return (
    <div className="panel mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <p className="text-body text-ink-2">When something happened is shown separately from when the case learned of it.</p>
        <div role="group" aria-label="Order the timeline" className="flex rounded-[var(--radius-control)] border border-line bg-surface p-0.5">
          {(["event", "recorded"] as const).map((o) => (
            <button key={o} type="button" aria-pressed={order === o} onClick={() => setOrder(o)} className={cn("h-9 rounded-[4px] px-3 text-label font-medium", order === o ? "bg-action-tint text-action" : "text-ink-2 hover:text-ink")}>
              {o === "event" ? "By event time" : "By time recorded"}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 ? <p className="px-5 py-10 text-center text-body text-ink-2">No transfers, relationships or location observations have been recorded yet.</p> : null}
      {groups.map((g, gi) =>
        g.items.length ? (
          <section key={gi} aria-label={g.title ?? "Timeline"}>
            {g.title ? <h3 className="border-y border-line bg-surface-muted px-5 py-2 text-label font-semibold text-ink-2">{g.title}</h3> : null}
            <ol className="divide-y divide-line">
              {g.items.map((i) => (
                <li key={i.id} className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-5 py-3.5 md:grid-cols-[12rem_12rem_minmax(0,1fr)]">
                  <div className="text-label">
                    <span className="block text-meta text-ink-3">Event</span>
                    {i.eventAt ? <DateTime iso={i.eventAt} mode={i.eventDateOnly ? "date" : "datetime"} /> : <span className="text-ink-3">Not stated</span>}
                    {i.eventNote ? <span className="block text-meta text-ink-3">{i.eventNote}</span> : null}
                  </div>
                  <div className="text-label">
                    <span className="block text-meta text-ink-3">Recorded in case</span>
                    <DateTime iso={i.recordedAt} />
                  </div>
                  <div className="col-span-2 flex min-w-0 items-start justify-between gap-3 md:col-span-1">
                    <div className="min-w-0">
                      <p className="text-body text-ink">
                        <span className="font-medium">{i.kind}:</span> {i.text}
                        {i.isNew ? <span className="graph-chip ml-2 border-action bg-action align-middle text-white">New</span> : null}
                      </p>
                      {i.sources[0] ? <EvidenceLink caseId={caseId} source={i.sources[0]} className="mt-1" /> : null}
                    </div>
                    {i.open ? (
                      <IconButton label="Open details" onClick={() => onSelect(i.open!)}>
                        <PanelRightOpen aria-hidden="true" />
                      </IconButton>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : null,
      )}
    </div>
  );
}
