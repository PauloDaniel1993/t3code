## ADDED Requirements

### Requirement: Persist sidebar category organization locally

The system SHALL persist sidebar category definitions, category order, and project-to-category
assignments in client-local settings. The system SHALL treat `Uncategorized` as an implicit fallback
bucket rather than a stored category record. The system SHALL update the nested sidebar category
settings through dedicated helpers that replace the full `sidebarOrganization` object.

#### Scenario: Missing sidebar organization settings

- **WHEN** client settings do not contain sidebar category organization data
- **THEN** the system initializes an empty category model and places all projects in
  `Uncategorized`

#### Scenario: Invalid category references in persisted settings

- **WHEN** stored category order or project assignments reference missing categories
- **THEN** the system filters the invalid references and resolves affected projects to
  `Uncategorized`

#### Scenario: Updating category organization settings

- **WHEN** the user creates, renames, reorders, hides, unhides, deletes, or reassigns a category
- **THEN** the system persists the full updated `sidebarOrganization` object rather than relying on
  ad hoc nested shallow patching

### Requirement: Organize logical projects into a category tree

The sidebar SHALL render projects in a `category -> project -> thread` hierarchy above the existing
logical project rows. The system SHALL preserve existing logical project grouping, project order,
thread order, and archived-thread filtering within each project row.

#### Scenario: Rendering categorized projects

- **WHEN** one or more logical projects have category assignments
- **THEN** the sidebar shows each assigned project under its category and shows unassigned projects
  under `Uncategorized`

#### Scenario: Rendering empty categories

- **WHEN** a user-created category has no assigned projects
- **THEN** the sidebar still renders the category header

### Requirement: Support category collapse without resetting child state

The sidebar SHALL allow categories, including `Uncategorized`, to be collapsed and re-expanded.
Collapsing a category SHALL hide descendant projects and threads without resetting project-level or
thread-level expansion state beneath that category.

#### Scenario: Collapsing a category

- **WHEN** the user collapses a category
- **THEN** the sidebar hides all descendant projects and threads for that category

#### Scenario: Re-expanding a category

- **WHEN** the user re-expands a previously collapsed category
- **THEN** the sidebar restores the category contents while preserving the prior expansion state of
  descendant projects

### Requirement: Assign categories to logical projects durably

The system SHALL assign categories to logical projects or repositories rather than individual
physical project entries. The system SHALL use repository identity when available and SHALL upgrade
fallback assignments deterministically when canonical repository identity appears later.

#### Scenario: Assigning a project from the sidebar

- **WHEN** the user assigns a logical project row to a category from the sidebar workflow
- **THEN** the assignment applies to the logical project and the project moves under that category

#### Scenario: Assigning a project while adding a workspace

- **WHEN** the user selects an existing category in the Add project flow and adds a workspace
- **THEN** the created project is assigned to that category before the Add project flow closes

#### Scenario: Creating a category while adding a workspace

- **WHEN** the user chooses `New category...`, enters a valid category name, and adds a workspace
- **THEN** the system creates the category and assigns the created project to it in the same
  sidebar-organization settings update

#### Scenario: Reassigning an existing project from Add project

- **WHEN** the selected Add project path already exists and the user chose a category
- **THEN** the existing logical project is assigned to that category before the app navigates to it

#### Scenario: Grouped project row assignment

- **WHEN** a logical sidebar row represents multiple grouped member projects
- **THEN** `Move to category...` operates on the logical row as a whole rather than targeting
  individual member projects

#### Scenario: Canonical repository identity appears after assignment

- **WHEN** a project was assigned using a fallback physical key and the repository canonical key
  becomes available later
- **THEN** the system migrates the assignment to the canonical key without changing the user's
  chosen category

#### Scenario: Conflicting fallback assignments converge on one repository

- **WHEN** multiple fallback assignments resolve to the same canonical repository key
- **THEN** the system keeps the assignment with the latest `updatedAt` value and drops the older
  conflicting assignments

### Requirement: Support category lifecycle with reversible hide

The system SHALL allow users to create, rename, reorder, hide, unhide, and delete custom
categories. Hiding a category SHALL preserve assignments, ordering, and expansion state. Deleting a
category SHALL move its assigned projects to `Uncategorized`.

#### Scenario: Hiding a category

- **WHEN** the user hides a category
- **THEN** the category is removed from the normal sidebar and remains recoverable from sidebar
  settings

#### Scenario: Hiding a category from the sidebar

- **WHEN** the user hides a user-created category from its sidebar header
- **THEN** the category is archived through sidebar-organization settings and disappears from the
  normal sidebar without clearing its project assignments

#### Scenario: Built-in Uncategorized cannot be hidden

- **WHEN** the user views the `Uncategorized` category in the sidebar
- **THEN** the sidebar does not offer a hide action for it

#### Scenario: Deleting a category

- **WHEN** the user confirms deletion of a category
- **THEN** the system removes the category and reassigns its projects to `Uncategorized`

#### Scenario: Active thread belongs to a hidden category

- **WHEN** the active thread belongs to a hidden category
- **THEN** the sidebar temporarily reveals that hidden category branch for navigation context
  without permanently unhiding it

### Requirement: Manage categories from a dedicated sidebar settings page

The system SHALL provide a `/settings/sidebar` page for repository grouping controls, active
category management, hidden-category recovery, and sidebar-organization reset. The page SHALL show
`Uncategorized` as a read-only built-in bucket. The system SHALL preserve existing quick repository
grouping controls in the main sidebar and SHALL label repository-deduping controls as `Repository
grouping`.

#### Scenario: Viewing active and hidden categories

- **WHEN** the user opens `/settings/sidebar`
- **THEN** the page shows active categories separately from hidden categories and allows hidden
  categories to be restored

#### Scenario: Managing repository grouping and categories together

- **WHEN** the user uses sidebar settings
- **THEN** repository grouping controls and category management are available from the same settings
  surface

#### Scenario: Using quick repository grouping controls

- **WHEN** the user changes repository grouping from the main sidebar workflow
- **THEN** the quick sidebar control remains available and uses `Repository grouping` terminology

### Requirement: Reset sidebar organization without resetting unrelated sidebar behavior

The system SHALL provide a `Reset sidebar organization` action that clears custom categories,
project-to-category assignments, category order, hidden-category state, and category expansion
state. The action MUST NOT reset repository grouping mode, manual project order, or project
expanded/collapsed state.

#### Scenario: Resetting sidebar organization

- **WHEN** the user runs `Reset sidebar organization`
- **THEN** all custom categories are removed and all projects return to `Uncategorized`

#### Scenario: Preserving unrelated sidebar state during reset

- **WHEN** sidebar organization is reset
- **THEN** existing repository grouping mode, manual project order, and project expansion state
  remain unchanged
