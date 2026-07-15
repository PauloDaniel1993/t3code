# preview-automation-routing Specification

## ADDED Requirements

### Requirement: Project-tab routing is strictly additive to normal host selection

The preview automation broker SHALL select hosts for requests without a live project-tab route using only provider-session assignments and environment-matched hosts, identically to the selection behavior that existed before the project-tab route registry. Registry state that is empty, missing, or stale SHALL NOT cause a request to fail that would have succeeded under that selection.

#### Scenario: Stale route falls back to a healthy environment host

- **WHEN** a request targets a tabId whose registered route points at a disconnected or replaced connection, and a live host for the request's environment is connected
- **THEN** the broker removes the stale route and dispatches the request to the environment-matched host instead of failing with `PreviewAutomationNoAvailableHostError`

#### Scenario: Empty registry preserves pre-registry behavior

- **WHEN** the project-tab route registry is empty
- **THEN** host selection for any request (with or without an explicit tabId) yields the same host as the pre-registry selection logic (live assignment first, then best environment-matched host)

### Requirement: Live project-tab owners route exclusively

The broker SHALL dispatch a request targeting a tab with a **live** registered owner only to that owner. If the live owner does not support the requested operation, the request SHALL fail with a capability error rather than moving to another host.

#### Scenario: Live owner receives the request

- **WHEN** a request targets a tabId whose registered route points at a live connection that supports the operation
- **THEN** the request is dispatched to that connection even if other environment-matched hosts exist

### Requirement: Route sync takes over from dead owners

`syncProjectTabs` SHALL replace a registered route whose owning connection is no longer live with the syncing connection's route. It SHALL continue to reject takeover attempts against a live owner.

#### Scenario: Remounted client reclaims its tab

- **WHEN** a desktop client reconnects with a new clientId while the previous connection's route still exists but that connection is no longer registered as live, and the new client syncs a route for the same tabId
- **THEN** the registry maps the tab to the new connection and subsequent requests reach it

#### Scenario: Live owner is not displaced

- **WHEN** a second live connection syncs a route for a tabId already owned by a different live connection
- **THEN** the existing route is kept unchanged

### Requirement: Route sync does not mutate other connections' assignments

`syncProjectTabs` SHALL only remove host assignments that belong to the syncing connection. Assignments held by other clients or provider sessions SHALL be left untouched regardless of tabId overlap.

#### Scenario: Unrelated assignment survives a sync

- **WHEN** a connection syncs routes and a host assignment owned by a different connection references a tabId that lost its route
- **THEN** that assignment remains in place and continues to be validated only by the existing liveness rules
