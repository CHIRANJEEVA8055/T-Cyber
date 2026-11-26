"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { CheckCheck, Crosshair, List, Maximize, Minus, Network, Plus, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { DetailDrawer } from "@/components/ui/drawer";
import { Checkbox } from "@/components/ui/field";
import { DateTime } from "@/components/app/datetime";
import { EmptyState } from "@/components/app/states";
import { useServerAction } from "@/features/shared/use-action";
import { markGraphReviewedAction } from "@/features/graph/actions";
import type { GraphData } from "@/contracts/graph";
import { cn } from "@/lib/cn";
import { KIND_GROUPS, buildGraphModel, type GraphView, type ModelEdge } from "../model";
import { kindLabel, type GraphSelection } from "../presentation";
import { GraphCanvas } from "./graph-canvas";
import { GraphList } from "./graph-list";
import { GraphTimeline } from "./graph-timeline";
import { EdgeDetails, NodeDetails, edgeHeading } from "./graph-details";

type Tab = GraphView | "timeline";
const TABS: { key: Tab; label: string }[] = [
  { key: "money", label: "Money flow" },
  { key: "identity", label: "Identity" },
  { key: "discovery", label: "Discovery" },
  { key: "timeline", label: "Timeline" },
];
const LEGENDS: Record<GraphView, string> = {
  money: "Columns show transfer depth, left to right. A solid line is confirmed by a bank record; a dashed line was reported by the victim and is not yet confirmed.",
  identity: "Relationships are shown exactly as recorded. A dashed line marks a possible association, not an established link.",
  discovery: "Each column is a step of the investigation. A line runs from the record a request was about to what its response revealed.",
};

const NARROW = "(max-width: 767.98px)";
function subscribeNarrow(onChange: () => void) {
  const m = window.matchMedia(NARROW);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}
/** null until the client knows the viewport, so the server render never guesses. */
function useIsNarrow(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => null);
}

function ZoomControls() {
  const flow = useReactFlow();
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Zoom">
      <IconButton label="Zoom out" onClick={() => void flow.zoomOut()}>
        <Minus aria-hidden="true" />
      </IconButton>
      <IconButton label="Zoom in" onClick={() => void flow.zoomIn()}>
        <Plus aria-hidden="true" />
      </IconButton>
      <IconButton label="Fit to screen" onClick={() => void flow.fitView({ padding: "28px", maxZoom: 1 })}>
        <Maximize aria-hidden="true" />
      </IconButton>
    </div>
  );
}

const segment = (active: boolean) => cn("inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[4px] px-3 text-label font-medium", active ? "bg-action-tint text-action" : "text-ink-2 hover:text-ink");

function GraphWorkspace({ caseId, data }: { caseId: string; data: GraphData }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (TABS.some((t) => t.key === params.get("view")) ? params.get("view") : "money") as Tab;
  const view: GraphView = tab === "timeline" ? "money" : tab;
  const focus = params.get("focus");
  const narrow = useIsNarrow();
  const [displayChoice, setDisplayChoice] = useState<"diagram" | "list" | null>(null);
  const display = displayChoice ?? (narrow ? "list" : "diagram");
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(new Set());
  const [onlyNew, setOnlyNew] = useState(false);
  // The investigation is about the accused: the victim's own records stay out unless asked for.
  const [showVictim, setShowVictim] = useState(false);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const review = useServerAction(markGraphReviewedAction);

  // View and branch focus live in the URL (shareable, survive reload) without a server round trip.
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      window.history.replaceState(null, "", `${pathname}${next.size ? `?${next}` : ""}`);
    },
    [params, pathname],
  );

  const model = useMemo(() => buildGraphModel(data, { view, hiddenKinds, onlyNew, focus, showVictim }), [data, view, hiddenKinds, onlyNew, focus, showVictim]);
  const victimCount = data.nodes.filter((n) => n.victimSide && !(view === "money" && n.isVictimAccount)).length;
  const baseModel = useMemo(() => buildGraphModel(data, { view }), [data, view]);
  const allEdges = useMemo(() => new Map<string, ModelEdge>((["money", "identity", "discovery"] as const).flatMap((v) => buildGraphModel(data, { view: v }).edges.map((e) => [e.id, e] as const))), [data]);
  const groupsInView = KIND_GROUPS.filter((g) => baseModel.nodes.some((x) => g.kinds.includes(x.node.kind)));
  const newCount = baseModel.nodes.filter((x) => x.node.isNew).length + (view === "discovery" ? 0 : baseModel.edges.filter((e) => e.isNew).length);
  const filtered = hiddenKinds.size > 0 || onlyNew;
  const focusNode = focus && model.nodes.some((x) => x.node.id === focus) ? data.nodes.find((n) => n.id === focus) : undefined;

  const labelOf = (id: string) => data.nodes.find((n) => n.id === id)?.label ?? "Record";
  const selectedNode = selection?.kind === "node" ? data.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? allEdges.get(selection.id) : undefined;
  const heading = selectedNode ? { title: selectedNode.label, subtitle: `${kindLabel(selectedNode.kind)}${selectedNode.value !== selectedNode.label ? `, ${selectedNode.value}` : ""}` } : selectedEdge ? edgeHeading(selectedEdge, labelOf) : null;
  const select = useCallback((s: GraphSelection) => setSelection(s), []);
  const clearFilters = () => {
    setHiddenKinds(new Set());
    setOnlyNew(false);
  };

  const emptyCopy: Record<GraphView, { title: string; description: string; href: string; action: string }> = {
    money: { title: "No transfers recorded yet", description: "Transfers appear here when the victim’s payments are entered or a bank statement is applied to the case.", href: `/cases/${caseId}/funds`, action: "Open funds" },
    identity: { title: "No identity relationships yet", description: "Relationships appear when a response or an officer records who a phone number, email or account is registered to or used by.", href: `/cases/${caseId}/people`, action: "Open identifiers" },
    discovery: { title: "No records yet", description: "Records appear here as documents are reviewed and responses are applied.", href: `/cases/${caseId}/evidence`, action: "Open evidence" },
  };

  return (
    <>
      <div className="chrome-blur sticky top-0 z-20 -mx-4 border-b border-line px-4 py-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Graph view" className="flex max-w-full overflow-x-auto rounded-[var(--radius-control)] border border-line bg-surface p-0.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={tab === t.key}
                onClick={() => {
                  setSelection(null);
                  setParam("view", t.key === "money" ? null : t.key);
                }}
                className={segment(tab === t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab !== "timeline" ? (
            <div role="group" aria-label="Presentation" className="flex rounded-[var(--radius-control)] border border-line bg-surface p-0.5">
              <button type="button" aria-pressed={display === "diagram"} onClick={() => setDisplayChoice("diagram")} className={segment(display === "diagram")}>
                <Network aria-hidden="true" className="size-4" />
                Diagram
              </button>
              <button type="button" aria-pressed={display === "list"} onClick={() => setDisplayChoice("list")} className={segment(display === "list")}>
                <List aria-hidden="true" className="size-4" />
                List
              </button>
            </div>
          ) : null}
          {tab !== "timeline" && display === "diagram" && narrow !== null && model.nodes.length ? <ZoomControls /> : null}
          {tab !== "timeline" && focusNode ? (
            <Button size="sm" variant="secondary" icon={<X aria-hidden="true" />} onClick={() => setParam("focus", null)}>
              Clear focus on {focusNode.label}
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-label text-ink-3 lg:inline">
              {data.reviewedAt ? (
                <>
                  You last reviewed <DateTime iso={data.reviewedAt} />
                </>
              ) : (
                "You have not reviewed this graph yet"
              )}
            </span>
            <Button size="sm" variant="secondary" icon={<CheckCheck aria-hidden="true" />} loading={review.pending} onClick={() => review.run([caseId], { success: "Graph marked as reviewed" })}>
              Mark as reviewed
            </Button>
          </div>
        </div>
      </div>

      {tab === "timeline" ? (
        <GraphTimeline data={data} caseId={caseId} onSelect={select} />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2" role="group" aria-label="Filter the graph">
            <span className="text-label font-semibold text-ink-2">Show</span>
            {groupsInView.map((g) => (
              <Checkbox
                key={g.key}
                label={g.label}
                checked={!g.kinds.every((k) => hiddenKinds.has(k))}
                onChange={(e) => {
                  const next = new Set(hiddenKinds);
                  for (const k of g.kinds) {
                    if (e.target.checked) next.delete(k);
                    else next.add(k);
                  }
                  setHiddenKinds(next);
                }}
              />
            ))}
            <span aria-hidden="true" className="hidden h-5 w-px bg-line-strong sm:block" />
            {victimCount ? (
              <Checkbox
                label={`The victim’s own details (${victimCount})`}
                checked={showVictim}
                onChange={(e) => setShowVictim(e.target.checked)}
              />
            ) : null}
            {data.reviewedAt ? (
              <Checkbox label={`Only new since my last review (${newCount})`} checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
            ) : (
              <span className="text-label text-ink-3">Mark the graph as reviewed to highlight what is added later.</span>
            )}
          </div>

          {narrow === null ? (
            <div className="panel mt-3 h-[380px]" aria-hidden="true" />
          ) : model.nodes.length === 0 ? (
            <div className="panel mt-3">
              {filtered ? (
                <EmptyState
                  title="Nothing matches these filters"
                  description={onlyNew ? "Nothing has been added to this view since your last review." : "Every kind of record in this view is hidden."}
                  action={
                    <Button variant="secondary" onClick={clearFilters}>
                      Clear all filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title={emptyCopy[view].title}
                  description={emptyCopy[view].description}
                  action={
                    <Button asChild variant="secondary">
                      <Link href={emptyCopy[view].href}>{emptyCopy[view].action}</Link>
                    </Button>
                  }
                />
              )}
            </div>
          ) : display === "diagram" ? (
            <div className="panel mt-3 overflow-hidden">
              <GraphCanvas model={model} view={view} selection={selection} onSelect={select} label={`${TABS.find((t) => t.key === tab)?.label} diagram`} />
            </div>
          ) : (
            <div className="mt-3">
              <GraphList view={view} model={model} caseId={caseId} onSelect={select} />
            </div>
          )}
          <p className="mt-3 max-w-[75ch] text-label text-ink-3">
            {LEGENDS[view]} Appearing in the graph is not a finding of involvement.
          </p>
        </>
      )}

      <DetailDrawer
        open={!!heading}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
        title={heading?.title ?? ""}
        subtitle={heading?.subtitle}
        footer={
          selectedNode && tab !== "timeline" ? (
            <Button
              variant="secondary"
              icon={<Crosshair aria-hidden="true" />}
              onClick={() => {
                setParam("focus", selectedNode.id);
                setSelection(null);
              }}
            >
              Focus on this branch
            </Button>
          ) : undefined
        }
      >
        {selectedNode ? <NodeDetails node={selectedNode} data={data} caseId={caseId} /> : selectedEdge ? <EdgeDetails edge={selectedEdge} data={data} caseId={caseId} /> : null}
      </DetailDrawer>
    </>
  );
}

export function CaseGraph({ caseId, data }: { caseId: string; data: GraphData }) {
  return (
    <ReactFlowProvider>
      <GraphWorkspace caseId={caseId} data={data} />
    </ReactFlowProvider>
  );
}
