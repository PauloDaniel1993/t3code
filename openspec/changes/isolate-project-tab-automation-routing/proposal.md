## Why

Since `4176d3a0` ("route project-tab automation to owning desktop host", July 13), preview automation requests keep failing with `PreviewAutomationNoAvailableHostError` in situations that worked before — reported against SSH-remote sessions where Codex can no longer control a visible Browser tab. The commit inserted project-tab route lookups _into_ the shared host-selection path of `PreviewAutomationBroker.invoke`, so registry state (stale routes, skipped syncs, version-skewed desktops that never register routes) now blocks requests that previously fell back to a healthy environment-matched desktop host. The project browser must not be able to break the normal preview-tab flow.

## What Changes

- Restore the pre-July-13 host-selection behavior for every request whose target is not a **live** project-tab route: a stale or dead route is pruned and the request falls through to the original assignment → environment-host selection instead of dead-ending.
- Keep owner-only routing as a strictly additive path: a request targeting a tab with a live registered owner still goes only to that owner (no silent host jumping between Electron cookie/DOM states).
- Fix the route-sync takeover deadlock: `syncProjectTabs` currently skips a route when a different connection's route exists, even if that connection is dead — and the desktop client only re-syncs on route/connection changes, so the skip is permanent. Allow takeover when the existing owner is no longer live.
- Stop project-tab sync from mutating normal-flow state: it currently deletes host assignments by bare tabId match, which can clear provider-session assignments it does not own.
- Add regression coverage pinning the invariant: with an empty or stale project-tab registry, `invoke` behaves byte-identically to the pre-July-13 selection logic.

## Capabilities

### New Capabilities

- `preview-automation-routing`: Host selection for preview automation requests — normal-flow fallback guarantees, additive project-tab owner routing, and self-healing route lifecycle (sync takeover, stale-route pruning).

### Modified Capabilities

None. (No existing main spec covers preview automation; this change specifies the routing behavior introduced ad hoc by `4176d3a0`.)

## Impact

- `apps/server/src/mcp/PreviewAutomationBroker.ts` — connection selection in `invoke`, `syncProjectTabs` takeover rules, assignment pruning scope.
- `apps/server/src/mcp/PreviewAutomationBroker.test.ts` — new regression tests; existing route tests updated where behavior is deliberately relaxed.
- No contract, client, or desktop changes: the fix is server-side and works with both current and older (pre-route-registry) desktop builds, which matters for mixed-version SSH setups.
