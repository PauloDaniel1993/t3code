# Sidebar Project Categories

## Goal

Add a first-class sidebar category system so users can organize logical projects into a tree-like
navigation structure. Categories should support collapse, hide/unhide, and predictable recovery
without changing existing project, thread, or provider runtime behavior.

## Product Decisions

- Add a new `/settings/sidebar` page and sidebar nav item.
- Categories are client-local only.
- Categories organize logical sidebar project rows, not individual physical project entries.
- Tree hierarchy is `category -> project -> thread`.
- `Uncategorized` is an implicit built-in fallback bucket.
- Each logical project can belong to at most one category.
- Custom categories use stable ids and editable names.
- Category names must be unique after trim, case-insensitively.
- Categories can be collapsed and re-expanded.
- Category collapse is view state only and does not reset child project or thread expansion state.
- Categories can be hidden and later restored.
- Hidden categories are absent from the normal sidebar and recoverable from `/settings/sidebar`.
- Hidden categories use reversible archive-style semantics (`archivedAt`), not deletion.
- If the active thread belongs to a hidden category, temporarily reveal that category branch without
  mutating persisted hidden state.
- Repository grouping remains a separate concept from categories.
- Repository grouping controls should remain available as quick sidebar controls and also appear on
  the new Sidebar settings page. Label them `Repository grouping` to avoid terminology collisions
  with categories.
- Resetting sidebar organization is a separate action from global Restore defaults.
- Verification for this feature must use a separate `--base-dir` or `T3CODE_HOME`, not the user's
  current installed state tree.

## Non-Goals

- No nested categories in v1.
- No server-synced category settings in v1.
- No per-repository-path or per-physical-project category overrides in v1.
- No category effects on runtime mode, session cwd, provider selection, or other execution
  behavior.
- No drag-to-move projects between categories in the main sidebar in v1.
- No automatic unhide of categories because of unread, running, or otherwise active threads.
- No hide/delete controls for individual projects as part of the category feature.

## Spec 1: Client Settings Contract

### Scope

Extend client-only settings in `packages/contracts/src/settings.ts` with a nested
`sidebarOrganization` object.

### Data Model

```ts
sidebarOrganization: {
  categoryOrder: string[];
  categories: Record<string, SidebarCategory>;
  projectCategoryAssignments: Record<string, SidebarCategoryAssignment>;
}

SidebarCategory: {
  id: string;
  name: string;
  archivedAt: string | null;
}

SidebarCategoryAssignment: {
  categoryId: string;
  updatedAt: string;
}
```

### Requirements

- Decode missing `sidebarOrganization` settings to a complete default state.
- Keep category definitions and assignments in the existing client settings persistence path.
- Update `sidebarOrganization` through dedicated sidebar-organization helpers that replace the full
  nested object, rather than ad hoc nested shallow patches.
- `Uncategorized` is not stored in `categories`; it is synthesized at runtime.
- Filter `categoryOrder` entries that reference missing categories.
- Filter assignments that reference missing categories.
- Invalid or missing category assignments fall back to `Uncategorized`.
- Validate category ids and names as trimmed non-empty strings.
- Keep `packages/contracts` schema-only; runtime normalization helpers belong in web modules.

### Deliverables

- Contract schema additions.
- Default sidebar organization constants.
- Contract tests for default decoding and filtering invalid category references.

### Exit Criteria

- Existing client settings still decode.
- Sidebar organization settings decode from `{}` with no migration script required.

## Spec 2: Category Keys, Assignments, And Migration Rules

### Scope

Add focused sidebar-organization domain logic in `apps/web/src/sidebarOrganization`.

### Requirements

- Derive a durable category-assignment key using:
  - repository canonical key when available
  - otherwise physical project key
- Categories apply to the logical project or repository, not individual repository-path rows.
- Resolve the effective category for a logical project row.
- Migrate fallback physical-key assignments to the canonical repository key when repository
  identity becomes available.
- If multiple fallback assignments collapse into one canonical key, the assignment with the latest
  `updatedAt` wins deterministically.
- Keep unknown assignment keys instead of garbage-collecting them from ordinary render-time
  absence, because remote environments may be temporarily unavailable.
- Clear assignments for explicit category deletion by moving affected projects back to
  `Uncategorized`.
- Validate category names for case-insensitive uniqueness.

### Recommended Location

Start in `apps/web/src/sidebarOrganization`. Do not add runtime helpers to `packages/contracts`.

### Deliverables

- `categorySettings.ts`, `categoryAssignments.ts`, or equivalent domain modules.
- Unit tests for key derivation, migration, conflict resolution, assignment fallback, and name
  validation.

### Exit Criteria

- Category behavior is testable without rendering React.
- Assignment migration preserves user intent when repository identity appears late.

## Spec 3: UI State For Category Expansion

### Scope

Extend sidebar UI state with category expansion state.

### Requirements

- Persist category expanded or collapsed state in `apps/web/src/uiStateStore.ts`.
- Keep category expansion state separate from client settings.
- Category collapse hides descendant projects and threads while preserving child project and thread
  UI state underneath.
- Resetting sidebar organization clears category expansion state.
- Resetting sidebar organization does not clear existing project expansion state.

### Deliverables

- `uiStateStore` additions for category expansion state.
- Focused tests for persistence and collapse behavior.

### Exit Criteria

- Categories remember expanded or collapsed state across reloads.

## Spec 4: Sidebar Tree Rendering

### Scope

Render categories as a new presentation layer above the existing logical project rows.

### Requirements

- Preserve the current pipeline order:
  - physical projects
  - logical sidebar project snapshots
  - project sorting
  - category grouping
  - tree rendering
- Render active categories first, then `Uncategorized`.
- Hidden categories are excluded from the normal sidebar tree.
- Hidden categories are also excluded from keyboard traversal and thread-jump indexing, except when
  a temporary reveal is required for the active thread.
- Temporarily revealing a hidden active category must not mutate persisted hidden state.
- Preserve existing project ordering inside each category.
- Preserve existing thread ordering and archived-thread filtering inside each project row.
- Category headers should show project counts.
- Empty categories remain visible.
- `Uncategorized` is collapsible but not hideable, renameable, or deletable.

### Deliverables

- Extracted tree-building logic from `Sidebar.tsx`.
- Sidebar category header rendering and collapse support.
- Tests for visible-tree composition and temporary reveal behavior.

### Exit Criteria

- The sidebar navigates as `category -> project -> thread`.
- Category collapse and temporary reveal work without breaking existing thread navigation.

## Spec 5: Sidebar Assignment UX

### Scope

Add category assignment controls to the existing project-row interaction points.

### Requirements

- Project-row category actions operate on the logical sidebar row, not individual physical member
  projects.
- `Move to category...` must be a row-level action and must not reuse the existing member-targeted
  submenu pattern used by rename, copy path, and remove actions.
- Add `Move to category...` to the project-row context menu.
- Add `New category...` inline from the project-row assignment flow.
- Keep project rename, copy path, and remove behavior intact.
- Keep existing quick repository-grouping controls in the sidebar and rename their wording from
  `Project grouping...` to `Repository grouping...` where they refer to repository-deduping
  behavior rather than categories.
- Do not require main-sidebar drag-to-move between categories in v1.

### Deliverables

- Project-row context menu updates.
- Category assignment helpers and dialog or menu logic.
- Browser or component tests for assignment flows.

### Exit Criteria

- Users can create a category and assign a project to it without leaving the sidebar workflow.

## Spec 6: Sidebar Settings Route

### Scope

Add a dedicated settings surface for sidebar organization.

### Requirements

- Add `/settings/sidebar`.
- Add a `Sidebar` item to settings navigation.
- The page should manage:
  - repository grouping settings
  - active categories
  - hidden categories
  - reset sidebar organization
- The page should mirror repository grouping controls without removing the existing quick grouping
  controls from the main sidebar.
- Active category rows should support rename, hide, delete, and reorder behavior.
- Hidden category rows should support unhide and show archived timing metadata where practical.
- `Uncategorized` should be visible on the page as a read-only built-in bucket.

### Deliverables

- `settings.sidebar.tsx`.
- Sidebar settings panel components.
- Settings navigation update.

### Exit Criteria

- Category lifecycle is manageable from a first-class settings page.
- Hidden categories can be restored without touching the main sidebar.

## Spec 7: Hidden Category Lifecycle

### Scope

Define the reversible hide and restore model for categories.

### Requirements

- Hiding a category sets `archivedAt` and removes the category from the normal sidebar.
- Unhiding clears `archivedAt` and restores the category in its previous order position.
- Hiding a category preserves assignments, project ordering, and category expansion state.
- Deleting a category is distinct from hiding it.
- Deleting a category moves assigned projects to `Uncategorized`.
- Hiding should not require confirmation.
- Deleting should require confirmation.
- Provide `Unhide all categories` on the Sidebar settings page.

### Deliverables

- Category hide/unhide domain helpers.
- Hidden category settings UI.
- Tests for hide, unhide, delete, and order preservation.

### Exit Criteria

- Hide is reversible and non-destructive.
- Delete is explicit and predictable.

## Spec 8: Reset And Restore Behavior

### Scope

Integrate sidebar categories into reset flows without breaking existing settings expectations.

### Requirements

- Global Restore defaults continues to reset only its current scope and does not clear categories,
  assignments, category order, or hidden-category state.
- Add a separate `Reset sidebar organization` action on `/settings/sidebar`.
- `Reset sidebar organization` must:
  - delete custom categories
  - clear all project-to-category assignments
  - clear hidden-category state
  - clear category order
  - clear category expansion state
- `Reset sidebar organization` must not:
  - reset repository grouping mode
  - reset manual project order
  - reset project expanded or collapsed state

### Deliverables

- Sidebar-specific reset helper and UI.
- Tests proving reset scope is limited to category organization.

### Exit Criteria

- Category reset is explicit, scoped, and non-surprising.

## Spec 9: Verification And Tests

### Required Automated Checks

- `vp check`
- `vp run typecheck`

### Test Coverage

- Contract decode and default tests for `sidebarOrganization`.
- Domain helper tests:
  - category creation
  - rename validation
  - hide and unhide
  - delete to `Uncategorized`
  - durable assignment key resolution
  - migration from physical key to canonical key
  - latest-`updatedAt` conflict resolution
- UI state tests for category expansion persistence.
- Browser or sidebar tests for:
  - category headers render
  - collapse hides descendants
  - hidden categories disappear from the normal sidebar
  - hidden categories can be restored from settings
  - active hidden-category thread temporarily reveals its branch
  - assigning a project updates the tree as expected

### Manual Verification

- Start T3 Code with a separate `--base-dir` or `T3CODE_HOME`.
- Do not run verification against the user's current installed state tree.
- Open `/settings/sidebar`.
- Create categories and assign projects.
- Collapse and re-expand categories.
- Hide categories and restore them from settings.
- Verify the active-thread temporary reveal behavior for hidden categories.
- Verify repository grouping settings still behave independently from categories.
- Verify existing manual project ordering and per-project collapse behavior still work.

### Exit Criteria

- Automated gates pass.
- Sidebar categories work in a running app.
- The feature can be verified safely against an isolated runtime base directory.

## Implementation Order

1. Client settings contract for `sidebarOrganization`.
2. Category key, assignment, and migration helpers.
3. `uiStateStore` support for category expansion.
4. Sidebar tree derivation and rendering.
5. Project-row assignment UX.
6. `/settings/sidebar` route and navigation.
7. Hidden-category lifecycle and reset behavior.
8. Browser tests and manual verification with isolated `--base-dir` or `T3CODE_HOME`.
