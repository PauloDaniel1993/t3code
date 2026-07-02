# Sidebar Categories Fixes

## Why

The sidebar project categories feature is the branch's best-executed stream, but an audit found one reliability gap — projects whose persisted assignment references a missing category id silently vanish from the sidebar until reload, violating the spec's "fall back to Uncategorized" requirement — plus maintainability drift: the new category UI was added inline to an already-oversized `Sidebar.tsx` (~4,650 lines), category ids are generated with `Date.now()+Math.random()` instead of the repo's canonical helper, and a few zero-value wrappers/duplications remain.

## What Changes

- Runtime fallback: `buildSidebarCategoryGroups` routes assignments pointing at unknown category ids into the synthesized `Uncategorized` group instead of dropping the project.
- Extract the category UI (dialogs, category header, context menus, move/new-category flows) from `Sidebar.tsx` into `components/sidebar/` subcomponents.
- Use `randomUUID()` (from `apps/web/src/lib/utils.ts`) for `createSidebarCategoryId`, keeping test injectability.
- Delete pass-through wrappers in `SidebarSettings.logic.ts`; reuse `resolveCategoryExpanded` from `uiStateStore` in `categoryTree.ts`.
- Add a rendering-level test for the category tree (headers, collapse hides descendants, hidden-category exclusion).

## Capabilities

### Modified Capabilities

- `sidebar-project-categories`: unknown-category assignments fall back to Uncategorized at runtime (not only at decode). Existing spec: `openspec/specs/sidebar-project-categories/spec.md` — locate the assignment-fallback requirement and modify it; remaining items are implementation-only (no spec change).

## Impact

- `apps/web/src/sidebarOrganization/categoryTree.ts` + `categoryTree.test.ts`.
- `apps/web/src/components/Sidebar.tsx` (shrinks), new files under `apps/web/src/components/sidebar/`.
- `apps/web/src/sidebarOrganization/categories.ts`, `SidebarSettings.logic.ts` (+tests).
- No contracts or server changes.
