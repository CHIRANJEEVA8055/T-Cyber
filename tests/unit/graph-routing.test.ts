import { describe, expect, it } from "vitest";
import { CARD_H, ROW_STEP, planRoutes, roundedPath } from "@/features/graph/routing";
import type { GraphModel, ModelEdge, ModelNode } from "@/features/graph/model";
import type { GraphNode } from "@/contracts/graph";

const node = (id: string, column: number, row: number): ModelNode => ({ node: { id, label: id } as GraphNode, column, row, inBranch: true });
const edge = (source: string, target: string): ModelEdge =>
  ({ type: "identity", id: `${source}>${target}`, source, target, isNew: false, inBranch: true, relation: {} as never }) as ModelEdge;
const model = (nodes: ModelNode[], edges: ModelEdge[]): GraphModel => ({ columns: [], nodes, edges, maxRow: Math.max(...nodes.map((n) => n.row)) });

describe("graph routing", () => {
  it("gives a fan-out a shared trunk when nothing else sits in the source column", () => {
    const routes = planRoutes(model([node("V", 0, 0), node("A", 1, 0), node("B", 1, 1), node("C", 1, 2)], [edge("V", "A"), edge("V", "B"), edge("V", "C")]));
    expect([...routes.values()].map((r) => r.kind)).toEqual(["trunk-source", "trunk-source", "trunk-source"]);
  });

  it("does not run a trunk past another record, so no branch seems to start from it", () => {
    const routes = planRoutes(model([node("A", 0, 1), node("B", 0, 2), node("D", 1, 1), node("H", 1, 2)], [edge("A", "D"), edge("A", "H")]));
    expect(routes.get("A>D")).toEqual({ kind: "trunk-source" });
    expect(routes.get("A>H")).toEqual({ kind: "curve" });
  });

  it("gives a fan-in a trunk beside the target when the target column is clear", () => {
    const routes = planRoutes(model([node("V1", 0, 0), node("V2", 0, 1), node("M", 1, 0.5)], [edge("V1", "M"), edge("V2", "M")]));
    expect(routes.get("V1>M")).toEqual({ kind: "trunk-target" });
    expect(routes.get("V2>M")).toEqual({ kind: "trunk-target" });
  });

  it("routes a connection that skips a column through the gap between cards, never through a card", () => {
    const nodes = [node("B", 0, 2), node("H", 1, 2), node("X", 1, 1), node("E", 2, 2)];
    const route = planRoutes(model(nodes, [edge("B", "E")])).get("B>E")!;
    expect(route.kind).toBe("lane");
    const y = route.kind === "lane" ? route.y : NaN;
    for (const n of nodes.filter((x) => x.column === 1)) {
      const top = n.row * ROW_STEP;
      expect(y < top || y > top + CARD_H).toBe(true);
    }
  });

  it("moves the lane when the band above the target is blocked by a card at an in-between row", () => {
    const nodes = [node("B", 0, 2), node("M", 1, 1.5), node("E", 2, 2)];
    const route = planRoutes(model(nodes, [edge("B", "E")])).get("B>E")!;
    expect(route.kind).toBe("lane");
    const y = route.kind === "lane" ? route.y : NaN;
    expect(y < 1.5 * ROW_STEP || y > 1.5 * ROW_STEP + CARD_H).toBe(true);
  });
});

describe("rounded orthogonal paths", () => {
  it("draws a straight line without corners", () => {
    expect(roundedPath([[0, 0], [10, 0], [50, 0]])).toBe("M 0 0 L 50 0");
  });

  it("rounds each corner and skips repeated points", () => {
    expect(roundedPath([[0, 0], [20, 0], [20, 0], [20, 40], [60, 40]], 8)).toBe("M 0 0 L 12 0 Q 20 0 20 8 L 20 32 Q 20 40 28 40 L 60 40");
  });
});
