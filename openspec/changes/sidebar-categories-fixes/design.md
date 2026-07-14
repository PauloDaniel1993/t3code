# Design — sidebar-categories-fixes

## Context

Categories were implemented across commits `29e662fc` (foundation), `a911eab6`, `65f37435`, `6e5364df`, with the domain logic properly extracted to `apps/web/src/sidebarOrganization/` but the UI added inline to `Sidebar.tsx` (grown to ~4,650 lines). Decode-time normalization filters invalid references, but the runtime tree builder (`buildSidebarCategoryGroups`) drops projects whose assignment references a missing category — reachable mid-session via cross-window last-write-wins settings replacement.

## Goals / Non-Goals

**Goals:**

- Runtime `Uncategorized` fallback (reliability-first policy).
- Shrink `Sidebar.tsx` by extracting the category UI (repo precedent: `SidebarSettings.tsx` is separate; `.plans/04` split ChatView).
- Small idiom cleanups (id generation, wrappers, expansion-resolution reuse).

**Non-Goals:**

- Changing persistence shape, contracts, or the drag/drop model (per-category `SortableContext` stays).
- Cross-window settings-merge redesign (last-write-wins stays; the fallback makes it safe).

## Decisions

- **Fallback in the tree builder, not a second normalizer**: add an `else` path in `buildSidebarCategoryGroups` (`categoryTree.ts:24-63`) that accumulates unknown-category assignments into the synthesized `Uncategorized` group. One code path, no new state.
- **Extraction shape**: new `apps/web/src/components/sidebar/` directory with `SidebarCategoryGroupSection.tsx` (header, status dots, collapse), `SidebarCategoryMenus.tsx` (context menus), and `SidebarCategoryDialogs.tsx` (create/rename/move). Props stay data+callbacks; all decision logic stays in `sidebarOrganization/` or `Sidebar.logic.ts`. Mechanical move — no behavior change; verify with existing tests plus the new rendering test.
- **Id generation**: `createSidebarCategoryId(uuid: () => string = randomUUID)` in `categories.ts`, defaulting to the canonical helper in `apps/web/src/lib/utils.ts` — deterministic injection for tests replaces the `Date.now()+Math.random()` scheme (collision-prone and non-idiomatic).
- **Wrapper removal**: `hide/unhide/deleteSidebarCategoryFromSettings` (`SidebarSettings.logic.ts:124-159`) are inlined at call sites; `categoryTree.ts:85`'s re-implementation of the `?? true` expansion default is replaced by importing `resolveCategoryExpanded` from `uiStateStore`.

## Risks / Trade-offs

- [Extraction churn in a 4,650-line file] → move JSX blocks verbatim; no logic edits in the same commits as the move (reviewable diff).
- [Fallback could mask genuine data corruption] → decode-time filtering still runs and remains the primary cleaner; the runtime fallback is display-safety only.
