## 1. Project Browser Domain Model

- [x] 1.1 Define project-browser tab ownership, ordered project state, active selection, activity, and bounded layout-state types in web runtime modules, keeping `packages/contracts` schema-only.
- [x] 1.2 Implement pure helpers for insert, remove, select, reorder, nearest-tab fallback, and idempotent tab transfer between thread and project ownership.
- [x] 1.3 Add focused unit tests for domain transitions, duplicate prevention, invalid origins, deterministic selection, and rollback inputs.
- [x] 1.4 Implement pure regrouping reconciliation using physical origin/backing project identity, stable merge order, tab-id deduplication, valid active-selection fallback, split layout inheritance, merged open-state union, deterministic width selection, and obsolete-key removal.
- [x] 1.5 Add regrouping tests covering split, merge, override changes, missing physical origins, duplicate ids, stable tab ordering, layout migration, and stale layout/route cleanup.

## 2. Store and Runtime Lifecycle

- [x] 2.1 Add a dedicated project-browser store keyed by the currently derived logical project key with commands for toggle, width, layout-update sequencing, create, promote, unpin, close, select, reorder, activity, route registration, and authoritative reconciliation.
- [x] 2.2 Persist only bounded per-project open state and width through the existing UI-state pattern; explicitly exclude live tab records and clear stale/invalid layout entries safely.
- [x] 2.3 Add store tests for project switching, per-project layout restoration, runtime-only pin reset, and concurrent/idempotent command behavior.
- [x] 2.4 Reconcile project ownership after preview list/update/close events and reconnects so missing sessions release ownership and choose a deterministic fallback.
- [x] 2.5 Add reconnect and partial-failure tests proving tabs cannot remain duplicated, ownerless, stale, or visibly leased after authoritative removal.

## 3. Preview Contracts, Discovery, and Cross-Thread Routing

- [x] 3.1 Extend preview and automation schemas with transient project-tab route registration, requesting and backing `ScopedThreadRef` fields, discovery results, target-resolution metadata, and branded/bounded inputs while keeping `packages/contracts` schema-only.
- [x] 3.2 Add a server-side transient route registry that maps each project tab to its owning live desktop connection and backing thread/environment, routes explicit requests only to that owner, and removes routes on unpin, close, regrouping, disconnect, and reconnect.
- [x] 3.3 Implement desktop-host logical membership validation from the current client project projection and grouping settings before every discovery result or browser mutation, including cross-environment members and regrouping invalidation.
- [x] 3.4 Implement project-tab discovery and deterministic target resolution: explicit tab, valid provider-session assignment, active project tab, then existing thread-local behavior; return the resolved tab id from discovery and successful operations.
- [x] 3.5 Implement bounded per-tab operation queues with arrival-order execution, independent queues across tabs, cancellation on close, and explicit error propagation.
- [x] 3.6 Expose current operation/controller metadata to the client for activity indicators without leaking unrelated project-thread data.
- [x] 3.7 Add contract, server, and desktop-host tests for route ownership, discovery filtering, explicit/implicit selection, valid assignment reuse, invalid assignment clearing, same- and cross-environment sibling access, unrelated-thread rejection, same-tab serialization, cross-tab independence, queue cancellation, disconnect, and reconnect cleanup.

## 4. Atomic Pin, Unpin, Create, and Close Workflows

- [x] 4.1 Add a Pin to Project Browser action to thread browser-tab controls and implement atomic promotion of the existing tab id/session out of `rightPanelStore` into project ownership.
- [x] 4.2 Implement direct project-tab creation using the active project thread as backing/origin context, with disabled/empty handling when no valid thread exists.
- [x] 4.3 Implement unpin to the recorded origin thread and a missing-origin confirmation flow that keeps the tab pinned unless the user confirms close.
- [x] 4.4 Implement idle immediate close plus active automation/recording confirmation, cancellation, cleanup, and final session destruction.
- [x] 4.5 Add workflow tests for successful transfer, failed transfer rollback, direct creation, origin return, missing-origin cancellation/confirmation, and active close cleanup.

## 5. Desktop Project Browser UI

- [x] 5.1 Add a desktop-capability-gated Project Browser panel outside the existing thread right panel and wire it to the active logical project's state.
- [x] 5.2 Reuse `PreviewView`/browser surface presentation for the selected project tab while ensuring hidden tabs release presentation leases without closing live sessions.
- [x] 5.3 Build the horizontal tab strip with favicon/title, active state, overflow access, drag reordering, new-tab, unpin, close, and empty states.
- [x] 5.4 Add accessible names, keyboard/focus behavior, live activity/controller context, and confirmation dialogs for destructive edge cases.
- [x] 5.5 Add component tests for multi-tab selection, overflow access, reordering, activity rendering, empty state, focus behavior, and guarded actions.

## 6. Layout Control and Responsive Behavior

- [x] 6.1 Extend `PanelLayoutControls` with the third adjacent Project Browser icon, pressed state, accessible tooltip, pin-count badge, and activity indicator matching the supplied placement.
- [x] 6.2 Register `projectBrowser.toggle` in the keybinding command system with no default binding and wire assigned shortcuts to the active project's toggle.
- [x] 6.3 Add bounded resize handling and per-project width updates for the outer-right panel, reusing shared panel layout primitives where appropriate.
- [x] 6.4 Add responsive overlay/sheet behavior below the supported inline-layout threshold so the conversation never shrinks below its minimum width.
- [x] 6.5 Add layout and control tests for capability gating, icon state/count/activity, assigned shortcuts, project-specific visibility/width, dual-right-panel composition, and breakpoint transitions.

## 7. Integration and Verification

- [x] 7.1 Add integration coverage for pinning a live thread tab, discovering it from same- and cross-environment sibling threads, explicit and implicit automation targeting, and unpinning it back to origin.
- [x] 7.2 Add integration coverage for logical project switching and grouping split/merge while multiple live tabs and both right-side panels are present, including layout migration, route updates, and invalid assignment clearing.
- [x] 7.3 Verify desktop browser recording, viewport resizing, annotations, screenshots, discovered-port opening, and automation continue working for thread-owned and project-owned tabs.
- [x] 7.4 Verify restart/reconnect behavior removes session-only pins without restoring URLs and retains only valid per-project layout preferences.
- [x] 7.5 Run `vp check`, `vp run typecheck`, and the focused Vite+ test suites; fix all failures before marking the change implemented.
