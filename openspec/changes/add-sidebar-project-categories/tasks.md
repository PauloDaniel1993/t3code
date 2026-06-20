## 1. Settings Contract

- [x] 1.1 Extend `packages/contracts/src/settings.ts` with `sidebarOrganization` schemas and defaults
- [x] 1.2 Add contract tests for default decoding and invalid category reference filtering

## 2. Sidebar Organization Domain

- [x] 2.1 Create `apps/web/src/sidebarOrganization` modules for category definitions, assignment helpers, validation, and full-object settings writes
- [x] 2.2 Implement durable assignment-key derivation and fallback-to-canonical migration with deterministic `updatedAt` conflict resolution
- [x] 2.3 Add unit tests for category creation, rename validation, assignment fallback, migration, hide/unhide helpers, and delete-to-`Uncategorized`

## 3. UI State

- [x] 3.1 Extend `apps/web/src/uiStateStore.ts` with persisted category expansion state
- [x] 3.2 Add focused tests proving category collapse persistence and reset behavior without clearing project expansion state

## 4. Sidebar Tree Rendering

- [x] 4.1 Extract category tree derivation from `Sidebar.tsx` so categories wrap the existing logical project and sorting pipeline
- [x] 4.2 Render category headers, project counts, and `Uncategorized` behavior in the sidebar
- [x] 4.3 Implement temporary reveal for active threads in hidden categories without mutating persisted hidden state
- [x] 4.4 Add sidebar tests for categorized rendering, collapse behavior, hidden-category filtering, and temporary reveal

## 5. Assignment And Category Lifecycle UX

- [x] 5.1 Add row-level `Move to category...` and inline `New category...` flows to the logical project-row context menu without reusing member-targeted submenus
- [x] 5.2 Rename repository-deduping labels from `Project grouping...` to `Repository grouping...` where applicable
- [x] 5.3 Add UI tests for creating categories and assigning projects from sidebar workflows
- [x] 5.4 Add category selection with inline `New category...` creation to the Add project flow
- [x] 5.5 Add tests for Add project category selection, inline category creation, and existing-project reassignment
- [x] 5.6 Add direct sidebar hide action for user-created category headers
- [x] 5.7 Add tests for sidebar-header hide behavior and `Uncategorized` exclusion

## 6. Sidebar Settings Surface

- [x] 6.1 Add `/settings/sidebar` and a `Sidebar` settings navigation item
- [x] 6.2 Mirror repository grouping controls on the Sidebar settings page while preserving the existing quick sidebar controls
- [x] 6.3 Implement active category management, hidden-category recovery, `Unhide all categories`, and read-only `Uncategorized` presentation
- [x] 6.4 Add a scoped `Reset sidebar organization` action that clears only category-organization state
- [x] 6.5 Add tests for settings-driven rename, hide, unhide, delete, reorder, and reset behavior

## 7. Verification

- [ ] 7.1 Manually verify the feature using a separate `--base-dir` or `T3CODE_HOME` instead of the current installed runtime state tree
- [x] 7.2 Run `vp check`
- [x] 7.3 Run `vp run typecheck`
