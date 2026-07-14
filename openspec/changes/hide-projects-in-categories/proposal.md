# Hide Projects in Categories

> **Status: DRAFT — to be refined.** Open questions are listed at the bottom; resolve them before implementation.

## Why

The sidebar supports hiding whole categories, but not individual projects. Users with many workspaces under one category (or under `Uncategorized`) cannot declutter the sidebar without deleting the project or inventing a "junk" category to hide. A reversible per-project hide, symmetric with the existing category hide, completes the sidebar organization lifecycle.

## What Changes

- Add a reversible **hide/unhide action for individual logical projects** in the web sidebar, available from the project row's context menu (operating on the logical row, consistent with `Move to category...`).
- Persist per-project hidden state in client-local `sidebarOrganization` settings (mirroring the category `archivedAt` pattern), keyed by the same durable project key used for category assignments (repository identity with fallback/migration).
- Hidden projects are excluded from the sidebar tree but remain recoverable from `/settings/sidebar`, which gains a hidden-projects list alongside the existing hidden-categories list.
- Hiding a project preserves its category assignment, manual order position, and expansion state; unhiding restores it in place.
- If the active thread belongs to a hidden project, the sidebar temporarily reveals that project branch for navigation context without permanently unhiding it (same behavior as hidden categories).
- Category headers whose projects are all hidden still render (consistent with empty-category rendering); optionally show a subtle hidden-count indicator (open question).
- `Reset sidebar organization` also clears hidden-project state.
- No server or contracts changes to `OrchestrationProject`; this is client-settings-only, like categories. (Contracts `settings.ts` schema for `SidebarOrganization` gains the hidden-projects field.)
- Mobile is out of scope: the mobile home screen does not render sidebar categories today.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sidebar-project-categories`: extends the organization lifecycle with per-project hide/unhide — new requirement for hiding logical projects (persistence, sidebar exclusion, temporary reveal for active thread), plus deltas to the `/settings/sidebar` management requirement (hidden-projects recovery) and the reset requirement (clears hidden-project state).

## Impact

- `packages/contracts/src/settings.ts` — `SidebarOrganization` schema gains hidden-project state (e.g., `hiddenProjects: Record<projectKey, IsoDateTime>` or a `hiddenAt` field alongside assignments); decode must tolerate its absence (default: nothing hidden).
- `apps/web/src/sidebarOrganization/categories.ts` (or a sibling module) — `hideSidebarProject()` / `unhideSidebarProject()` helpers following `hideSidebarCategory()` / `unhideSidebarCategory()`.
- `apps/web/src/sidebarOrganization/categoryTree.ts` — `buildSidebarCategoryGroups()` filters hidden projects and computes temporary reveal for the active thread's project.
- `apps/web/src/sidebarOrganization/projectWorkflow.ts` — project-key resolution and fallback→canonical migration must also migrate hidden-project entries.
- `apps/web/src/components/Sidebar.tsx` / `components/sidebar/` — project-row context menu gains `Hide project`; hidden rows drop out of the tree.
- `apps/web/src/components/SidebarSettings*` (`/settings/sidebar`) — hidden-projects section with restore.
- Reset path — wherever `Reset sidebar organization` clears category state, also clear hidden projects.
- Tests: `categoryTree.test.ts`, `categories.test.ts` (or new `hiddenProjects.test.ts`), sidebar settings logic tests.
- No server, persistence, or mobile changes.

## Open Questions (to refine)

1. **Storage shape**: separate `hiddenProjects` map vs. `hiddenAt` on `SidebarCategoryAssignment`? A separate map is cleaner because projects in `Uncategorized` have no assignment record.
2. **Hidden + uncategorized**: confirm a project can be hidden while unassigned (implies the separate-map shape).
3. **Hidden-count indicator**: should category headers show "N hidden" when they contain hidden projects, or stay clean and rely on `/settings/sidebar`?
4. **Grouped rows**: hiding a logical row that represents multiple grouped member projects hides the whole row (consistent with `Move to category...`) — confirm.
5. **Interaction with category hide**: if a project's category is hidden AND the project is hidden, unhiding the category should not unhide the project — confirm.
6. **Search/command palette**: should hidden projects still be reachable via search/quick-open? Proposed: yes (hide affects sidebar rendering only).
