# Tasks — sidebar-categories-fixes

## 1. Runtime Uncategorized fallback

- [ ] 1.1 In `apps/web/src/sidebarOrganization/categoryTree.ts` (`buildSidebarCategoryGroups`, ~L24-63): where assignments are matched to categories, add the missing `else` branch routing assignments with unknown category ids into the synthesized `Uncategorized` group (same bucket as unassigned projects). Preserve project ordering rules.
- [ ] 1.2 Test in `categoryTree.test.ts`: an assignment referencing a nonexistent category id renders the project under `Uncategorized` (assert it is NOT dropped); include the empty-categories and hidden-category cases unaffected.

## 2. Extract category UI from Sidebar.tsx

- [ ] 2.1 Create `apps/web/src/components/sidebar/SidebarCategoryGroupSection.tsx`: move the category group header/section JSX (header row, status dots via `categoryStatusById`, collapse toggle, per-category `SortableContext` wrapper) verbatim from `Sidebar.tsx`; props = derived group data + callbacks.
- [ ] 2.2 Create `apps/web/src/components/sidebar/SidebarCategoryDialogs.tsx`: move create/rename/move-category dialogs.
- [ ] 2.3 Create `apps/web/src/components/sidebar/SidebarCategoryMenus.tsx`: move category context-menu definitions.
- [ ] 2.4 Update `Sidebar.tsx` to consume the three components; target: no category JSX left inline. Run `vp run typecheck` after each move.
- [ ] 2.5 Rendering-level test (e.g. `apps/web/src/components/sidebar/SidebarCategoryGroupSection.test.tsx`, follow the repo's existing component-test style, cf. `SettingsPanels`/`MessagesTimeline` tests): renders headers for empty categories; collapsing hides descendant project rows; hidden categories are excluded; unknown-assignment project appears under Uncategorized.

## 3. Idiom cleanups

- [ ] 3.1 `apps/web/src/sidebarOrganization/categories.ts` (~L7-9): change `createSidebarCategoryId` to accept an injectable `uuid: () => string` defaulting to `randomUUID` from `apps/web/src/lib/utils.ts`; delete the `Date.now()+Math.random()` scheme. Update tests to inject a fixed uuid.
- [ ] 3.2 `apps/web/src/sidebarOrganization/SidebarSettings.logic.ts` (~L124-159): delete `hideSidebarCategoryFromSettings`, `unhideSidebarCategoryFromSettings`, `deleteSidebarCategoryFromSettings` pass-throughs; update call sites to call the underlying helpers directly; keep their test assertions against the underlying behavior.
- [ ] 3.3 `categoryTree.ts` (~L85): replace the local `?? true` expansion default with `resolveCategoryExpanded` imported from `apps/web/src/uiStateStore.ts` (~L355).

## 4. Gates

- [ ] 4.1 `vp check` passes.
- [ ] 4.2 `vp run typecheck` passes.
- [ ] 4.3 `vp test run` for `apps/web` (categoryTree, SidebarSettings.logic, uiStateStore, new component test) passes.
