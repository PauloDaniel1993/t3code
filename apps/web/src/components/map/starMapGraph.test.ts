import type { WayfinderEdge, WayfinderNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildStarMapGraph, hash32 } from "./starMapGraph";

function makeNode(ordinal: number, overrides?: Partial<WayfinderNode>): WayfinderNode {
  return {
    id: `t${ordinal}`,
    ordinal,
    label: `Ticket ${ordinal}`,
    relativePath: `.plan/map/tickets/${String(ordinal).padStart(2, "0")}-ticket.md`,
    type: "task",
    status: "open",
    isFrontier: false,
    isUndermined: false,
    claimedBy: null,
    rank: 0,
    cyclic: false,
    ...overrides,
  };
}

function blocks(fromOrdinal: number, toOrdinal: number): WayfinderEdge {
  return { from: `t${fromOrdinal}`, to: `t${toOrdinal}`, kind: "blocks" };
}

describe("hash32", () => {
  it("is deterministic and input-sensitive", () => {
    expect(hash32("15")).toBe(hash32("15"));
    expect(hash32("15")).not.toBe(hash32("16"));
    expect(hash32("")).toBe(hash32(""));
  });
});

describe("buildStarMapGraph", () => {
  it("sorts nodes by ordinal and drops duplicate ids", () => {
    const graph = buildStarMapGraph({
      nodes: [makeNode(3), makeNode(1), makeNode(2), makeNode(1, { label: "duplicate" })],
      edges: [],
    });
    expect(graph.nodes.map((node) => node.ordinal)).toEqual([1, 2, 3]);
    expect(graph.nodeById.get("t1")?.label).toBe("Ticket 1");
  });

  it("drops dangling edges, dedupes, and sorts by (from, to, kind)", () => {
    const graph = buildStarMapGraph({
      nodes: [makeNode(1), makeNode(2), makeNode(3)],
      edges: [
        blocks(2, 3),
        blocks(1, 2),
        blocks(1, 2),
        blocks(9, 1),
        { from: "t1", to: "t3", kind: "undermines" },
      ],
    });
    expect(graph.edges).toEqual([
      { from: "t1", to: "t2", kind: "blocks" },
      { from: "t1", to: "t3", kind: "undermines" },
      { from: "t2", to: "t3", kind: "blocks" },
    ]);
  });

  it("builds incoming and outgoing adjacency split by edge kind, including isolated nodes", () => {
    const graph = buildStarMapGraph({
      nodes: [makeNode(1), makeNode(2), makeNode(3)],
      edges: [blocks(1, 2), { from: "t2", to: "t1", kind: "undermines" }],
    });

    expect(graph.outgoing.get("t1")?.blocks.map((edge) => edge.to)).toEqual(["t2"]);
    expect(graph.outgoing.get("t1")?.undermines).toEqual([]);
    expect(graph.incoming.get("t1")?.undermines.map((edge) => edge.from)).toEqual(["t2"]);
    expect(graph.incoming.get("t2")?.blocks.map((edge) => edge.from)).toEqual(["t1"]);
    expect(graph.incoming.get("t3")).toEqual({ blocks: [], undermines: [] });
    expect(graph.outgoing.get("t3")).toEqual({ blocks: [], undermines: [] });
  });

  it("buckets node ids per status in node order", () => {
    const graph = buildStarMapGraph({
      nodes: [
        makeNode(3, { status: "resolved" }),
        makeNode(1, { status: "claimed" }),
        makeNode(2, { status: "open" }),
        makeNode(4, { status: "out_of_scope" }),
      ],
      edges: [],
    });
    expect(graph.byStatus.open).toEqual(["t2"]);
    expect(graph.byStatus.claimed).toEqual(["t1"]);
    expect(graph.byStatus.resolved).toEqual(["t3"]);
    expect(graph.byStatus.out_of_scope).toEqual(["t4"]);
  });

  it("computes maxRank, defaulting to 0 for an empty map", () => {
    expect(
      buildStarMapGraph({ nodes: [makeNode(1, { rank: 4 }), makeNode(2, { rank: 2 })], edges: [] })
        .maxRank,
    ).toBe(4);
    expect(buildStarMapGraph({ nodes: [], edges: [] }).maxRank).toBe(0);
  });

  it("produces a revision stable across input ordering", () => {
    const nodes = [makeNode(1, { rank: 0 }), makeNode(2, { rank: 1 }), makeNode(3, { rank: 1 })];
    const edges = [blocks(1, 2), blocks(1, 3)];
    const first = buildStarMapGraph({ nodes, edges });
    const second = buildStarMapGraph({
      nodes: nodes.toReversed(),
      edges: edges.toReversed(),
    });
    expect(second.revision).toBe(first.revision);
  });

  it("changes the revision when solver inputs change", () => {
    const nodes = [makeNode(1), makeNode(2, { rank: 1 })];
    const base = buildStarMapGraph({ nodes, edges: [] });
    expect(buildStarMapGraph({ nodes, edges: [blocks(1, 2)] }).revision).not.toBe(base.revision);
    expect(
      buildStarMapGraph({ nodes: [makeNode(1), makeNode(2, { rank: 2 })], edges: [] }).revision,
    ).not.toBe(base.revision);
    expect(buildStarMapGraph({ nodes: [...nodes, makeNode(3)], edges: [] }).revision).not.toBe(
      base.revision,
    );
  });

  it("keeps the revision unchanged when only status, labels, or flags change", () => {
    // Positions must survive a ticket resolving: the solver never sees status.
    const nodes = [makeNode(1), makeNode(2, { rank: 1 })];
    const base = buildStarMapGraph({ nodes, edges: [blocks(1, 2)] });
    const restyled = buildStarMapGraph({
      nodes: [
        makeNode(1, { status: "resolved", label: "Renamed", isFrontier: true }),
        makeNode(2, { rank: 1, status: "claimed", isUndermined: true, claimedBy: "agent" }),
      ],
      edges: [blocks(1, 2)],
    });
    expect(restyled.revision).toBe(base.revision);
  });
});
