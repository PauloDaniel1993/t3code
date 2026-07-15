# Profile Scoped Sidebar Organization Design

> **Status: DRAFT - to be refined.**

## Context

The existing sidebar category feature stores a single client-local `sidebarOrganization` model. That model organizes logical sidebar project rows into categories, supports hidden categories, and keeps `Uncategorized` implicit. A separate draft change may add per-project hidden state.

Profiles should extend that model without changing provider runtime semantics. Switching profiles changes what the sidebar shows and how it is organized; it must not change session cwd, provider selection, credentials, installed projects, or thread data.

## Goals / Non-Goals

**Goals:**

- Let users switch quickly between different sidebar organization profiles.
- Let different profiles have different visible projects and different category structures.
- Preserve the current single-profile behavior as the default path.
- Keep the data local, robust under invalid persisted settings, and easy to reset.
- Make profile changes reversible where practical.

**Non-Goals:**

- No server-synced profile support in v1.
- No provider/runtime isolation per profile.
- No per-profile auth, credentials, environment variables, or model defaults.
- No nested categories unless a later spec adds them.
- No automatic project classification into profiles in v1.
- No mobile implementation unless mobile sidebar categories are introduced first.

## Decisions

### Store profiles under sidebar organization

Use a single profile-aware `sidebarOrganization` object instead of adding a separate unrelated `profiles` settings tree. Profiles are a sidebar organization concern in v1, and keeping the data together reduces reset and migration ambiguity.

Draft shape:

```ts
sidebarOrganization: {
  activeProfileId: string;
  defaultProfileId: string;
  profileOrder: string[];
  profiles: Record<string, SidebarOrganizationProfile>;
}

SidebarOrganizationProfile: {
  id: string;
  name: string;
  archivedAt: string | null;
  projectKeys: string[];
  categoryOrder: string[];
  categories: Record<string, SidebarCategory>;
  projectCategoryAssignments: Record<string, SidebarCategoryAssignment>;
  hiddenProjects?: Record<string, string>;
}
```

Alternatives considered:

- Store project membership as a boolean map. Rejected for now because ordered arrays better match the "easy to change" goal and support profile-local project order directly.
- Keep one global category list shared by all profiles. Rejected because the user specifically needs different profiles to have different categories.

### Projects are membership references, not copies

A profile includes durable logical project keys. The underlying project/workspace remains global. Removing a project from a profile hides it from that profile only; it does not remove the workspace from T3 Code.

Project keys should reuse the existing durable category-assignment key rules: canonical repository identity when available, with deterministic fallback-key migration when canonical identity appears later.

### Fast switching is part of the feature

The sidebar should expose a compact active-profile control near the project/category tree. The settings page should handle heavier management actions. The switcher should not require navigating to settings for routine context changes.

### Reset has profile and global scopes

`Reset current profile organization` clears only the active profile's categories, project assignments, hidden state, and profile-local ordering. `Reset all sidebar profiles` is destructive and requires confirmation. Existing global restore defaults should not silently delete profiles unless a later decision explicitly changes that behavior.

## Risks / Trade-offs

- Invalid persisted profile data could hide projects unexpectedly -> decode must always preserve at least one usable profile and make unknown or orphaned projects reachable from a safe default path.
- Switching profiles while viewing a thread outside the active profile could remove navigation context -> temporarily reveal the active thread's project in the active profile tree or show a clear out-of-profile branch without mutating membership.
- Multiple profiles increase settings complexity -> keep the sidebar switcher small and put bulk management in `/settings/sidebar`.
- Migration from the current shape is easy, but rollback is lossy if users create multiple profiles -> rollback should preserve the first/default profile in the old shape where practical.

## Migration Plan

1. Decode the existing single-profile `sidebarOrganization` into one profile named `Default`.
2. Preserve current categories, category order, project assignments, hidden categories, and expansion state where possible.
3. Initialize `activeProfileId`, `defaultProfileId`, and `profileOrder` to the migrated profile id.
4. If profile data is malformed, synthesize a valid `Default` profile and keep all known projects visible.
5. Keep decode tolerant of the old shape for at least one release cycle.

## Open Questions

1. Should a project be allowed in multiple profiles? Proposed: yes, because profiles are views over shared projects.
2. Should adding a new workspace add it only to the active profile, to the default profile, or ask every time? Proposed: add to active profile, with an explicit category/profile picker in the Add project flow.
3. Should profile membership have profile-local project ordering, or reuse existing global manual project order? Proposed: profile-local ordering for easier context-specific organization.
4. Should hidden projects be included in the first profile implementation or depend on the separate hidden-projects change? Proposed: support the field if present, but do not block profile work on the hidden-projects change.
5. When the active thread is outside the active profile, should the sidebar temporarily reveal it or offer a one-click "Add to current profile" affordance? Proposed: temporarily reveal plus an add action.
6. Should archived profiles keep all settings indefinitely? Proposed: yes, until explicit delete.
