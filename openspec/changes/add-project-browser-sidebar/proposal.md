## Why

Browser tabs currently belong to one thread, so users lose direct access to a working preview when they move among threads for the same project. A project-scoped browser surface lets users and agents keep shared live tabs available throughout a project without changing the existing thread-scoped right panel.

## What Changes

- Add a desktop-only **Project Browser** sidebar at the extreme right of the app, independent from the existing thread right panel.
- Add a third layout-control icon beside the existing sidebar controls, with per-project open state, pinned-tab count, and activity indication.
- Allow multiple session-only live browser tabs per logical sidebar project, including direct creation and promotion of an existing thread browser tab.
- Remove a promoted tab from its origin thread panel while retaining the origin so unpin can return it there; if the origin no longer exists, require confirmation before closing the tab.
- Let every thread in the logical project view and automate shared tabs, with operations serialized per tab.
- Provide a reorderable horizontal tab strip, project-scoped active selection and width, responsive overlay behavior, and guarded close behavior during active automation or recording.
- Reconcile project pins when repository grouping changes by following each tab's physical origin project on splits and combining stable ordered tabs on merges.
- Add a configurable Project Browser toggle command without assigning a default shortcut.
- Keep project pins runtime-only: app/server restart closes them rather than restoring browser sessions.

## Capabilities

### New Capabilities

- `project-browser-sidebar`: Project-scoped live browser tab ownership, layout, lifecycle, automation access, regrouping, and desktop UX.

### Modified Capabilities

None.

## Impact

- Desktop/web UI layout and controls in `apps/web`, especially `ChatView`, `PanelLayoutControls`, preview components, and responsive panel layout.
- Preview and right-panel state ownership in `apps/web/src/previewStateStore.ts`, `apps/web/src/rightPanelStore.ts`, plus a new project-browser store and pure reconciliation helpers.
- Preview RPC/automation routing in `packages/contracts`, `apps/server`, and the desktop automation host so the client-authoritative logical-project membership can safely resolve a live tab through its backing thread/environment while preserving schema-only package boundaries.
- Desktop browser tab lifetime and presentation ownership; no mobile implementation and no durable browser-session migration.
- Focused store, lifecycle, regrouping, layout, accessibility, and automation concurrency tests.
