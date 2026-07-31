## ADDED Requirements

### Requirement: Drop persisted right-panel surfaces of unknown kind

The right-panel persistence migration SHALL drop any persisted surface whose `kind` is not a member of the declared right-panel kind allowlist. The migration MUST NOT rely on a persisted version number to decide this, because the migration function does not receive one. Surfaces of known kinds MUST continue to migrate unchanged.

#### Scenario: Persisted state contains an unknown surface kind

- **WHEN** persisted right-panel state contains a surface whose `kind` is not in the allowlist
- **THEN** the migration removes that surface and retains the remaining surfaces

#### Scenario: Unknown surface was the active surface

- **WHEN** the dropped surface was the persisted active surface for a thread
- **THEN** the migration leaves that thread with a valid active surface or none, and never a reference to a removed surface

#### Scenario: Known surfaces are preserved

- **WHEN** persisted state contains only surfaces of known kinds
- **THEN** the migration preserves them and their ordering

### Requirement: Provide a singleton map surface in the right panel

The system SHALL add a single right-panel surface of kind `map` with a fixed identifier, alongside the existing singleton diff, files, and plan surfaces. The system MUST NOT create one surface per discovered map. The surface SHALL present a title and an icon, SHALL be closable like other surfaces, and SHALL persist across reloads through the existing right-panel persistence.

#### Scenario: Open the map surface

- **WHEN** the user opens the map surface from the right panel
- **THEN** the panel shows one titled, icon-bearing map tab rendering map content

#### Scenario: Opening twice does not duplicate

- **WHEN** the map surface is already open and the user opens it again
- **THEN** the panel activates the existing tab rather than adding a second one

#### Scenario: Multiple maps in one project

- **WHEN** a project contains several maps
- **THEN** the single map surface lists them and the user selects among them inside the panel

#### Scenario: Map surface persists

- **WHEN** the map surface is open and the client reloads
- **THEN** the map surface is restored with a title, an icon, and rendered content

### Requirement: Reach the map surface from every right-panel entry point

The system SHALL offer the map surface from the right-panel empty-state actions and from the add-surface menu, and SHALL render its content from every location that renders right-panel surfaces, including both the inline panel and the sheet presentation. The availability input SHALL be a required property at every call site so that omitting it is a compile-time failure. Availability SHALL be determined synchronously from whether a project is active, without a server round trip.

#### Scenario: Add-surface menu

- **WHEN** the user opens the add-surface menu with an active project
- **THEN** the menu offers the map surface

#### Scenario: Empty-panel actions

- **WHEN** the right panel is open with no surfaces and a project is active
- **THEN** the empty state offers an action that opens the map surface

#### Scenario: Sheet presentation

- **WHEN** the right panel is presented as a sheet rather than inline
- **THEN** the map surface renders its content there with the same title and icon

#### Scenario: No active project

- **WHEN** no project is active
- **THEN** the map surface is unavailable and its entry point states why

#### Scenario: Availability requires no round trip

- **WHEN** the add-surface menu opens
- **THEN** the map entry's presence is decided without waiting on a server response

### Requirement: Distinguish absent maps from unparseable maps

The map surface SHALL present distinct empty states for a project containing no map and for a project whose map was found but could not be parsed. The unparseable state SHALL surface the reported lints. The system MUST NOT present a single generic empty state for both conditions.

#### Scenario: Project has no map

- **WHEN** the subscription reports no maps for the active project
- **THEN** the panel explains that this project has no wayfinder map

#### Scenario: Map found but unparseable

- **WHEN** the subscription reports lints and no usable nodes
- **THEN** the panel explains that a map was found but could not be parsed, and shows the reported lints

#### Scenario: Partially parsed map

- **WHEN** the subscription reports both usable nodes and lints
- **THEN** the panel renders the map and makes the lints reachable

### Requirement: Navigate maps, map, and ticket as a three-level stack

The map surface SHALL present three levels — a list of maps, a single map, and a single ticket — navigated as a push stack with a back affordance at each level below the root. Pressing Escape SHALL move back exactly one level. When the panel's own width exceeds the split threshold, the map and ticket levels MAY render side by side, and that threshold SHALL be evaluated against the panel container width rather than the viewport width.

#### Scenario: Push and pop levels

- **WHEN** the user selects a map and then a ticket
- **THEN** the panel shows the ticket with a back affordance, and back returns to the map

#### Scenario: Escape moves back one level

- **WHEN** the user presses Escape at the ticket level
- **THEN** the panel returns to the map level and does not close the panel

#### Scenario: Selected ticket disappears

- **WHEN** the selected ticket is absent from a newly received snapshot
- **THEN** the panel clears the selection and returns to the map level without an empty detail view

#### Scenario: Wide panel splits

- **WHEN** the panel container is wider than the split threshold
- **THEN** the map and the selected ticket render side by side, decided by container width rather than viewport width

### Requirement: Open ticket content without a dedicated retrieval endpoint

The map surface SHALL render a selected ticket's content by reading its relative path through the existing workspace file read path and rendering it through the existing markdown renderer. The system MUST NOT add a wayfinder-specific ticket retrieval RPC. The surface SHALL offer a way to open the ticket as a file in the right panel, and the resulting behaviour with respect to any open file-explorer surface SHALL be documented.

#### Scenario: View a ticket

- **WHEN** the user selects a ticket
- **THEN** the panel reads that ticket by relative path and renders its markdown

#### Scenario: Follow a blocker

- **WHEN** the user activates a blocker reference on a ticket
- **THEN** the panel navigates to that blocker's ticket

#### Scenario: Open the ticket file

- **WHEN** the user chooses to open the ticket as a file
- **THEN** the system opens it through the existing file-opening path and its effect on an open file-explorer surface is documented behaviour

### Requirement: Lay out the constellation deterministically and stably

The system SHALL compute node positions on the client in a panel-independent virtual coordinate space, seeded per ticket so that a given ticket resolves to the same seed regardless of how many other tickets exist. Layout MUST be deterministic for a given map content, MUST be independent of input ordering, and MUST terminate within a bounded iteration count. Layout SHALL run once per map content revision and MUST NOT re-run on panel resize. The system SHALL guarantee a minimum separation between nodes through an explicit separation pass rather than relying on force convergence.

#### Scenario: Repeated layout is identical

- **WHEN** layout runs twice for the same map content
- **THEN** both runs produce identical positions

#### Scenario: Input order does not matter

- **WHEN** layout runs for the same map content with nodes and edges supplied in a different order
- **THEN** the resulting positions are identical

#### Scenario: Adding a ticket preserves spatial memory

- **WHEN** one new leaf ticket is added to an existing map
- **THEN** every previously existing node moves by less than two percent of the layout bounding radius

#### Scenario: Nodes do not overlap

- **WHEN** layout completes for any map within the node cap
- **THEN** the minimum pairwise distance between nodes is at least the required separation

#### Scenario: Resizing does not recompute

- **WHEN** the panel is resized
- **THEN** the camera adapts and the layout solver does not run again

#### Scenario: Bounded work

- **WHEN** layout completes
- **THEN** it reports its iteration and pair-check counts so that growth beyond the expected bound is detectable

#### Scenario: Positions are finite

- **WHEN** layout completes for a map containing cycles, isolated nodes, or dropped edges
- **THEN** every position is a finite number

### Requirement: Drive the render loop only on demand

The canvas render loop SHALL run only while the map surface is the active surface, the document is visible, the window is focused, and the canvas intersects the viewport. The loop MUST stop when any of those conditions fails, including when the surface remains mounted but not visible. Under a reduced-motion preference the system SHALL render a single static frame and MUST NOT start the loop. Ambient motion SHALL advance at a reduced rate relative to interaction and SHALL decay further after a period of inactivity. The canvas backing store SHALL track device pixel ratio changes, including a change of display.

#### Scenario: Surface hidden but mounted

- **WHEN** the user switches to another right-panel surface while the map surface stays mounted
- **THEN** the render loop stops

#### Scenario: Document hidden or window blurred

- **WHEN** the document becomes hidden or the window loses focus
- **THEN** the render loop stops and resumes only when both conditions are restored

#### Scenario: Reduced motion

- **WHEN** the user prefers reduced motion
- **THEN** the panel renders one static frame, starts no loop, and defaults to the list view

#### Scenario: Ambient motion is rate limited

- **WHEN** the map is visible and idle
- **THEN** ambient motion advances at the reduced ambient rate and decays further after the idle threshold

#### Scenario: Display change

- **WHEN** the window moves to a display with a different device pixel ratio
- **THEN** the canvas backing store is resized so rendering stays sharp

### Requirement: Provide an equivalent accessible list view

The map surface SHALL mark the canvas as hidden from assistive technology and SHALL render an adjacent list of tickets ordered by rank and then by ticket number, each an activatable control with a descriptive accessible name conveying its title, status, and blocking relationships. The surface SHALL expose a map/list toggle and SHALL default to the list view below the narrow-panel threshold and under a reduced-motion preference. Activating a list item SHALL select the corresponding node.

#### Scenario: Canvas is hidden from assistive technology

- **WHEN** the map view renders
- **THEN** the canvas is marked hidden from assistive technology and the ticket list carries the accessible content

#### Scenario: Keyboard traversal

- **WHEN** the user moves focus through the ticket list
- **THEN** each item announces its title, status, and blocking relationships, and the corresponding node is highlighted

#### Scenario: Narrow panel defaults to list

- **WHEN** the panel is narrower than the narrow-panel threshold
- **THEN** the surface defaults to the list view

#### Scenario: Toggle between views

- **WHEN** the user activates the map/list toggle
- **THEN** the surface switches views and retains the current selection

### Requirement: Degrade labels and controls at narrow widths

The system SHALL place node labels deterministically and SHALL suppress a label when it would collide with another, resolving collisions in favour of the lower ticket number. Below the narrow-label threshold the system SHALL reduce labels to ticket numbers only.

#### Scenario: Colliding labels

- **WHEN** two labels would overlap
- **THEN** the label belonging to the higher ticket number is suppressed and the result is the same on every render for the same input

#### Scenario: Very narrow panel

- **WHEN** the panel is narrower than the narrow-label threshold
- **THEN** labels are reduced to ticket numbers

### Requirement: Keep the map legible in every theme

The map surface SHALL scope its own colour tokens to the surface with light and dark variants rather than depending on ambient panel colours, and SHALL read those tokens once per theme change rather than during rendering. Status colours SHALL be based on semantic tokens that user appearance customisation does not manage, so status remains distinguishable under a custom theme.

#### Scenario: Light and dark themes

- **WHEN** the user switches between light and dark themes
- **THEN** the map surface remains legible and its tokens are re-read once

#### Scenario: Custom appearance theme

- **WHEN** the user applies a custom appearance theme
- **THEN** the status colours remain distinguishable from one another

#### Scenario: Tokens are not read per frame

- **WHEN** the render loop is running
- **THEN** the engine uses cached token values and does not query computed styles per frame

### Requirement: Provide a way back from every navigable state

The map surface SHALL provide a control that restores the camera to fit the current map, so a user who pans or zooms into empty space can recover. The surface MUST NOT introduce its own maximize or close controls, because the right panel already provides them.

#### Scenario: Camera panned into empty space

- **WHEN** the user pans or zooms until no nodes are visible and activates the reset control
- **THEN** the camera returns to a view that fits the current map

#### Scenario: No duplicate panel controls

- **WHEN** the map surface renders
- **THEN** it provides no maximize or close control of its own

### Requirement: Update the map without a reload

The map surface SHALL reflect changes to map files while it is open, without requiring the user to reload or reopen the panel. Derived state including frontier membership SHALL update in the same emission as the change that caused it.

#### Scenario: Ticket resolved while the panel is open

- **WHEN** a frontier ticket gains answer prose on disk while the map surface is open
- **THEN** the panel shows that ticket as resolved and its unblocked dependents as frontier, without a reload

#### Scenario: Map deleted while the panel is open

- **WHEN** the selected map is removed from disk while the panel is open
- **THEN** the panel returns to the map list and shows the appropriate empty state

### Requirement: Exclude mobile from this surface

The mobile client SHALL NOT present the map surface. The mobile thread inspector's set of modes SHALL remain unchanged by this change.

#### Scenario: Mobile inspector is unchanged

- **WHEN** a user opens the thread inspector on mobile
- **THEN** the available modes are unchanged and no map surface is offered
