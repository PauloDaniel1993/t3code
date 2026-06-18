## Why

The sidebar already supports repository-level grouping, but it does not let users create their own
high-level categories to organize projects into a predictable tree. As the number of projects
grows, users need a way to collapse, hide, and recover groups of related projects without changing
runtime behavior or losing their current installation state during verification.

## What Changes

- Add a client-local sidebar category system that organizes logical project rows into a
  `category -> project -> thread` tree.
- Add category lifecycle support for create, rename, reorder, collapse, hide, unhide, and delete.
- Add durable project-to-category assignments that survive repository identity resolution and
  existing repository-grouping mode changes.
- Add a dedicated `/settings/sidebar` management surface for repository grouping controls, category
  management, hidden-category recovery, and sidebar-organization reset while preserving quick
  repository-grouping controls in the main sidebar.
- Preserve existing project sorting, per-project expansion, repository grouping semantics, and
  runtime/session behavior.
- Require verification of the feature against a separate `--base-dir` or `T3CODE_HOME`.

## Capabilities

### New Capabilities

- `sidebar-project-categories`: User-managed sidebar categories for logical projects, including
  assignment, collapse, hide/unhide, settings management, and scoped reset behavior

### Modified Capabilities

## Impact

- Affected code:
  - `apps/web/src/components/Sidebar.tsx`
  - `apps/web/src/components/settings/*`
  - `apps/web/src/routes/settings*.tsx`
  - `apps/web/src/uiStateStore.ts`
  - `apps/web/src/hooks/useSettings.ts`
  - `packages/contracts/src/settings.ts`
- Affected systems:
  - Client settings persistence
  - Sidebar tree derivation and interaction
  - Settings navigation and reset flows
- No server API or provider runtime behavior changes are intended.
