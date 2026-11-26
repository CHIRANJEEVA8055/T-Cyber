"use client";

import "@xyflow/react/dist/style.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  getBezierPath,
  getSmoothStepPath,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { CircleDot } from "lucide-react";
import { formatInr } from "@/domain/money";
import type { GraphNode } from "@/contracts/graph";
import { cn } from "@/lib/cn";
import type { GraphModel, GraphView, ModelColumn, ModelEdge } from "../model";
import { KIND_ICONS, edgeLines, nodeDescription, shortHowFound, type GraphSelection } from "../presentation";
import { CARD_H, CARD_W, COL_STEP, ROW_STEP, TRUNK_GAP, planRoutes, roundedPath, type Route } from "../routing";

const HEADER_OFFSET = 76;
const PAD = 28;
/** The diagram opens no smaller than this, so labels stay readable; Fit to screen shows everything. */
const MIN_START_ZOOM = 0.9;
const COLOURS = { edge: "#8a8a93", action: "#1f4b8f", focus: "#2f6bd8" };

const SelectContext = createContext<(s: GraphSelection) => void>(() => {});

/** `note` replaces the bank line on discovery cards with how the record was found. */
type RecordData = {
  node: GraphNode;
  selected: boolean;
  faded: boolean;
  note: string | null;
};
type ColumnData = { column: ModelColumn };
type GraphEdgeData = {
  model: ModelEdge;
  selected: boolean;
  faded: boolean;
  route: Route;
};

function HoldChip({ hold }: { hold: GraphNode["hold"] }) {
  if (!hold) return null;
  if (hold.heldMinor) return <span className="graph-chip border-[rgb(23_102_58/0.16)] bg-success-tint text-success">Held {formatInr(BigInt(hold.heldMinor))}</span>;
  if (hold.amountUnknown) return <span className="graph-chip border-[rgb(138_83_0/0.18)] bg-warning-tint text-warning">Held, amount unknown</span>;
  if (hold.requested) return <span className="graph-chip border-line-strong bg-surface text-ink-2">Hold requested</span>;
  return null;
}

function RecordNode({ data }: NodeProps<Node<RecordData, "record">>) {
  const n = data.node;
  const Icon = KIND_ICONS[n.kind] ?? CircleDot;
  const meta = data.note ?? [n.isVictimAccount ? "Victim’s account" : null, n.bank].filter(Boolean).join(", ");
  return (
    <div
      className={cn(
        "flex flex-col rounded-[var(--radius-panel)] border bg-surface px-3 py-2.5 shadow-[var(--shadow-control)] transition-opacity duration-150 motion-reduce:transition-none",
        data.selected ? "border-focus ring-2 ring-[rgb(40_102_197/0.25)]" : n.isNew ? "border-action" : "border-line-strong",
        data.faded && "opacity-30",
      )}
      style={{ width: CARD_W, height: CARD_H }}
    >
      <Handle id="l-in" type="target" position={Position.Left} isConnectable={false} className="graph-handle" />
      <Handle id="l-out" type="source" position={Position.Left} isConnectable={false} className="graph-handle" />
      <Handle id="r-out" type="source" position={Position.Right} isConnectable={false} className="graph-handle" />
      <Handle id="r-in" type="target" position={Position.Right} isConnectable={false} className="graph-handle" />
      <div className="flex min-w-0 items-start gap-2">
        <Icon aria-hidden="true" className="mt-[3px] size-4 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-label font-semibold text-ink">{n.label}</p>
          {n.value !== n.label ? <p className="truncate font-mono text-meta text-ink-2">{n.value}</p> : null}
          {meta ? <p className={cn("truncate text-meta", data.note ? "text-ink-2" : "text-ink-3")}>{meta}</p> : null}
        </div>
      </div>
      <div className="mt-auto flex min-w-0 gap-1 overflow-hidden">
        {n.isNew ? <span className="graph-chip border-action bg-action text-white">New</span> : null}
        <HoldChip hold={n.hold} />
        {n.verification === "CORROBORATED" ? <span className="graph-chip border-[rgb(23_102_58/0.16)] bg-success-tint text-success">Corroborated</span> : null}
        {n.verification === "DISPUTED" ? <span className="graph-chip border-[rgb(180_35_24/0.16)] bg-danger-tint text-danger">Disputed</span> : null}
      </div>
    </div>
  );
}

function ColumnHeader({ data: { column } }: NodeProps<Node<ColumnData, "column">>) {
  return (
    <div className="border-b border-line-strong pb-2" style={{ width: CARD_W }}>
      <p className="text-label font-semibold text-ink">{column.title}</p>
      {column.detail ? <p className="line-clamp-2 text-meta text-ink-3">{column.detail}</p> : null}
    </div>
  );
}

function GraphEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<Edge<GraphEdgeData, "graph">>) {
  const select = useContext(SelectContext);
  if (!data) return null;
  let path: string;
  let labelX: number;
  let labelY: number;
  const forward = sourcePosition === Position.Right && targetPosition === Position.Left && targetX - sourceX > TRUNK_GAP * 3;
  const route = forward ? data.route : ({ kind: "curve" } as const);
  if (route.kind === "trunk-source" || route.kind === "trunk-target") {
    const nearTarget = route.kind === "trunk-target";
    const centerX = nearTarget ? targetX - TRUNK_GAP : sourceX + TRUNK_GAP;
    [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      centerX,
      borderRadius: 8,
      offset: 0,
    });
    labelX = nearTarget ? (sourceX + centerX) / 2 : (centerX + targetX) / 2;
    labelY = nearTarget ? sourceY : targetY;
  } else if (route.kind === "lane") {
    const x1 = sourceX + TRUNK_GAP;
    const x2 = targetX - TRUNK_GAP;
    path = roundedPath([
      [sourceX, sourceY],
      [x1, sourceY],
      [x1, route.y],
      [x2, route.y],
      [x2, targetY],
      [targetX, targetY],
    ]);
    // In the last gap before the target, where no card can sit.
    labelX = targetX - (COL_STEP - CARD_W) / 2;
    labelY = route.y;
  } else {
    [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }
  const e = data.model;
  const dashed = (e.type === "money" && !e.allConfirmed) || (e.type === "identity" && e.relation.type === "POTENTIALLY_ASSOCIATED_WITH");
  const stroke = data.selected ? COLOURS.focus : e.isNew ? COLOURS.action : COLOURS.edge;
  const [primary, ...rest] = edgeLines(e);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={24}
        style={{
          stroke,
          strokeWidth: data.selected ? 2.25 : 1.5,
          strokeDasharray: dashed ? "6 4" : undefined,
          opacity: data.faded ? 0.18 : 1,
        }}
      />
      {e.type === "discovery" ? null : (
        <EdgeLabelRenderer>
          {/* A mouse shortcut to the connection's details; keyboard users reach the same details from the focusable edge. */}
          <div
            aria-hidden="true"
            onClick={() => select({ kind: "edge", id })}
            className={cn(
              "nodrag nopan absolute max-w-[150px] cursor-pointer rounded-[var(--radius-control)] border bg-surface px-1.5 py-0.5 text-center shadow-[var(--shadow-control)] hover:border-line-input",
              data.selected ? "border-focus" : e.isNew ? "border-action" : "border-line-strong",
              data.faded && "opacity-25",
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          >
            <span className={cn("block truncate", e.type === "money" ? "text-label font-semibold tabular-nums text-ink" : "text-meta text-ink-2")}>{primary}</span>
            {rest.map((line) => (
              <span key={line} className="block truncate text-meta tabular-nums text-ink-2">
                {line}
              </span>
            ))}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { record: RecordNode, column: ColumnHeader };
const EDGE_TYPES = { graph: GraphEdge };

/** The app's theme (the "light" class on <html>), followed live when the officer switches it. */
function useAppTheme(): "light" | "dark" {
  return useSyncExternalStore(
    (onChange) => {
      const o = new MutationObserver(onChange);
      o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      return () => o.disconnect();
    },
    () => (document.documentElement.classList.contains("light") ? "light" : "dark"),
    () => "dark",
  );
}

export function GraphCanvas({
  model,
  view,
  selection,
  onSelect,
  label,
}: {
  model: GraphModel;
  view: GraphView;
  selection: GraphSelection | null;
  onSelect: (s: GraphSelection) => void;
  label: string;
}) {
  const appTheme = useAppTheme();
  const flow = useReactFlow();
  const { nodes, edges } = useMemo(() => {
    const placed = new Map(model.nodes.map((x) => [x.node.id, x]));
    const labelOf = (id: string) => placed.get(id)?.node.label;
    const routes = planRoutes(model);
    const nodes: Node[] = [
      ...model.columns.map((c) => ({
        id: `col:${c.index}`,
        type: "column",
        position: { x: c.index * COL_STEP, y: -HEADER_OFFSET },
        data: { column: c } satisfies ColumnData,
        draggable: false,
        selectable: false,
        focusable: false,
        connectable: false,
      })),
      ...model.nodes.map((x) => ({
        id: x.node.id,
        type: "record",
        position: { x: x.column * COL_STEP, y: x.row * ROW_STEP },
        data: {
          node: x.node,
          selected: selection?.kind === "node" && selection.id === x.node.id,
          faded: !x.inBranch,
          note: view === "discovery" ? shortHowFound(x.node, labelOf) : null,
        } satisfies RecordData,
        ariaLabel: nodeDescription(x.node),
        draggable: false,
        connectable: false,
      })),
    ];
    const edges: Edge[] = model.edges.map((e) => {
      const sc = placed.get(e.source)!.column;
      const tc = placed.get(e.target)!.column;
      const [sourceHandle, targetHandle] = sc < tc ? ["r-out", "l-in"] : sc > tc ? ["l-out", "r-in"] : ["r-out", "r-in"];
      const selected = selection?.kind === "edge" && selection.id === e.id;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle,
        targetHandle,
        type: "graph",
        data: {
          model: e,
          selected,
          faded: !e.inBranch,
          route: routes.get(e.id) ?? { kind: "curve" },
        } satisfies GraphEdgeData,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: selected ? COLOURS.focus : e.isNew ? COLOURS.action : COLOURS.edge,
        },
        ariaLabel: `${placed.get(e.source)!.node.label} to ${placed.get(e.target)!.node.label}: ${edgeLines(e).join(", ")}`,
      };
    });
    return { nodes, edges };
  }, [model, selection, view]);

  // Content bounds in diagram coordinates (column headers included).
  const maxCol = Math.max(0, ...model.columns.map((c) => c.index));
  const boundsW = maxCol * COL_STEP + CARD_W;
  const boundsH = HEADER_OFFSET + model.maxRow * ROW_STEP + CARD_H;
  const width = useStore((s) => s.width);
  const canvasHeight = useStore((s) => s.height);

  // Re-position when the layout changes (view or filters); selection and branch focus keep the viewport.
  // Open at a readable zoom, centred when everything fits, otherwise starting from the left (the victim's side).
  const layoutKey = useMemo(() => model.nodes.map((x) => `${x.node.id}@${x.column},${x.row}`).join("|"), [model]);
  useEffect(() => {
    if (!width || !canvasHeight) return;
    const fit = Math.min((width - 2 * PAD) / boundsW, (canvasHeight - 2 * PAD) / boundsH);
    const zoom = Math.min(1, Math.max(fit, MIN_START_ZOOM));
    const x = boundsW * zoom + 2 * PAD <= width ? (width - boundsW * zoom) / 2 : PAD;
    const y = (boundsH * zoom + 2 * PAD <= canvasHeight ? (canvasHeight - boundsH * zoom) / 2 : PAD) + HEADER_OFFSET * zoom;
    void flow.setViewport({ x, y, zoom });
  }, [layoutKey, width, canvasHeight, boundsW, boundsH, flow]);

  const clipped = useStore((s) => {
    const [tx, ty, z] = s.transform;
    if (!s.width || !s.height) return false;
    const left = tx;
    const right = tx + boundsW * z;
    const top = ty - HEADER_OFFSET * z;
    const bottom = top + boundsH * z;
    return left < -1 || top < -1 || right > s.width + 1 || bottom > s.height + 1;
  });

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) if (c.type === "select" && c.selected) onSelect({ kind: "node", id: c.id });
    },
    [onSelect],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) if (c.type === "select" && c.selected) onSelect({ kind: "edge", id: c.id });
    },
    [onSelect],
  );

  const contentHeight = HEADER_OFFSET + model.maxRow * ROW_STEP + CARD_H;
  const height = Math.min(Math.max(contentHeight + 72, 380), 1600);

  return (
    <SelectContext.Provider value={onSelect}>
      <div
        style={{ height }}
        className="graph-canvas"
        // Enter/Space on a record or connection open its details. Cancel the key's default action, or the
        // browser would "activate" whatever the drawer focuses next (its Close button) and shut it at once.
        onKeyDownCapture={(e) => {
          if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).closest(".react-flow__node, .react-flow__edge")) e.preventDefault();
        }}
      >
        <ReactFlow
          // Follow the app's theme: the library's own default ("light") would mark the graph light in the dark theme.
          colorMode={appTheme}
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          defaultViewport={{ x: PAD, y: PAD + HEADER_OFFSET, zoom: 1 }}
          minZoom={0.25}
          maxZoom={1.75}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          panOnScroll={false}
          preventScrolling={false}
          ariaLabelConfig={{
            "node.a11yDescription.default": "Press Enter to open the details of this record.",
            "node.a11yDescription.keyboardDisabled": "Press Enter to open the details of this record.",
            "edge.a11yDescription.default": "Press Enter to open the details of this connection.",
          }}
          aria-label={label}
        >
          <Background gap={24} size={1} color="#e4e4e7" />
          {clipped ? (
            <Panel position="bottom-left">
              <p className="rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-1.5 text-meta text-ink-2 shadow-[var(--shadow-control)]">
                Part of the diagram is outside the view. Drag to move around, or use Fit to screen.
              </p>
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
    </SelectContext.Provider>
  );
}
