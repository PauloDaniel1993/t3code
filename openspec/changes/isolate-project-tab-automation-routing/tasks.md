## 1. Broker routing fixes

- [ ] 1.1 In `PreviewAutomationBroker.invoke`, replace the stale-route dead-end: when `registeredProjectRoute` exists but its connection is not live, delete the route inside the same `SynchronizedRef.modify` and continue to the pre-registry selection (assignment → environment fallback). Keep exclusive routing and the capability failure for live owners (design D1).
- [ ] 1.2 In `syncProjectTabs`, allow route takeover when the existing route's connection is no longer live (clientId/connectionId/queue no longer match a registered client); keep first-wins for live owners (design D2).
- [ ] 1.3 Scope the assignment-pruning block in `syncProjectTabs` to assignments owned by the syncing connection only (design D3).

## 2. Tests

- [ ] 2.1 Broker test: explicit-tabId request with a stale route and a healthy environment host is dispatched to the environment host and the stale route is removed.
- [ ] 2.2 Broker test: live-owner exclusivity and capability failure are unchanged; a second live connection cannot displace an existing live route via sync.
- [ ] 2.3 Broker test: remounted client (new clientId, previous connection still in state) syncs and takes over the route; requests reach the new connection.
- [ ] 2.4 Broker test: sync leaves assignments owned by other connections untouched.
- [ ] 2.5 Regression test encoding the equivalence invariant: with an empty registry, selection matches pre-registry behavior for the assignment-hit, assignment-capability-failure, and environment-fallback cases.

## 3. Verification

- [ ] 3.1 Run `pnpm vp test run src/mcp` and `pnpm typecheck` in `apps/server`; fix fallout.
- [ ] 3.2 Live check with the dev instance: drive a normal preview tab via the MCP tools, then simulate a stale route (reconnect the desktop client) and confirm tab control recovers instead of returning `PreviewAutomationNoAvailableHostError`.
