# Tasks: Hide Projects in Categories

> **DRAFT â€” to be refined.** Resolve the open questions in `proposal.md` / `design.md` (storage shape, indicator, cascade semantics) before starting task 1.1.

## 0. Refinement gate

- [ ] 0.1 Confirm open questions 1â€“6 in `design.md` (storage shape, uncategorized hide, hidden-count indicator, grouped rows, category-hide independence, search reachability) and update proposal/specs/design accordingly

## 1. Contracts and settings schema

- [ ] 1.1 Add `hiddenProjects` map to `SidebarOrganization` in `packages/contracts/src/settings.ts` with tolerant decode (missing/invalid â†’ `{}`)
- [ ] 1.2 Add contracts tests covering decode of missing, valid, and malformed `hiddenProjects` data

## 2. Sidebar organization logic

- [ ] 2.1 Implement `hideSidebarProject` / `unhideSidebarProject` helpers in `apps/web/src/sidebarOrganization/` returning a full replacement `SidebarOrganization`
- [ ] 2.2 Filter hidden projects in `buildSidebarCategoryGroups` (`categoryTree.ts`), with temporary reveal for the project containing the active thread
- [ ] 2.3 Ensure category headers still render when all their projects are hidden
- [ ] 2.4 Extend the fallbackâ†’canonical project-key migration in `projectWorkflow.ts` to migrate `hiddenProjects` entries (newer `hiddenAt` wins on conflict)
- [ ] 2.5 Unit tests: hide/unhide round-trip preserves assignment and order, uncategorized hide, grouped-row key resolution, temporary reveal, key migration

## 3. Sidebar UI

- [ ] 3.1 Add `Hide project` to the logical project row context menu (alongside `Move to category...`), wired through `updateClientSettings()`
- [ ] 3.2 Render temporarily revealed hidden project rows with the same treatment used for temporarily revealed hidden categories
- [ ] 3.3 Rendering-level test: hidden project excluded from tree; revealed when it owns the active thread

## 4. Settings page and reset

- [ ] 4.1 Add a `Hidden projects` section to `/settings/sidebar` listing hidden projects with per-item restore
- [ ] 4.2 Include hidden-project state in `Reset sidebar organization` (cleared), leaving repository grouping, manual order, and expansion state untouched
- [ ] 4.3 Tests for settings-page logic (list, restore) and reset scope

## 5. Verification

- [ ] 5.1 Run web app test suite and typecheck; fix regressions
- [ ] 5.2 Manual pass: hide/unhide from sidebar, restore from settings, active-thread reveal, reset behavior
