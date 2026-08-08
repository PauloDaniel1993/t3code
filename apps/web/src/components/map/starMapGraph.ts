import type { WayfinderEdge, WayfinderMap, WayfinderNode } from "@t3tools/contracts";

/**
 * Deterministic 32-bit FNV-1a hash. Used both for the graph content revision
 * and as the per-ticket layout seed, so it must never incorporate input
 * ordering, iteration state, or anything besides its argument.
 */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export type StarMapGraphNode = WayfinderNode;
export type StarMapGraphEdge = WayfinderEdge;
export type StarMapNodeStatus = WayfinderNode["status"];

/**
 * Completion comes from the map's full counts, not its rendered node slice:
 * large maps may be truncated, and every visible ticket being terminal does
 * not prove the omitted tickets are terminal too.
 */
export function isWayfinderMapComplete(map: Pick<WayfinderMap, "counts">): boolean {
  const { counts } = map;
  return (
    counts.total > 0 &&
    counts.open === 0 &&
    counts.claimed === 0 &&
    counts.resolved + counts.outOfScope === counts.total
  );
}

export interface StarMapAdjacency {
  readonly blocks: ReadonlyArray<StarMapGraphEdge>;
  readonly undermines: ReadonlyArray<StarMapGraphEdge>;
}

/**
 * Render-side view of one wayfinder map. Status, frontier/undermined flags,
 * Kahn rank, and cycle flags arrive authoritative from the server and are
 * consumed as-is; this module only reorders and indexes them. Everything here
 * is sorted or keyed so downstream modules see identical structures no matter
 * how the snapshot arrays were ordered.
 */
export interface StarMapGraph {
  /** Nodes sorted by (ordinal, id), duplicate ids dropped. */
  readonly nodes: ReadonlyArray<StarMapGraphNode>;
  readonly nodeById: ReadonlyMap<string, StarMapGraphNode>;
  /** Edges sorted by (from, to, kind); dangling endpoints dropped. */
  readonly edges: ReadonlyArray<StarMapGraphEdge>;
  /** Edges whose `to` is the key node, split by kind. Every node has an entry. */
  readonly incoming: ReadonlyMap<string, StarMapAdjacency>;
  /** Edges whose `from` is the key node, split by kind. Every node has an entry. */
  readonly outgoing: ReadonlyMap<string, StarMapAdjacency>;
  /** Node ids per status, in the same (ordinal, id) order as `nodes`. */
  readonly byStatus: Readonly<Record<StarMapNodeStatus, ReadonlyArray<string>>>;
  readonly maxRank: number;
  /**
   * Stable content revision covering exactly the layout solver inputs: node
   * ids, ordinals (the per-ticket seed), ranks, cycle flags, and the edge set.
   * Status, labels, and frontier flags change how a star looks, never where it
   * sits, so they stay out of the revision — a ticket resolving must not
   * re-run the solver. Key a `useMemo` on this string.
   */
  readonly revision: string;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNodes(left: StarMapGraphNode, right: StarMapGraphNode): number {
  return left.ordinal - right.ordinal || compareStrings(left.id, right.id);
}

export function buildStarMapGraph(map: Pick<WayfinderMap, "nodes" | "edges">): StarMapGraph {
  const nodes: Array<StarMapGraphNode> = [];
  const nodeById = new Map<string, StarMapGraphNode>();
  for (const node of [...map.nodes].sort(compareNodes)) {
    if (nodeById.has(node.id)) continue;
    nodeById.set(node.id, node);
    nodes.push(node);
  }

  const seenEdgeKeys = new Set<string>();
  const edges: Array<StarMapGraphEdge> = [];
  for (const edge of map.edges) {
    // A dangling edge would render as a line to nowhere; the server already
    // drops unresolvable blockers, and this keeps that guarantee local.
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    const key = `${edge.from}\n${edge.to}\n${edge.kind}`;
    if (seenEdgeKeys.has(key)) continue;
    seenEdgeKeys.add(key);
    edges.push(edge);
  }
  edges.sort(
    (left, right) =>
      compareStrings(left.from, right.from) ||
      compareStrings(left.to, right.to) ||
      compareStrings(left.kind, right.kind),
  );

  const incoming = new Map<
    string,
    { blocks: Array<StarMapGraphEdge>; undermines: Array<StarMapGraphEdge> }
  >();
  const outgoing = new Map<
    string,
    { blocks: Array<StarMapGraphEdge>; undermines: Array<StarMapGraphEdge> }
  >();
  for (const node of nodes) {
    incoming.set(node.id, { blocks: [], undermines: [] });
    outgoing.set(node.id, { blocks: [], undermines: [] });
  }
  for (const edge of edges) {
    incoming.get(edge.to)![edge.kind].push(edge);
    outgoing.get(edge.from)![edge.kind].push(edge);
  }

  const byStatus: Record<StarMapNodeStatus, Array<string>> = {
    open: [],
    claimed: [],
    resolved: [],
    out_of_scope: [],
  };
  let maxRank = 0;
  for (const node of nodes) {
    byStatus[node.status].push(node.id);
    maxRank = Math.max(maxRank, node.rank);
  }

  const revisionParts: Array<string> = [];
  for (const node of nodes) {
    revisionParts.push(node.id, String(node.ordinal), String(node.rank), node.cyclic ? "1" : "0");
  }
  for (const edge of edges) {
    revisionParts.push(edge.from, edge.to, edge.kind);
  }
  const revision = `${nodes.length}:${edges.length}:${hash32(revisionParts.join("\n")).toString(36)}`;

  return { nodes, nodeById, edges, incoming, outgoing, byStatus, maxRank, revision };
}
