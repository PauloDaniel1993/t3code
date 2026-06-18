## Context

The current sidebar can collapse projects and group related physical projects by repository
identity, but it does not let users define their own top-level categories. Relevant state is split
today between client settings, which persist user preferences, and `uiStateStore`, which persists
view-level expansion and ordering behavior. This change adds a new organization layer above the
existing logical project rows and must preserve current runtime behavior, repository-grouping
semantics, and existing project/thread navigation patterns.

The change crosses multiple web modules plus the shared client settings schema. It also introduces
new persistence rules, assignment-key migration, hidden-category lifecycle behavior, and a new
settings route, so a technical design is warranted before implementation.

## Goals / Non-Goals

**Goals:**

- Add client-local category definitions and project assignments without changing server or provider
  runtime behavior.
- Render the sidebar as `category -> project -> thread` while preserving existing logical project
  grouping and ordering.
- Support reversible category hide/unhide and category collapse with predictable persistence
  boundaries.
- Provide a first-class Sidebar settings page for category lifecycle management and repository
  grouping controls.
- Keep reset behavior scoped so category organization can be cleared without resetting unrelated
  settings or the user's current installed runtime state.

**Non-Goals:**

- Nested categories.
- Server-synced categories.
- Per-repository-path category overrides.
- Drag-to-move in the main sidebar.
- Any change to provider session behavior, cwd selection, or thread execution semantics.

## Decisions

### 1. Store category definitions and assignments in client settings

Category definitions, order, and assignments are semantic user preferences, so they belong in the
existing client settings contract. `Uncategorized` remains implicit rather than stored. Expansion
state remains in `uiStateStore` because it is view state, not a semantic preference. Because the
current settings update path applies shallow top-level patches, sidebar-organization writes must go
through dedicated helpers that replace the full nested `sidebarOrganization` object.

Alternatives considered:

- Store everything in UI state: rejected because category membership and lifecycle should survive
  normal settings persistence paths.
- Store hidden state in UI state: rejected because hide/unhide is category lifecycle, not a
  transient rendering preference.

### 2. Use a durable assignment key with deterministic migration

Assignments will key by repository canonical key when available and fall back to the physical
project key otherwise. When repository identity resolves later, fallback assignments migrate
forward automatically. If multiple fallback assignments converge on the same canonical key, the
assignment with the latest `updatedAt` wins.

Alternatives considered:

- Key by current visible sidebar row: rejected because repository grouping mode changes would remap
  user organization unpredictably.
- Key by physical project only: rejected because a single logical repository could fragment across
  categories.

### 3. Apply categories after existing logical grouping and project sorting

The sidebar already computes logical project rows and sorts them. Categories will wrap that
existing output rather than replacing earlier pipeline steps. The render flow becomes physical
projects -> logical project rows -> sorted rows -> category grouping -> tree rendering.

Alternatives considered:

- Build categories before logical grouping: rejected because categories are defined at the logical
  project or repository level, not on raw physical projects.
- Replace project sorting with category-local sorting: rejected because it would create a parallel
  ordering system and regress current manual ordering behavior.

### 4. Separate reversible hide from destructive delete

Hide sets `archivedAt` and removes a category from the normal sidebar while preserving assignments,
ordering, and expansion state. Delete removes the category object and moves its projects back to
`Uncategorized`. Hidden categories are restored from `/settings/sidebar`; they are not rendered in
the normal sidebar except for a temporary active-thread reveal.

Alternatives considered:

- Boolean hidden flag: rejected because `archivedAt` preserves useful metadata and fits the
  existing archive mental model.
- Auto-unhide when activity appears: rejected because hide is an explicit user choice and should
  not be silently overridden.

### 5. Introduce a dedicated `/settings/sidebar` route

Repository grouping and categories are both sidebar-organization concerns. The new settings page
will provide the management surface for repository grouping controls, active category management,
hidden-category recovery, and a scoped `Reset sidebar organization` action. Existing quick
repository-grouping controls remain in the sidebar for in-context use.

Alternatives considered:

- Remove quick repository grouping from the sidebar entirely: rejected because the existing grouped
  project workflow benefits from in-context controls and the rebase reinforced that pattern.
- Put category management under General: rejected because the scope is too large and too specific to
  sidebar organization.

### 6. Make category assignment a row-level workflow

Category assignment applies to logical sidebar rows, not individual member projects. The category
workflow therefore belongs on the project row itself and must not reuse the existing member-targeted
submenu pattern used for rename, path copy, and project removal.

Alternatives considered:

- Reuse member-targeted submenus for category assignment: rejected because it would imply
  per-member category ownership that conflicts with the logical-project assignment model.

### 7. Keep reset behavior explicit and scoped

Global Restore defaults remains unchanged and does not clear category organization. A separate
Sidebar-specific reset clears custom categories, assignments, category order, hidden state, and
category expansion state without resetting repository grouping mode, project order, or project
expansion state.

Alternatives considered:

- Extend global Restore defaults: rejected because it would be destructive in ways users would not
  expect.

## Risks / Trade-offs

- [Assignment migration conflicts] -> Store `updatedAt` on assignments and test canonical-key merge
  resolution explicitly.
- [Sidebar complexity growth] -> Extract category settings, assignment logic, and tree derivation
  into focused web modules instead of expanding `Sidebar.tsx` further.
- [Hidden active-thread discoverability] -> Temporarily reveal the active hidden category branch at
  render time without mutating persisted hidden state.
- [User expectations for monorepo subpaths] -> Document and label that categories apply to logical
  projects or repositories, not individual repository-path rows.
- [Reset confusion] -> Keep reset scoped to category organization and expose it only on the Sidebar
  settings page with clear labeling.

## Migration Plan

1. Extend client settings decoding to provide default `sidebarOrganization` values from empty
   settings.
2. Introduce sidebar-organization helpers that normalize assignments, replace the full nested
   `sidebarOrganization` object on writes, and upgrade fallback keys to canonical repository keys
   when available.
3. Add category expansion state to `uiStateStore`.
4. Move sidebar organization rendering onto the extracted category tree layer.
5. Add `/settings/sidebar`, mirror repository grouping controls there, keep the quick sidebar
   grouping controls, and wire reset behavior.
6. Verify behavior against a separate `--base-dir` or `T3CODE_HOME` so the user's current runtime
   state is untouched.

## Open Questions

No blocking product questions remain for v1. Drag-and-drop category reordering in settings may use
existing primitives if they are easy to reuse; otherwise explicit reorder controls remain an
acceptable implementation of the same requirement.
