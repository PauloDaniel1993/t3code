import type { WayfinderEdge, WayfinderNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildStarMapGraph } from "./starMapGraph";
import {
  layoutStarMap,
  STAR_MAP_LAYER_SPACING,
  STAR_MAP_MAX_LAYER_SPAN,
  STAR_MAP_MIN_SEPARATION,
  STAR_MAP_ORDERING_SWEEPS,
  type StarMapPosition,
} from "./starMapLayout";

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

/** A map with `tierCounts[rank]` nodes per rank; every node above rank 0 is
 * blocked by one node from the previous tier, chosen round-robin. */
function makeTieredMap(tierCounts: ReadonlyArray<number>): {
  nodes: Array<WayfinderNode>;
  edges: Array<WayfinderEdge>;
} {
  const nodes: Array<WayfinderNode> = [];
  const edges: Array<WayfinderEdge> = [];
  const idsByTier: Array<Array<string>> = [];
  let ordinal = 1;
  tierCounts.forEach((count, rank) => {
    const tierIds: Array<string> = [];
    for (let index = 0; index < count; index += 1) {
      const node = makeNode(ordinal, { rank });
      nodes.push(node);
      tierIds.push(node.id);
      if (rank > 0) {
        const previousTier = idsByTier[rank - 1]!;
        const blocker = previousTier[(ordinal - 1) % previousTier.length]!;
        edges.push({ from: blocker, to: node.id, kind: "blocks" });
      }
      ordinal += 1;
    }
    idsByTier.push(tierIds);
  });
  return { nodes, edges };
}

function minPairDistance(positions: ReadonlyArray<StarMapPosition>): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let a = 0; a < positions.length - 1; a += 1) {
    for (let b = a + 1; b < positions.length; b += 1) {
      minimum = Math.min(
        minimum,
        Math.hypot(positions[a]!.x - positions[b]!.x, positions[a]!.y - positions[b]!.y),
      );
    }
  }
  return minimum;
}

function orientation(
  first: StarMapPosition,
  second: StarMapPosition,
  third: StarMapPosition,
): number {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function edgeCrossings(
  edges: ReadonlyArray<WayfinderEdge>,
  positionById: ReadonlyMap<string, StarMapPosition | { readonly x: number; readonly y: number }>,
): number {
  let crossings = 0;
  for (let left = 0; left < edges.length - 1; left += 1) {
    const a = edges[left]!;
    const aFrom = positionById.get(a.from)!;
    const aTo = positionById.get(a.to)!;
    for (let right = left + 1; right < edges.length; right += 1) {
      const b = edges[right]!;
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      const bFrom = positionById.get(b.from)!;
      const bTo = positionById.get(b.to)!;
      const firstSide = orientation(
        aFrom as StarMapPosition,
        aTo as StarMapPosition,
        bFrom as StarMapPosition,
      );
      const secondSide = orientation(
        aFrom as StarMapPosition,
        aTo as StarMapPosition,
        bTo as StarMapPosition,
      );
      const thirdSide = orientation(
        bFrom as StarMapPosition,
        bTo as StarMapPosition,
        aFrom as StarMapPosition,
      );
      const fourthSide = orientation(
        bFrom as StarMapPosition,
        bTo as StarMapPosition,
        aTo as StarMapPosition,
      );
      if (firstSide * secondSide < 0 && thirdSide * fourthSide < 0) crossings += 1;
    }
  }
  return crossings;
}

function reportedDiscordFixture(): { nodes: Array<WayfinderNode>; edges: Array<WayfinderEdge> } {
  const ranks = [0, 0, 0, 1, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 10, 1];
  const nodes = ranks.map((rank, index) => makeNode(index + 1, { rank }));
  const dependencies: Record<number, ReadonlyArray<number>> = {
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
  const edges = Object.entries(dependencies).flatMap(([dependent, blockers]) =>
    blockers.map(
      (blocker): WayfinderEdge => ({
        from: `t${blocker}`,
        to: `t${dependent}`,
        kind: "blocks",
      }),
    ),
  );
  return { nodes, edges };
}

describe("layoutStarMap", () => {
  it("returns an empty layout for an empty map", () => {
    const layout = layoutStarMap(buildStarMapGraph({ nodes: [], edges: [] }));
    expect(layout.positions).toEqual([]);
    expect(layout.boundingRadius).toBe(0);
    expect(layout.iterations).toBe(0);
    expect(layout.pairChecks).toBe(0);
  });

  it("is deterministic and independent of input order", () => {
    const map = makeTieredMap([6, 12, 16, 12, 8, 6]);
    const reference = layoutStarMap(buildStarMapGraph(map));
    expect(layoutStarMap(buildStarMapGraph(map))).toEqual(reference);
    expect(
      layoutStarMap(
        buildStarMapGraph({ nodes: map.nodes.toReversed(), edges: map.edges.toReversed() }),
      ),
    ).toEqual(reference);
  });

  it("aligns equal ranks into rows and makes blocker flow top to bottom", () => {
    const map = makeTieredMap([4, 6, 6, 4]);
    const graph = buildStarMapGraph(map);
    const layout = layoutStarMap(graph);
    for (const rank of new Set(graph.nodes.map((node) => node.rank))) {
      const ys = new Set(
        graph.nodes
          .filter((node) => node.rank === rank)
          .map((node) => layout.positionById.get(node.id)!.y),
      );
      expect(ys.size).toBe(1);
    }
    for (const edge of graph.edges) {
      const from = graph.nodeById.get(edge.from)!;
      const to = graph.nodeById.get(edge.to)!;
      if (to.rank <= from.rank) continue;
      expect(layout.positionById.get(edge.to)!.y).toBeGreaterThan(
        layout.positionById.get(edge.from)!.y,
      );
    }
  });

  it("uses barycentric ordering to remove an obvious crossing", () => {
    const nodes = [
      makeNode(1, { rank: 0 }),
      makeNode(2, { rank: 0 }),
      makeNode(3, { rank: 1 }),
      makeNode(4, { rank: 1 }),
    ];
    const edges: Array<WayfinderEdge> = [
      { from: "t1", to: "t4", kind: "blocks" },
      { from: "t2", to: "t3", kind: "blocks" },
    ];
    const graph = buildStarMapGraph({ nodes, edges });
    const layout = layoutStarMap(graph);
    expect(edgeCrossings(graph.backboneEdges, layout.positionById)).toBe(0);
    expect(layout.positionById.get("t4")!.x).toBeLessThan(layout.positionById.get("t3")!.x);
  });

  it("keeps the reported 16-ticket map compact after reducing 30 links to 17", () => {
    const graph = buildStarMapGraph(reportedDiscordFixture());
    const layout = layoutStarMap(graph);
    const xs = layout.positions.map(({ x }) => x);
    const ys = layout.positions.map(({ y }) => y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    console.info(
      `[star-map metrics] reported map: ${graph.edges.length} declared, ${graph.backboneEdges.length} visible, ` +
        `${edgeCrossings(graph.backboneEdges, layout.positionById)} crossings, ${width}x${height} units`,
    );
    expect(graph.edges).toHaveLength(30);
    expect(graph.backboneEdges).toHaveLength(17);
    expect(width).toBeLessThanOrEqual(880);
    expect(height).toBe(10 * STAR_MAP_LAYER_SPACING);
    expect(edgeCrossings(graph.backboneEdges, layout.positionById)).toBeLessThanOrEqual(2);
  });

  it("guarantees minimum separation and caps very broad layers", () => {
    const fixtures: Record<string, { nodes: Array<WayfinderNode>; edges: Array<WayfinderEdge> }> = {
      "sixty-node tiered map": makeTieredMap([6, 12, 16, 12, 8, 6]),
      "two-hundred-node cap stress": makeTieredMap([8, 24, 48, 60, 40, 20]),
      "two-hundred-node single-rank crowd": makeTieredMap([200]),
      "twelve-node chain": makeTieredMap([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    };
    for (const [name, fixture] of Object.entries(fixtures)) {
      const layout = layoutStarMap(buildStarMapGraph(fixture));
      const minimum = minPairDistance(layout.positions);
      console.info(
        `[star-map metrics] min pairwise separation (${name}): ${minimum.toFixed(3)} units`,
      );
      expect(minimum).toBeGreaterThanOrEqual(STAR_MAP_MIN_SEPARATION - 1e-6);
    }
    const crowd = layoutStarMap(buildStarMapGraph(makeTieredMap([200])));
    const crowdXs = crowd.positions.map(({ x }) => x);
    expect(Math.max(...crowdXs) - Math.min(...crowdXs)).toBeLessThanOrEqual(
      STAR_MAP_MAX_LAYER_SPAN,
    );
  });

  it("produces finite positions for cyclic nodes, isolated nodes, and dropped edges", () => {
    const nodes = [
      makeNode(1, { rank: 0 }),
      makeNode(2, { rank: 1 }),
      makeNode(3, { rank: 3, cyclic: true }),
      makeNode(4, { rank: 3, cyclic: true }),
      makeNode(5, { rank: 0 }),
      makeNode(6, { rank: 0 }),
    ];
    const edges: Array<WayfinderEdge> = [
      { from: "t1", to: "t2", kind: "blocks" },
      { from: "t3", to: "t4", kind: "blocks" },
      { from: "t4", to: "t3", kind: "blocks" },
      { from: "t9", to: "t1", kind: "blocks" },
    ];
    const layout = layoutStarMap(buildStarMapGraph({ nodes, edges }));
    expect(layout.positions).toHaveLength(nodes.length);
    for (const position of layout.positions) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
    expect(Number.isFinite(layout.boundingRadius)).toBe(true);
    expect(minPairDistance(layout.positions)).toBeGreaterThanOrEqual(
      STAR_MAP_MIN_SEPARATION - 1e-6,
    );
  });

  it("centers a single node at the origin", () => {
    const layout = layoutStarMap(buildStarMapGraph({ nodes: [makeNode(1)], edges: [] }));
    expect(layout.positions).toEqual([{ id: "t1", x: 0, y: 0 }]);
  });

  it("reports deterministic ordering work instead of wall-clock time", () => {
    const graph = buildStarMapGraph(makeTieredMap([6, 12, 16, 12, 8, 6]));
    const layout = layoutStarMap(graph);
    expect(layout.iterations).toBe(STAR_MAP_ORDERING_SWEEPS);
    expect(layout.pairChecks).toBe(STAR_MAP_ORDERING_SWEEPS * graph.backboneEdges.length * 2);
  });
});
