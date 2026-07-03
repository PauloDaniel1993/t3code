# Profile Scoped Sidebar Organization

> **Status: DRAFT - to be refined.** This change intentionally captures the product shape and open questions before implementation.

## Why

Users need to move between different work contexts without constantly reorganizing the sidebar. A profile should make it easy to switch between distinct sets of projects and categories, such as work, personal, client, or experiment contexts, while preserving predictable local-only behavior.

## What Changes

- Add user-managed sidebar organization profiles.
- Each profile owns its own project membership, category definitions, category order, project-to-category assignments, hidden category state, hidden project state when available, and sidebar organization reset scope.
- Add a fast profile switcher in the sidebar and a fuller management surface in `/settings/sidebar`.
- Add profile lifecycle actions: create, duplicate, rename, reorder, archive/hide, restore, delete, and set default.
- Add project membership actions so projects can be added to, removed from, or copied between profiles without deleting the underlying workspace.
- Preserve existing behavior for users who never create another profile by migrating current sidebar organization into a single default profile.
- Keep profiles client-local in v1. No sync, provider runtime changes, or per-profile credentials.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sidebar-project-categories`: extend sidebar organization from one global category/project model to multiple user-managed profiles with fast switching and per-profile project/category organization.

## Impact

- `packages/contracts/src/settings.ts`: client settings schema gains profile-aware sidebar organization with tolerant decode and migration from the current single-profile shape.
- `apps/web/src/sidebarOrganization/`: domain helpers for profile lifecycle, active profile resolution, project membership, category assignment within a profile, migration, and reset scope.
- `apps/web/src/uiStateStore.ts`: active sidebar profile and profile-scoped expansion state, or a documented decision to keep active profile in client settings.
- `apps/web/src/components/Sidebar.tsx` and sidebar subcomponents: profile switcher, profile-scoped tree rendering, and project membership actions.
- `/settings/sidebar`: profile management, default profile selection, archived profile recovery, and profile-specific reset controls.
- Tests: settings decode and migration tests, profile helper tests, sidebar tree tests, and settings UI tests.
