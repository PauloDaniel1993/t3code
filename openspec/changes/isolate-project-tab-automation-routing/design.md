## Context

`PreviewAutomationBroker` (apps/server/src/mcp/PreviewAutomationBroker.ts) routes MCP preview tool calls to a desktop "automation host" connection. Before `4176d3a0`, selection was:

1. live host **assignment** for the provider session (sticky, one desktop per session) — used if it supports the operation, explicit failure if it does not;
2. otherwise the best **environment-matched** host (most capabilities, focused, most recent).

`4176d3a0` added a `projectTabRoutes` registry (tabId → owning desktop connection) so project-browser tabs — which can be owned by a desktop connection other than the one serving the backing thread's environment — are driven only by their owner. The desktop syncs its routes via `previewAutomationSyncProjectTabs` from `PreviewAutomationHosts.tsx`, in a `useEffect` keyed on `[connectionId, projectTabRoutes]` — i.e. **fire-once, no retry**.

### Defects introduced into the shared path (verified against the code)

- **D-1 Hard dead-end on stale routes** (`invoke`, the `registeredProjectRoute ? undefined` arm): any request with an explicit `tabId` consults the registry first. If a route exists but its connection is dead or replaced, selection returns `undefined` → `PreviewAutomationNoAvailableHostError`, even when a healthy environment-matched host exists. Pre-change, the same request fell through to that host. Dead _assignments_ already fail over ("a dead lease is pruned above and may fail over"); dead routes contradict the same doctrine.
- **D-2 Sync takeover deadlock** (`syncProjectTabs`: `if (existing && existing.queue !== connection.queue) continue`): a route owned by a dead-but-not-yet-finalized connection (renderer remount → new clientId; SSH churn) silently blocks the new owner's sync. Because the client only re-syncs when its route list or connection changes, the skip is never retried — the tab stays routed to a dead queue (requests time out) or, after the old connection finalizes and deletes the route, stays unrouted with nobody re-syncing.
- **D-3 Assignment cross-talk** (`syncProjectTabs` final block): deletes any `HostAssignment` whose `tabId` was previously owned and is no longer routed. Assignments are **normal-flow, provider-session state**; the project-browser sync mutates them by bare tabId equality, regardless of which session or connection they belong to.
- **D-4 Version-skew fragility**: desktops older than the route registry never sync routes; on newer servers, project tabs then have no owner and explicit-tab requests dead-end (D-1 makes this unrecoverable even when a host for the environment is connected).

## Goals / Non-Goals

**Goals:**

- The project-tab registry can only ever _add_ routing ability. With an empty, stale, or missing registry, `invoke` selects hosts exactly as it did before `4176d3a0`.
- Live-owner semantics are preserved: a tab with a live registered owner is driven only by that owner.
- The route lifecycle self-heals: stale owners are pruned on use, and a new owner's sync always wins over a dead one.

**Non-Goals:**

- Changing the wire protocol, contracts, or desktop client (`PreviewAutomationHosts.tsx` stays as-is; the fix must help old desktops too).
- Periodic route re-sync or heartbeats (unnecessary once takeover works).
- Reverting the project-browser feature itself.

## Decisions

### D1: Stale routes are pruned and fall through, never dead-end

In `invoke`, replace the `registeredProjectRoute ? undefined` arm:

- Route exists and owner is **live** → owner-only, as today (including explicit failure if the live owner lacks the operation — that is a real capability error, not a routing accident).
- Route exists but owner is **dead** (connection missing, connectionId/queue mismatch) → delete the route inside the same state update and continue to the pre-change selection (assignment → environment fallback).

_Why not keep the dead-end as "safety"_: the sticky-host rationale (don't jump cookie/DOM state mid-interaction) is enforced by _live_ leases. A dead owner has no state to protect; blocking there converts transient churn into a permanent `NoAvailableHostError`, which is the regression being fixed.

### D2: Sync takeover when the existing owner is not live

In `syncProjectTabs`, keep skipping only when the existing route's connection is live (`clients.get(existing.clientId)` matches its `connectionId` and `queue`). A dead owner's route is replaced by the syncing connection. This makes the one-shot client sync sufficient: whichever order finalizers and reconnects land in, the last live sync wins.

### D3: Sync only touches its own assignments

Scope the assignment-pruning block to assignments held by the syncing connection (`assignment.clientId === connection.clientId && assignment.connectionId === connection.connectionId`) whose tab lost its route. Assignments belonging to other connections are normal-flow state and already self-heal through the liveness filter at the top of `invoke`.

### D4: Regression tests pin the equivalence invariant

New broker tests assert:

- request with explicit tabId + stale route + healthy environment host → routed to the environment host, route removed from state;
- live-owner routing unchanged (still exclusive, still capability-checked);
- remounted client (new clientId, old connection not yet finalized) syncs → takes over the route; requests reach the new connection;
- sync does not delete assignments owned by other connections;
- with an empty registry, selection results match the pre-`4176d3a0` behavior for the assignment and fallback cases (encodes "project browser cannot interfere with the normal flow").

## Risks / Trade-offs

- [Two desktops both claiming a tab after a takeover race] → Takeover requires the existing owner to be dead at sync time; two live owners still follow first-wins, same as today.
- [A dead-looking owner that is actually alive but slow] → Liveness is defined by broker connection state (same definition assignments already use), not timing heuristics; no behavior change for live connections.
- [Pruning routes inside `invoke` adds a write to a read path] → The state update already runs inside `SynchronizedRef.modify` for assignment pruning; route pruning is the same pattern.

## Migration Plan

Server-only, purely behavioral; no data or protocol migration. Old desktops benefit immediately (their explicit-tab requests stop dead-ending). Rollback = revert the commit.

## Open Questions

- Should a live owner lacking the requested operation also fall through instead of failing? Current design says no (capability failure is meaningful); flag if field reports disagree.
