import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";

/** Keep on-page graph records plus actionable work and ancestor dependencies. */
export function retainProviderHistoryGraph(
  projection: OrchestrationV2ThreadProjection,
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ThreadProjection {
  const active = (status: string | undefined) =>
    status === undefined ||
    status === "queued" ||
    status === "preparing" ||
    status === "pending" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting";
  const nodeIds = new Set<string>();
  const providerTurnIds = new Set<string>();
  const requestIds = new Set<string>();
  const checkpointIds = new Set<string>();
  for (const { item } of visible) {
    if (item.nodeId != null) nodeIds.add(item.nodeId);
    if (item.providerTurnId != null) providerTurnIds.add(item.providerTurnId);
    if ("runtimeRequestId" in item) requestIds.add(String(item.runtimeRequestId));
    if ("checkpointId" in item) checkpointIds.add(String(item.checkpointId));
  }
  for (const node of projection.nodes) if (active(node.status)) nodeIds.add(node.id);
  for (const run of projection.runs) if (run.rootNodeId != null) nodeIds.add(run.rootNodeId);
  for (const attempt of projection.attempts)
    if (attempt.rootNodeId != null) nodeIds.add(attempt.rootNodeId);
  for (const request of projection.runtimeRequests)
    if (active(request.status) && request.nodeId !== null) nodeIds.add(request.nodeId);
  for (const turn of projection.providerTurns)
    if (active(turn.status) && turn.nodeId !== null) nodeIds.add(turn.nodeId);
  for (const subagent of projection.subagents)
    if (active(subagent.status)) {
      nodeIds.add(subagent.id);
      nodeIds.add(subagent.parentNodeId);
    }
  const byId = new Map(projection.nodes.map((node) => [String(node.id), node]));
  const work = [...nodeIds];
  for (let i = 0; i < work.length; i++) {
    const node = byId.get(work[i]!);
    for (const id of [node?.parentNodeId, node?.rootNodeId]) {
      if (id != null && !nodeIds.has(id)) {
        nodeIds.add(id);
        work.push(id);
      }
    }
  }
  const nodes = projection.nodes.filter((node) => nodeIds.has(node.id));
  for (const node of nodes) {
    if (node.providerTurnId !== null) providerTurnIds.add(node.providerTurnId);
    if (node.runtimeRequestId !== null) requestIds.add(node.runtimeRequestId);
  }
  const scopeIds = new Set(
    nodes.flatMap((node) =>
      node.checkpointScopeId === null ? [] : [String(node.checkpointScopeId)],
    ),
  );
  const scopes = new Map(projection.checkpointScopes.map((scope) => [String(scope.id), scope]));
  for (const scope of projection.checkpointScopes)
    if (nodeIds.has(scope.nodeId)) scopeIds.add(scope.id);
  const scopeWork = [...scopeIds];
  for (let i = 0; i < scopeWork.length; i++) {
    const parent = scopes.get(scopeWork[i]!)?.parentScopeId;
    if (parent != null && !scopeIds.has(parent)) {
      scopeIds.add(parent);
      scopeWork.push(parent);
    }
  }
  return {
    ...projection,
    nodes,
    subagents: projection.subagents.filter(
      (subagent) => active(subagent.status) || nodeIds.has(subagent.id),
    ),
    providerTurns: projection.providerTurns.filter(
      (turn) => active(turn.status) || providerTurnIds.has(turn.id),
    ),
    runtimeRequests: projection.runtimeRequests.filter(
      (request) => active(request.status) || requestIds.has(request.id),
    ),
    checkpointScopes: projection.checkpointScopes.filter((scope) => scopeIds.has(scope.id)),
    checkpoints: projection.checkpoints.filter(
      (checkpoint) => checkpointIds.has(checkpoint.id) || scopeIds.has(checkpoint.scopeId),
    ),
  };
}
