## ADDED Requirements

### Requirement: Provide a desktop project browser sidebar

The desktop application SHALL provide an independent Project Browser sidebar at the extreme right of the layout for the active logical sidebar project. The Project Browser MUST NOT replace or change the ownership of the existing thread-scoped right panel or its non-browser surfaces. Clients without the desktop preview capability MUST NOT show a nonfunctional Project Browser control.

#### Scenario: Open the Project Browser for a project

- **WHEN** a user activates the Project Browser while a logical project is active in the desktop app
- **THEN** the system shows that project's Project Browser outside the existing thread right panel

#### Scenario: Use the existing right panel concurrently

- **WHEN** the Project Browser and the thread right panel are both open
- **THEN** the system renders them as independent surfaces and keeps files, diffs, terminals, plans, and thread browser tabs owned by the thread panel

#### Scenario: Unsupported client

- **WHEN** a client does not expose the desktop preview capability
- **THEN** the system does not render the Project Browser toggle or panel

### Requirement: Expose a third project-browser layout control

The system SHALL add a Project Browser toggle beside the existing layout controls. The control SHALL expose accessible name and pressed state, the number of live tabs for the active project, and whether project-browser activity is in progress. The system SHALL register a configurable Project Browser toggle command without assigning a default shortcut.

#### Scenario: Toggle from the header control

- **WHEN** the user activates the third layout-control icon
- **THEN** the system toggles the Project Browser for the active logical project and updates its pressed state

#### Scenario: Closed panel has live tabs

- **WHEN** the active project's Project Browser is closed and contains live tabs or activity
- **THEN** the control shows the tab count and activity state without opening the panel

#### Scenario: Configure keyboard access

- **WHEN** the user assigns a shortcut to the Project Browser toggle command
- **THEN** the assigned shortcut toggles the active project's Project Browser

### Requirement: Own multiple live tabs at logical-project scope

The Project Browser SHALL own multiple live browser tabs for one logical sidebar project and SHALL retain one active tab and a stable user-defined order. The same project tabs SHALL remain available while navigating among every thread in that logical project. Project pins MUST be session-only and MUST NOT be restored after an app or server restart.

#### Scenario: Navigate between project threads

- **WHEN** the user moves from one thread to another thread in the same logical project
- **THEN** the Project Browser retains the same ordered live tabs and active selection

#### Scenario: Switch logical projects

- **WHEN** the user navigates to a thread in a different logical project
- **THEN** the Project Browser swaps to the destination project's open state, width, ordered tabs, and active selection without closing the previous project's live tabs

#### Scenario: Restart the runtime

- **WHEN** the desktop app or preview server restarts
- **THEN** prior project-owned live tabs are absent and the system does not recreate them from their last URLs

### Requirement: Promote a thread tab into project ownership

The system SHALL allow a user to pin an existing thread browser tab to its logical project. Pinning SHALL transfer the same live tab id and browser session into the Project Browser, remove its surface from the origin thread right panel, record the origin thread and physical project, select the tab, and open the Project Browser. The system MUST NOT clone the browser instance or leave simultaneous thread and project owners.

#### Scenario: Pin a thread browser tab

- **WHEN** the user pins a live browser tab from a thread right panel
- **THEN** the same live session appears selected in the open Project Browser and no longer appears among that thread's right-panel surfaces

#### Scenario: Pin transition fails

- **WHEN** promotion cannot complete or authoritative preview state rejects the transition
- **THEN** the system preserves or restores one valid owner and does not display duplicate or ownerless tab surfaces

### Requirement: Create a project tab directly

The Project Browser SHALL allow a user to create a new project-owned live browser tab directly. The system SHALL use the active thread as the tab's backing origin context, select the new tab, and open the Project Browser.

#### Scenario: Create from the Project Browser

- **WHEN** the user invokes the new-tab action while a project thread is active
- **THEN** the system creates one live tab owned by the logical project with the active thread recorded as its origin

#### Scenario: No active project thread

- **WHEN** no valid active thread exists for the logical project
- **THEN** direct tab creation is unavailable and the system does not create an ownerless preview session

### Requirement: Unpin to the origin thread

The system SHALL return an unpinned project tab to its recorded origin thread while preserving the same live session. If the origin thread no longer exists or cannot receive the tab, the system MUST keep the tab project-owned unless the user confirms closing it.

#### Scenario: Unpin with an available origin

- **WHEN** the user unpins a project tab whose origin thread is available
- **THEN** the same live tab moves to the origin thread right panel and is removed from the Project Browser

#### Scenario: Unpin with a missing origin

- **WHEN** the user unpins a project tab whose origin thread is unavailable
- **THEN** the system offers a confirmation to close the tab and otherwise leaves the live tab pinned

### Requirement: Share automation access across project threads

Every thread in the owning logical project SHALL be permitted to target the project's shared browser tabs, including when the logical project contains physical projects from different environments. The connected desktop client SHALL be authoritative for logical-project membership because grouping settings are client-local. The desktop automation host MUST recompute membership from its current project projection and grouping settings before every operation and MUST reject a requesting thread outside the owning logical project before changing the tab. The server SHALL route an explicit project-tab request only to the connected desktop host that transiently registered that tab and SHALL address preview state through the tab's backing thread and environment. Automation and navigation operations SHALL execute in arrival order per tab, while operations for different tabs MAY proceed independently. The UI SHALL expose current tab activity and controlling-thread context.

#### Scenario: Project thread controls a shared tab

- **WHEN** an agent in any thread of the owning logical project targets a project browser tab
- **THEN** the system routes the operation to the shared live session and shows its activity context

#### Scenario: Unrelated thread targets a shared tab

- **WHEN** a thread outside the owning logical project targets the tab
- **THEN** the desktop automation host rejects the operation before changing the tab even if the caller knows its tab id

#### Scenario: Project members span environments

- **WHEN** a requesting thread and the project tab's backing thread are in different environments but resolve to the same logical project
- **THEN** the owning desktop host accepts the request and performs preview state updates through the tab's backing environment and thread

#### Scenario: Stale route targets a disconnected owner

- **WHEN** the server receives a project-tab request whose registered owning desktop connection is no longer live
- **THEN** the server removes the stale route and fails the request without routing it to another client

#### Scenario: Concurrent operations target one tab

- **WHEN** multiple project threads submit operations to the same shared tab concurrently
- **THEN** the system executes those operations in arrival order and reports individual failures to their callers

#### Scenario: Operations target different tabs

- **WHEN** project threads submit operations to different shared tabs
- **THEN** one tab's operation queue does not block the other tab's operation queue

### Requirement: Discover and resolve project automation targets

The system SHALL let an agent discover the shared browser tabs available to its current thread. Discovery SHALL return only tabs in the requesting thread's current logical project and SHALL identify each tab by tab id with sufficient title, URL, active-state, and backing-environment metadata for selection and diagnostics. Automation target resolution SHALL prefer an explicit tab id, then an existing provider-session tab assignment, then the active Project Browser tab for the requesting thread's logical project, and finally the existing thread-local preview behavior. Discovery and successful target-resolving operations SHALL return the resolved tab id.

#### Scenario: Discover shared project tabs

- **WHEN** an agent lists browser targets from a thread in a logical project with shared tabs
- **THEN** the result contains every current shared tab for that logical project and no tab owned by another logical project

#### Scenario: Explicit shared-tab target

- **WHEN** an agent supplies the id of a shared tab available to its thread
- **THEN** the system targets exactly that tab through its registered backing thread and returns the same tab id

#### Scenario: Reuse an assigned tab

- **WHEN** an agent omits `tabId` and its provider session already has a valid live-tab assignment
- **THEN** the system reuses that assignment instead of switching to another active project or thread tab

#### Scenario: Default to the active project tab

- **WHEN** an agent omits `tabId`, has no valid provider-session assignment, and its logical project has an active shared tab
- **THEN** the system targets the active shared tab and returns its tab id

#### Scenario: Fall back to thread-local behavior

- **WHEN** an agent omits `tabId`, has no valid provider-session assignment, and its logical project has no active shared tab
- **THEN** the system preserves the existing thread-local target selection or tab-creation behavior

#### Scenario: Regrouping invalidates access

- **WHEN** a provider-session assignment still references a live shared tab but current grouping no longer places the requesting thread with that tab
- **THEN** the system rejects the operation, clears that invalid assignment, and requires discovery or normal target resolution for the new project scope

### Requirement: Reconcile pins when project grouping changes

The system SHALL retain the physical origin project for every project-owned tab and SHALL recompute its logical owner when repository grouping settings change. On a split, each tab SHALL follow its physical origin project and each resulting logical project SHALL inherit the source open state and bounded width. On a merge, the system SHALL combine tab lists in stable prior project and tab order, deduplicate tab ids, retain a valid active selection, set the merged panel open when any source was open, and select width from the source containing the active physical project. If no active physical project identifies a source, width SHALL come from the most recently updated source layout with stable logical-key order as the tie-breaker. The system MUST remove obsolete logical-key tab, routing, and layout records after reconciliation.

#### Scenario: Grouped project splits

- **WHEN** a grouping change separates physical projects that previously formed one logical project
- **THEN** each live tab appears under the new logical project containing its physical origin and every resulting project inherits the prior open state and bounded width

#### Scenario: Projects merge

- **WHEN** a grouping change combines logical projects that each contain live tabs
- **THEN** the merged Project Browser contains every unique tab in deterministic stable order with one valid active tab, is open when any source was open, and uses the deterministic source width rule

#### Scenario: Regrouping removes obsolete state

- **WHEN** split or merge reconciliation completes
- **THEN** obsolete logical project keys no longer retain project-tab routes or persisted layout records

### Requirement: Provide responsive project-scoped layout state

The system SHALL remember Project Browser open state and a bounded width per logical project. Pinning or directly creating a tab SHALL open the panel and select that tab. On narrow desktop layouts, the panel SHALL present as an overlay rather than shrinking the conversation below its supported minimum.

#### Scenario: Restore project layout state

- **WHEN** the user returns to a logical project during the same or a later client session
- **THEN** the system restores that project's last valid open state and bounded panel width independently of its runtime-only tab list

#### Scenario: Pin while closed

- **WHEN** the user pins or directly creates a project tab while that project's Project Browser is closed
- **THEN** the system opens the panel and selects the affected tab

#### Scenario: Narrow layout

- **WHEN** the available desktop width crosses the project-browser overlay breakpoint
- **THEN** the Project Browser overlays the content and does not compress the conversation below its minimum width

### Requirement: Provide project tab controls

The Project Browser SHALL render its tabs in a horizontal selector with favicon/title, active state, overflow access, drag reordering, direct creation, unpin, and close actions. Closing an idle tab SHALL close it immediately. Closing a tab with active automation or recording MUST require confirmation and MUST complete cancellation and cleanup before destroying the session.

#### Scenario: Reorder project tabs

- **WHEN** the user drags a project tab to a new position
- **THEN** the system preserves the new order while navigating among threads in that project

#### Scenario: Select an overflowed tab

- **WHEN** the horizontal strip cannot display every project tab
- **THEN** the user can access and select every hidden tab through scrolling or an overflow control

#### Scenario: Close an idle project tab

- **WHEN** the user closes a project tab with no active automation or recording
- **THEN** the system closes its live session immediately and selects a deterministic neighboring tab when one exists

#### Scenario: Close an active project tab

- **WHEN** the user attempts to close a tab with active automation or recording
- **THEN** the system identifies the active work, requires confirmation, cancels and cleans it up after confirmation, and only then closes the live session

### Requirement: Reconcile missing and disconnected preview sessions

The Project Browser SHALL reconcile its ownership records against authoritative preview session listings after close events, reconnects, and partial failures. Tabs absent from authoritative runtime state MUST be removed from project ownership, active selection MUST fall back deterministically, and desktop presentation leases MUST be released.

#### Scenario: Shared session disappears

- **WHEN** an authoritative preview update no longer contains a project-owned tab
- **THEN** the system removes the stale pin, releases its presentation, and selects the nearest remaining tab or an empty state

#### Scenario: Reconnect returns a partial session list

- **WHEN** the client reconnects and only some previously known project tabs still exist
- **THEN** the system retains only authoritative live tabs without duplicating or recreating missing sessions
