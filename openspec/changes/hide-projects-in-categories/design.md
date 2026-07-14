# Design: Hide Projects in Categories

> **DRAFT — to be refined.** Decisions below are proposed defaults; confirm the open questions before implementation.

## Context

The web sidebar renders a `category -> project -> thread` tree built by `buildSidebarCategoryGroups()` (`apps/web/src/sidebarOrganization/categoryTree.ts`) from `SidebarOrganization` in client-local settings (`packages/contracts/src/settings.ts`). Categories already support a reversible hide via `SidebarCategory.archivedAt` (`apps/web/src/sidebarOrganization/categories.ts` — `hideSidebarCategory` / `unhideSidebarCategory`), with temporary reveal when the active thread lives in a hidden category, recovery from `/settings/sidebar`, and inclusion in `Reset sidebar organization`. Projects have no visibility concept — only server-side soft delete (`deletedAt`), which is unrelated.

Project identity in `sidebarOrganization` uses a durable project key: repository identity when available, physical fallback otherwise, with deterministic fallback→canonical migration (`projectWorkflow.ts`). Hidden-project state must ride the same key and migration.

## Goals / Non-Goals

**Goals:**

- Reversible per-project hide in the web sidebar, symmetric with category hide.
- Client-settings-only persistence via full `sidebarOrganization` replacement (existing update discipline).
- Recovery surface on `/settings/sidebar`; inclusion in scoped reset.
- Temporary reveal when the active thread belongs to a hidden project.

**Non-Goals:**

- Mobile: the home screen does not render sidebar categories; no changes there.
- Server/persistence changes: no new fields on `OrchestrationProject`, no API changes.
- Hiding individual member projects inside a grouped logical row.
- Hiding threads (already covered by thread archival).

## Decisions

### D1: Storage shape — separate `hiddenProjects` map (proposed)

Add to `SidebarOrganization`:

```ts
hiddenProjects: Record<string /* projectKey */, { hiddenAt: IsoDateTime }>;
```

**Why over `hiddenAt` on `SidebarCategoryAssignment`:** projects in `Uncategorized` have no assignment record, so hanging visibility off the assignment would either forbid hiding uncategorized projects or force synthetic assignments. A separate map keeps hide orthogonal to categorization (hide + move-to-category compose freely) and makes the reset/decode rules trivial. The `{ hiddenAt }` object (rather than a bare timestamp) leaves room for future metadata and mirrors the assignment record shape with `updatedAt`.

**Decode rule:** missing or invalid `hiddenProjects` decodes to `{}` (nothing hidden) — same tolerance as the rest of `sidebarOrganization`.

### D2: Helpers mirror the category lifecycle

`hideSidebarProject(org, projectKey, now)` / `unhideSidebarProject(org, projectKey)` in `apps/web/src/sidebarOrganization/` (either `categories.ts` or a new `hiddenProjects.ts` if `categories.ts` is getting large — note `sidebar-categories-fixes` is already extracting sidebar UI). Both return a full new `SidebarOrganization` persisted via the existing `updateClientSettings()` path.

### D3: Filtering happens in `buildSidebarCategoryGroups()`

The tree builder drops hidden projects from each group's `projects` array, except when the project contains the active thread — then it is included with an `isTemporarilyRevealed`-style flag on the project snapshot (same pattern the category groups already use). This keeps `Sidebar.tsx` rendering logic unchanged apart from the flag.

### D4: Key migration reuses the existing fallback→canonical pass

Wherever `projectWorkflow.ts` migrates `projectCategoryAssignments` from fallback keys to canonical repository keys, the same pass migrates `hiddenProjects` entries. Conflict rule: if both fallback and canonical entries exist, keep the newer `hiddenAt`.

### D5: Entry point is the project-row context menu

`Hide project` appears alongside `Move to category...` and operates on the logical row (grouped rows hide as a whole). No confirmation dialog — the action is reversible and recovery is one click in `/settings/sidebar`.

### D6: Independence from category hide

Hidden-project state is independent of hidden-category state: unhiding a category does not unhide projects individually hidden within it, and hiding a category does not write per-project hidden entries.

## Risks / Trade-offs

- [Users forget where hidden projects went] → `/settings/sidebar` lists them with a restore action; consider a "N hidden" hint on category headers (open question — defer unless refined in).
- [Stale hidden entries for deleted/renamed workspaces accumulate in settings] → entries are tiny; optionally prune entries whose project key no longer resolves during reset. Do not auto-prune on load, since a temporarily disconnected environment would look like a deleted project.
- [Grouped-row key ambiguity: hiding a logical row must use the row's logical key, not a member key] → reuse the exact key-resolution helper `Move to category...` uses; add a test for grouped rows.
- [Divergence between category-hide and project-hide behaviors confuses users] → mirror semantics deliberately (temporary reveal, settings recovery, reset) and keep naming parallel (`Hide project` / `Hidden projects`).

## Migration Plan

No data migration needed: absent `hiddenProjects` decodes to empty. Rollback is safe — older builds ignore the unknown field (settings decode is tolerant) and simply show all projects.

## Open Questions

Carried from `proposal.md`, restated with proposed defaults:

1. Storage shape — **default: D1 separate map**.
2. Hidden while uncategorized — **default: allowed** (follows from D1).
3. Hidden-count indicator on category headers — **default: no indicator in v1**.
4. Grouped rows hide as a whole — **default: yes** (D5).
5. Category unhide does not cascade to projects — **default: yes** (D6).
6. Hidden projects remain reachable via search/quick-open — **default: yes**; hide affects sidebar rendering only.
