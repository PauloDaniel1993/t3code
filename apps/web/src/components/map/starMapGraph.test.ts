import type { WayfinderEdge, WayfinderNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildStarMapGraph, hash32, isWayfinderMapComplete } from "./starMapGraph";

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

describe("isWayfinderMapComplete", () => {
  const map = (counts: {
    total: number;
    open: number;
    claimed: number;
    resolved: number;
    outOfScope: number;
  }) => ({ counts: { ...counts, frontier: 0 } });

  it("requires a non-empty map with every ticket in a terminal state", () => {
    expect(
      isWayfinderMapComplete(map({ total: 3, open: 0, claimed: 0, resolved: 2, outOfScope: 1 })),
    ).toBe(true);
    expect(
      isWayfinderMapComplete(map({ total: 3, open: 1, claimed: 0, resolved: 2, outOfScope: 0 })),
    ).toBe(false);
    expect(
      isWayfinderMapComplete(map({ total: 3, open: 0, claimed: 1, resolved: 2, outOfScope: 0 })),
    ).toBe(false);
    expect(
      isWayfinderMapComplete(map({ total: 0, open: 0, claimed: 0, resolved: 0, outOfScope: 0 })),
    ).toBe(false);
  });

  it("rejects inconsistent terminal counts instead of guessing", () => {
    expect(
      isWayfinderMapComplete(map({ total: 4, open: 0, claimed: 0, resolved: 3, outOfScope: 0 })),
    ).toBe(false);
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

  it("reduces transitive block edges into a display backbone without changing the full graph", () => {
    const graph = buildStarMapGraph({
      nodes: [makeNode(1), makeNode(2), makeNode(3), makeNode(4)],
      edges: [blocks(1, 2), blocks(1, 3), blocks(1, 4), blocks(2, 4), blocks(3, 4)],
    });

    expect(graph.edges).toHaveLength(5);
    expect(graph.backboneEdges).toEqual([blocks(1, 2), blocks(1, 3), blocks(2, 4), blocks(3, 4)]);
  });

  it("keeps non-transitive rank-skipping blocks and every undermines edge", () => {
    const undermine = { from: "t4", to: "t2", kind: "undermines" as const };
    const graph = buildStarMapGraph({
      nodes: [makeNode(1), makeNode(2), makeNode(3), makeNode(4)],
      edges: [blocks(1, 2), blocks(1, 4), blocks(3, 4), undermine],
    });

    expect(graph.backboneEdges).toEqual(graph.edges);
  });

  it("preserves edges in and downstream of cycles instead of inventing a reduction", () => {
    const graph = buildStarMapGraph({
      nodes: [makeNode(1), makeNode(2), makeNode(3), makeNode(4), makeNode(5)],
      edges: [blocks(1, 2), blocks(2, 3), blocks(3, 2), blocks(2, 4), blocks(3, 4), blocks(4, 5)],
    });

    expect(graph.backboneEdges).toEqual(graph.edges);
  });

  it("shrinks the dense Discord transcription fixture from 30 links to 17", () => {
    const dependencies: Readonly<Record<number, ReadonlyArray<number>>> = {
      4: [1, 2],
      5: [2],
      6: [4, 5],
      7: [6],
      8: [7],
      9: [5, 7],
      10: [3, 9, 16],
      11: [8, 9, 10],
      12: [4, 5, 9, 11],
      13: [4, 5, 7, 8, 9, 10, 11, 12],
      14: [13],
      15: [14],
      16: [3],
    };
    const edges = Object.entries(dependencies).flatMap(([to, fromIds]) =>
      fromIds.map((from) => blocks(from, Number(to))),
    );
    const graph = buildStarMapGraph({
      nodes: Array.from({ length: 16 }, (_, index) => makeNode(index + 1)),
      edges,
    });

    expect(graph.edges).toHaveLength(30);
    expect(graph.backboneEdges).toHaveLength(17);
    expect(graph.backboneEdges).toContainEqual(blocks(16, 10));
    expect(graph.backboneEdges).not.toContainEqual(blocks(4, 13));
    expect(graph.backboneEdges).not.toContainEqual(blocks(11, 13));
    expect(graph.backboneEdges).toContainEqual(blocks(12, 13));
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
