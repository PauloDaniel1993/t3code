## Context

Preview sessions are currently keyed by `ScopedThreadRef`. The server preview manager lists and mutates sessions through a thread id, `previewStateStore` indexes snapshots per thread, and `rightPanelStore` embeds browser surfaces among other thread-owned surfaces. Desktop webviews are leased by tab id and can have only one visible presentation owner at a time. Logical project rows can group physical projects across worktrees or environments and can change when repository grouping settings change.

The requested Project Browser must keep the same live desktop tab visible across thread navigation without converting files, diffs, terminals, plans, or the existing right panel to project scope. Pins are session-only, but per-project layout preferences may remain in local UI state. Correct behavior under navigation, regrouping, concurrent agent operations, and partial session failure is more important than minimizing the number of touched modules.

## Goals / Non-Goals

**Goals:**

- Introduce an independent outer-right Project Browser for the active logical project.
- Transfer live tabs safely between thread and project ownership without cloning webviews.
- Permit every thread in a logical project to automate shared tabs with deterministic per-tab ordering.
- Keep project switching, regrouping, close/unpin, and responsive layout behavior predictable.
- Isolate pure ownership/reconciliation logic from React rendering and keep contract packages schema-only.

**Non-Goals:**

- Mobile or non-desktop browser UI in version one.
- Restoring project tabs after app/server restart.
- Full browser history, cookies, storage, or page-memory persistence.
- Moving non-browser surfaces out of the existing thread right panel.
- A default keyboard chord for the new toggle command.

## Decisions

### 1. Add a separate project-browser domain store

Create a dedicated store keyed by the currently derived logical project key. Each project entry owns ordered tab records, active tab id, open state, width, and a monotonic layout-update sequence used during regrouping. A tab record contains its tab id, origin/backing scoped thread reference, physical origin project key, and transient activity/controller metadata. Browser snapshot truth continues to come from preview state; the project store owns placement and routing, not a duplicate snapshot.

This avoids expanding `rightPanelStore` into mixed thread/project ownership and prevents unrelated surfaces from inheriting project semantics. A single generalized panel store was considered, but would make every current right-panel action carry a scope discriminator and increase regression risk.

Session records are not persisted. Per-project visibility and width use the existing local UI-state persistence pattern and are sanitized against current logical projects. On restart, stale layout preferences may remain, but there are no restored pins.

### 2. Transfer ownership atomically instead of referencing or cloning

Pinning performs one store-level transition: validate that the tab belongs to a thread in the target logical project, remove its browser surface from that thread's right-panel surfaces, insert it into the project's ordered tabs, select it, and open the Project Browser. The desktop tab id and live preview session remain unchanged. Presentation leases naturally move when React unmounts the old `BrowserSurfaceSlot` and mounts the new one.

Unpinning reverses the transition to the recorded origin thread. If that thread is unavailable, the UI offers only confirmed close; it does not silently choose a different thread. Directly created project tabs use the active thread as their backing/origin context so they have the same lifecycle and regrouping rules.

Atomic pure transition helpers will be tested independently. If the server close/open operation fails, local placement rolls back or reconciles from authoritative preview listings rather than leaving duplicate owners.

### 3. Make the desktop client authoritative for logical membership and the server authoritative for physical routing

Logical grouping cannot be authorized by the server because repository grouping mode and per-project overrides are desktop-local client settings. The desktop project-browser store is therefore the authority for whether a requesting `ScopedThreadRef` currently belongs to the same logical project as a shared tab. The server does not claim to validate that client-local relationship.

Extend the preview automation protocol with a transient project-tab route registration owned by the connected desktop automation host. A registration maps a tab id to its owning client connection and backing `ScopedThreadRef`; it contains no durable browser state. The server validates that an explicit project-tab request is routed only to the connected host that registered the tab, then includes both the requesting thread reference and target backing thread reference in the host request. The receiving desktop host recomputes both logical project keys from its current project projection and client grouping settings, rejects non-members before any browser mutation, and performs preview RPC state updates through the backing thread/environment. Promotion, unpin, close, regrouping, disconnect, and reconnect register, update, or remove these routes atomically with project ownership.

This split permits one logical project to span environments without pretending the server knows desktop-local grouping. It is an application invariant rather than a remote security boundary: the connected desktop client owns both the grouping preference and the browser process. Server-side checks still prevent stale or unrelated client connections from claiming another host's registered live tab.

Operations targeting one project tab are chained in arrival order, including navigation and automation actions. The store exposes the active request/controller for UI indication. Existing recording exclusivity remains in force; close asks for confirmation while automation or recording is active, then cancellation/cleanup completes before destruction.

Allowing overlapping last-write-wins actions was rejected as unpredictable. A turn-long exclusive lease was rejected because abandoned turns could strand a tab and manual lock recovery would add significant UX. Replicating all client grouping settings into server state was rejected because it would create a second authority for a local presentation preference and introduce synchronization races during regrouping.

### 4. Define shared-tab discovery and default automation targeting

Add a project-tab discovery response to the desktop automation protocol. For a requesting thread, the desktop host returns only tabs whose current logical owner matches that thread, including tab id, title/URL summary, active state, and backing environment metadata needed for diagnostics. Threads outside the logical project receive no entry for the tab.

Automation target resolution follows a deterministic order:

1. An explicit `tabId` targets exactly that registered tab after client membership validation.
2. Otherwise, an existing provider-session tab assignment is reused so a multi-step interaction does not jump tabs.
3. Otherwise, the active Project Browser tab for the requesting thread's logical project is selected.
4. Otherwise, existing thread-local active-tab/open behavior remains unchanged.

The result of discovery and every successful target-resolving operation returns the selected tab id so subsequent requests can be explicit. Regrouping updates discovery immediately while retaining valid provider-session assignments to the same live tab; the next operation revalidates membership and fails clearly if the requesting thread no longer shares its logical owner.

### 5. Reconcile logical regrouping from physical origin

Every project tab retains the physical project of its origin/backing thread. A pure reconciliation pass derives the current logical key for each tab whenever project grouping inputs change. On a split, a tab moves with its physical origin. On a merge, existing ordered lists combine deterministically using the prior logical row order followed by each row's tab order; tab ids are deduplicated and the first valid active tab is retained.

Layout preferences migrate in the same pass. On split, every resulting logical project inherits the source open state, bounded width, and layout-update sequence. On merge, `isOpen` is true when any source was open; width comes from the source containing the currently active physical project, or otherwise from the source with the greatest layout-update sequence with stable logical-key order as the final tie-breaker. Reconciliation writes the destination records and removes obsolete logical keys so persisted layout state cannot become orphaned.

This follows the user's mental model while ensuring no pin becomes invisible under a stale logical key. Keeping obsolete logical scopes until restart was rejected because controls would no longer correspond to visible projects.

### 6. Compose an outer-right responsive layout

Add Project Browser after the existing thread right panel in the desktop chat layout. `PanelLayoutControls` receives a third adjacent toggle using a visually distinct right-sidebar/browser icon, accessible pressed state, tooltip, tab count badge, and activity indicator. Register a configurable `projectBrowser.toggle` command with no default binding.

The panel renders a horizontal, drag-reorderable tab strip with overflow, direct-new-tab, unpin, and close actions above the existing preview view. It remembers open state and width per project. At the established narrow-layout breakpoint (or a new shared layout query derived from it), it becomes an overlay/sheet so it does not crush the conversation. Pin/create always opens the panel and selects the affected tab.

The third control is capability-gated to the desktop preview bridge. Web and mobile render no nonfunctional control.

### 7. Preserve one hosted browser presentation per tab

Reuse `PreviewView`, `BrowserSurfaceSlot`, hosted webview configuration, recording, annotation, and viewport logic. The new panel supplies the selected project tab id and its backing thread reference. Hidden project tabs remain live runtime sessions but release visible presentation leases. Switching projects unmounts the previous presentation and mounts the selected tab for the next project without closing either session.

## Risks / Trade-offs

- **[Cross-thread control could surprise users]** → Show activity/controller context and serialize operations per tab; confirm close during active work.
- **[The server cannot derive client-local logical grouping]** → Keep logical membership authoritative in the desktop host, register only transient physical routes with the server, and revalidate on every operation.
- **[Client logical grouping is mutable]** → Retain physical origin identity and reconcile through pure, tested grouping helpers on every grouping change.
- **[Implicit automation could jump to an unexpected shared tab]** → Preserve provider-session assignments first, then use the active project tab, and return the resolved tab id from discovery/operations.
- **[Atomic transfer spans multiple stores]** → Centralize transfer commands, validate preconditions, make transitions idempotent, and reconcile against authoritative preview listings after failures/reconnects.
- **[Two right-side panels can consume excessive width]** → Persist bounded widths and use overlay behavior below the responsive threshold.
- **[Runtime-only pins can be mistaken for durable bookmarks]** → Use live-tab language, avoid restore claims, and clear ownership state when preview sessions disappear or the runtime reconnects without them.
- **[Queued automation can grow under load]** → Maintain a bounded per-tab command chain with cancellation on close and explicit failure propagation; do not block unrelated tabs.
- **[Desktop-only behavior can leak into shared clients]** → Gate at the desktop preview capability boundary and keep mobile source untouched.

## Migration Plan

1. Land schemas and pure project-ownership/reconciliation helpers behind capability gating.
2. Add transient project-tab route registration, client-side membership validation, discovery, and target resolution while retaining existing thread-browser behavior as the final fallback.
3. Add store commands and per-tab operation serialization.
4. Add Project Browser rendering and the third control; enable promotion/direct creation only when the desktop bridge is available.
5. Verify same- and cross-environment project navigation, grouping changes, discovery, implicit/explicit targeting, reconnect cleanup, concurrency, recording, and responsive layout.
6. Rollback is removal of the gated UI, transient route registry, and project store/routing additions; existing thread preview sessions and right-panel state require no data migration.

## Open Questions

None. Product decisions were resolved during the proposal interview.
