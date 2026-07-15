# Delta: sidebar-project-categories — hide projects in categories

> **DRAFT — to be refined.** Scenarios marked `(open question)` depend on decisions listed in `proposal.md`.

## ADDED Requirements

### Requirement: Support hiding individual logical projects reversibly

The system SHALL allow users to hide and unhide individual logical projects from the sidebar. Hidden-project state SHALL be persisted in client-local `sidebarOrganization` settings keyed by the same durable project key used for category assignments (repository identity when available, with deterministic fallback-to-canonical migration). Hiding a project SHALL preserve its category assignment, manual order position, and expansion state. A project SHALL be hideable regardless of whether it is assigned to a category or resides in `Uncategorized`.

#### Scenario: Hiding a project from the sidebar

- **WHEN** the user chooses `Hide project` on a logical project row
- **THEN** the project row disappears from the sidebar tree and its hidden state is persisted through a full `sidebarOrganization` settings update, without clearing its category assignment

#### Scenario: Unhiding a project restores it in place

- **WHEN** the user unhides a previously hidden project
- **THEN** the project reappears under its prior category (or `Uncategorized`) with its prior manual order position and expansion state

#### Scenario: Hiding a grouped logical row

- **WHEN** a logical sidebar row represents multiple grouped member projects and the user hides it
- **THEN** the hide applies to the logical row as a whole rather than to individual member projects

#### Scenario: Active thread belongs to a hidden project

- **WHEN** the active thread belongs to a hidden project
- **THEN** the sidebar temporarily reveals that project row for navigation context without permanently unhiding it

#### Scenario: Category containing only hidden projects

- **WHEN** all projects assigned to a category are hidden
- **THEN** the category header still renders, consistent with empty-category rendering

#### Scenario: Canonical repository identity appears after hiding

- **WHEN** a project was hidden using a fallback physical key and the repository canonical key becomes available later
- **THEN** the system migrates the hidden-project entry to the canonical key without changing its hidden state

#### Scenario: Unhiding a category does not unhide its projects (open question)

- **WHEN** a hidden category containing individually hidden projects is unhidden
- **THEN** the category reappears but individually hidden projects within it remain hidden

#### Scenario: Missing hidden-project data in persisted settings

- **WHEN** client settings do not contain hidden-project state
- **THEN** the system treats all projects as visible

## MODIFIED Requirements

### Requirement: Persist sidebar category organization locally

The system SHALL persist sidebar category definitions, category order, project-to-category
assignments, and hidden-project state in client-local settings. The system SHALL treat
`Uncategorized` as an implicit fallback bucket rather than a stored category record. The system
SHALL update the nested sidebar category settings through dedicated helpers that replace the full
`sidebarOrganization` object.

#### Scenario: Missing sidebar organization settings

- **WHEN** client settings do not contain sidebar category organization data
- **THEN** the system initializes an empty category model and places all projects in
  `Uncategorized`

#### Scenario: Invalid category references in persisted settings

- **WHEN** stored category order or project assignments reference missing categories
- **THEN** the system filters the invalid references and resolves affected projects to
  `Uncategorized`

#### Scenario: Updating category organization settings

- **WHEN** the user creates, renames, reorders, hides, unhides, deletes, or reassigns a category,
  or hides or unhides a project
- **THEN** the system persists the full updated `sidebarOrganization` object rather than relying on
  ad hoc nested shallow patching

### Requirement: Manage categories from a dedicated sidebar settings page

The system SHALL provide a `/settings/sidebar` page for repository grouping controls, active
category management, hidden-category recovery, hidden-project recovery, and sidebar-organization
reset. The page SHALL show `Uncategorized` as a read-only built-in bucket. The system SHALL
preserve existing quick repository grouping controls in the main sidebar and SHALL label
repository-deduping controls as `Repository grouping`.

#### Scenario: Viewing active and hidden categories

- **WHEN** the user opens `/settings/sidebar`
- **THEN** the page shows active categories separately from hidden categories and allows hidden
  categories to be restored

#### Scenario: Viewing and restoring hidden projects

- **WHEN** the user opens `/settings/sidebar` and one or more projects are hidden
- **THEN** the page lists the hidden projects and allows each to be restored individually

#### Scenario: Managing repository grouping and categories together

- **WHEN** the user uses sidebar settings
- **THEN** repository grouping controls and category management are available from the same settings
  surface

#### Scenario: Using quick repository grouping controls

- **WHEN** the user changes repository grouping from the main sidebar workflow
- **THEN** the quick sidebar control remains available and uses `Repository grouping` terminology

### Requirement: Reset sidebar organization without resetting unrelated sidebar behavior

The system SHALL provide a `Reset sidebar organization` action that clears custom categories,
project-to-category assignments, category order, hidden-category state, hidden-project state, and
category expansion state. The action MUST NOT reset repository grouping mode, manual project order,
or project expanded/collapsed state.

#### Scenario: Resetting sidebar organization

- **WHEN** the user runs `Reset sidebar organization`
- **THEN** all custom categories are removed, all projects return to `Uncategorized`, and all
  hidden projects become visible again

#### Scenario: Preserving unrelated sidebar state during reset

- **WHEN** sidebar organization is reset
- **THEN** existing repository grouping mode, manual project order, and project expansion state
  remain unchanged
