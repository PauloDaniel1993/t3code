# Tasks: Profile Scoped Sidebar Organization

> **DRAFT - to be refined.** Resolve open questions in `design.md` before starting task 1.1.

## 0. Refinement Gate

- [ ] 0.1 Confirm open questions 1-6 in `design.md` and update proposal/spec/design/tasks accordingly
- [ ] 0.2 Decide whether this change depends on, includes, or defers the hidden-projects-in-categories draft
- [ ] 0.3 Confirm naming in product UI: `Profiles`, `Sidebar profiles`, or `Workspaces`

## 1. Contracts and Migration

- [ ] 1.1 Add profile-aware `sidebarOrganization` schema to `packages/contracts/src/settings.ts`
- [ ] 1.2 Decode the legacy single-profile sidebar organization shape into a `Default` profile
- [ ] 1.3 Add tolerant validation for missing, malformed, archived, or invalid active/default profile ids
- [ ] 1.4 Add contract tests for default decode, legacy migration, invalid profile filtering, and round-trip persistence

## 2. Sidebar Organization Domain Logic

- [ ] 2.1 Implement profile lifecycle helpers: create, duplicate, rename, reorder, archive, restore, delete, and set default
- [ ] 2.2 Implement active profile resolution and safe fallback behavior when active profile data is invalid
- [ ] 2.3 Implement profile project membership helpers: add, remove, copy to profile, move to profile, and reorder within profile
- [ ] 2.4 Extend fallback-to-canonical project-key migration across every profile
- [ ] 2.5 Add unit tests for lifecycle, membership, duplicate profile copying, key migration, and deletion fallback

## 3. Sidebar Rendering and Switching

- [ ] 3.1 Render the category tree from the active profile only
- [ ] 3.2 Add a compact sidebar profile switcher with create/duplicate/manage affordances
- [ ] 3.3 Preserve temporary reveal behavior for active threads outside the active profile
- [ ] 3.4 Add project row actions for add/copy/move/remove profile membership without deleting the workspace
- [ ] 3.5 Add rendering tests for switching profiles, distinct categories per profile, and out-of-profile active thread reveal

## 4. Sidebar Settings

- [ ] 4.1 Extend `/settings/sidebar` with profile management and active/default profile controls
- [ ] 4.2 Add profile detail editing for categories, project membership, archived profiles, and profile-local reset
- [ ] 4.3 Keep repository grouping controls separate from profile management
- [ ] 4.4 Add settings tests for profile create, duplicate, rename, archive/restore, delete, default selection, and reset scope

## 5. Add Project Flow

- [ ] 5.1 Add profile selection to the Add project flow, defaulting to the active profile
- [ ] 5.2 Allow category selection or category creation within the chosen profile
- [ ] 5.3 Handle existing workspace paths by adding or reassigning profile membership rather than duplicating the project
- [ ] 5.4 Add tests for adding new and existing projects into selected profiles/categories

## 6. Verification

- [ ] 6.1 Run `vp check`
- [ ] 6.2 Run `vp run typecheck`
- [ ] 6.3 Manually verify with an isolated `--base-dir` or `T3CODE_HOME`: create profiles, switch profiles, use different categories, add/remove projects, duplicate profiles, archive/restore, reset current profile, and confirm underlying projects/threads remain intact
