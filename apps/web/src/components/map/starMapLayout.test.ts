import type { WayfinderEdge, WayfinderNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildStarMapGraph, hash32 } from "./starMapGraph";
import {
  layoutStarMap,
  STAR_MAP_MIN_SEPARATION,
  STAR_MAP_RELAXATION_ITERATIONS,
  STAR_MAP_SEPARATION_ITERATIONS,
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

/** Rank monotonicity: fraction of same-direction "blocks" edges along which
 * the dependent (higher-rank) node sits at least as far from the origin. */
function rankMonotonicityFraction(
  edges: ReadonlyArray<WayfinderEdge>,
  graph: ReturnType<typeof buildStarMapGraph>,
  positions: ReadonlyArray<StarMapPosition>,
): { monotone: number; total: number } {
  const radiusById = new Map(positions.map((p) => [p.id, Math.hypot(p.x, p.y)]));
  let monotone = 0;
  let total = 0;
  for (const edge of edges) {
    if (edge.kind !== "blocks") continue;
    const from = graph.nodeById.get(edge.from)!;
    const to = graph.nodeById.get(edge.to)!;
    if (to.rank <= from.rank) continue;
    total += 1;
    if (radiusById.get(edge.to)! >= radiusById.get(edge.from)! - 1e-9) monotone += 1;
  }
  return { monotone, total };
}

describe("layoutStarMap", () => {
  it("returns an empty layout for an empty map", () => {
    const layout = layoutStarMap(buildStarMapGraph({ nodes: [], edges: [] }));
    expect(layout.positions).toEqual([]);
    expect(layout.boundingRadius).toBe(0);
    expect(layout.iterations).toBe(0);
    expect(layout.pairChecks).toBe(0);
  });

  it("is deterministic: two runs deep-equal", () => {
    const map = makeTieredMap([6, 12, 16, 12, 8, 6]);
    const graph = buildStarMapGraph(map);
    const first = layoutStarMap(graph);
    const second = layoutStarMap(graph);
    expect(second.positions).toEqual(first.positions);
    expect(second.pairChecks).toBe(first.pairChecks);
  });

  it("is order-independent: shuffled input yields identical output", () => {
    const map = makeTieredMap([6, 12, 16, 12, 8, 6]);
    const reference = layoutStarMap(buildStarMapGraph(map));

    const reversed = layoutStarMap(
      buildStarMapGraph({ nodes: map.nodes.toReversed(), edges: map.edges.toReversed() }),
    );
    expect(reversed.positions).toEqual(reference.positions);

    const rotatedNodes = [...map.nodes.slice(17), ...map.nodes.slice(0, 17)];
    const rotatedEdges = [...map.edges.slice(11), ...map.edges.slice(0, 11)];
    const rotated = layoutStarMap(buildStarMapGraph({ nodes: rotatedNodes, edges: rotatedEdges }));
    expect(rotated.positions).toEqual(reference.positions);
  });

  it("keeps spatial memory: one added leaf moves existing nodes less than 2% of the bounding radius", () => {
    const base = makeTieredMap([4, 6, 6, 4]);
    const baseLayout = layoutStarMap(buildStarMapGraph(base));

    const firstRankOneId = base.nodes.find((node) => node.rank === 1)!.id;
    const leaf = makeNode(99, { rank: 2 });
    const grown = {
      nodes: [...base.nodes, leaf],
      edges: [...base.edges, { from: firstRankOneId, to: leaf.id, kind: "blocks" as const }],
    };
    const grownLayout = layoutStarMap(buildStarMapGraph(grown));

    let worstDisplacement = 0;
    let worstNodeId = "";
    for (const position of baseLayout.positions) {
      const moved = grownLayout.positionById.get(position.id)!;
      const displacement = Math.hypot(moved.x - position.x, moved.y - position.y);
      if (displacement > worstDisplacement) {
        worstDisplacement = displacement;
        worstNodeId = position.id;
      }
    }
    const worstPercent = (worstDisplacement / grownLayout.boundingRadius) * 100;
    console.info(
      `[star-map metrics] stability: worst displacement ${worstDisplacement.toFixed(3)} units ` +
        `(${worstPercent.toFixed(4)}% of bounding radius ${grownLayout.boundingRadius.toFixed(1)}) at ${worstNodeId}`,
    );
    expect(worstDisplacement).toBeLessThan(grownLayout.boundingRadius * 0.02);
  });

  it("keeps rank monotonicity across at least 90% of blocks edges", () => {
    const map = makeTieredMap([6, 12, 16, 12, 8, 6]);
    const graph = buildStarMapGraph(map);
    const layout = layoutStarMap(graph);
    const { monotone, total } = rankMonotonicityFraction(map.edges, graph, layout.positions);
    console.info(
      `[star-map metrics] rank monotonicity: ${monotone}/${total} (${((monotone / total) * 100).toFixed(2)}%)`,
    );
    expect(total).toBeGreaterThan(0);
    expect(monotone / total).toBeGreaterThanOrEqual(0.9);
  });

  it("guarantees minimum pairwise separation", () => {
    const fixtures: Record<string, { nodes: Array<WayfinderNode>; edges: Array<WayfinderEdge> }> = {
      "sixty-node tiered map": makeTieredMap([6, 12, 16, 12, 8, 6]),
      "two-hundred-node cap stress": makeTieredMap([8, 24, 48, 60, 40, 20]),
      "forty-node single-rank crowd": makeTieredMap([40]),
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
  });

  it("produces finite positions for cyclic nodes, isolated nodes, and dropped edges", () => {
    const nodes = [
      makeNode(1, { rank: 0 }),
      makeNode(2, { rank: 1 }),
      makeNode(3, { rank: 3, cyclic: true }),
      makeNode(4, { rank: 3, cyclic: true }),
      makeNode(5, { rank: 0 }), // isolated
      makeNode(6, { rank: 0 }), // isolated
    ];
    const edges: Array<WayfinderEdge> = [
      { from: "t1", to: "t2", kind: "blocks" },
      { from: "t3", to: "t4", kind: "blocks" }, // cycle pair
      { from: "t4", to: "t3", kind: "blocks" },
      { from: "t9", to: "t1", kind: "blocks" }, // dangling, dropped by the graph
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

  it("settles a single node at its seeded anchor", () => {
    const layout = layoutStarMap(buildStarMapGraph({ nodes: [makeNode(1)], edges: [] }));
    expect(layout.positions).toHaveLength(1);
    // With no pairs and no edges, the anchor pull is the only force: the node
    // converges to its hash-seeded anchor on the rank-0 ring.
    const seed = hash32("1");
    const angle = ((seed & 0xffff) / 0x10000) * Math.PI * 2;
    expect(layout.positions[0]!.x).toBeCloseTo(Math.cos(angle) * 60, 6);
    expect(layout.positions[0]!.y).toBeCloseTo(Math.sin(angle) * 60, 6);
  });

  it("reports iteration and pair-check counts instead of wall-clock time", () => {
    const map = makeTieredMap([6, 12, 16, 12, 8, 6]);
    const nodeCount = map.nodes.length;
    expect(nodeCount).toBe(60);
    const layout = layoutStarMap(buildStarMapGraph(map));
    expect(layout.iterations).toBe(STAR_MAP_RELAXATION_ITERATIONS);
    const pairCount = (nodeCount * (nodeCount - 1)) / 2;
    const expectedPairChecks =
      (STAR_MAP_RELAXATION_ITERATIONS + STAR_MAP_SEPARATION_ITERATIONS) * pairCount;
    console.info(
      `[star-map metrics] 60 nodes: iterations=${layout.iterations}, pairChecks=${layout.pairChecks}`,
    );
    expect(layout.pairChecks).toBe(expectedPairChecks);
  });
});
