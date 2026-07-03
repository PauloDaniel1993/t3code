## ADDED Requirements

### Requirement: Support sidebar organization profiles

The system SHALL allow users to create and manage multiple sidebar organization profiles. Each profile SHALL own its own project membership, category definitions, category order, project-to-category assignments, hidden category state, and profile-local reset scope. The system SHALL keep profiles client-local in v1.

#### Scenario: Missing profile settings

- **WHEN** client settings contain legacy sidebar organization data without profiles
- **THEN** the system migrates that data into a single usable `Default` profile

#### Scenario: Creating a profile

- **WHEN** the user creates a sidebar organization profile with a valid unique name
- **THEN** the system persists the profile and makes it available in the sidebar profile switcher

#### Scenario: Duplicate profile

- **WHEN** the user duplicates an existing profile
- **THEN** the new profile copies project membership, category definitions, category order, project assignments, and hidden state without sharing mutable records with the source profile

#### Scenario: Invalid active profile

- **WHEN** persisted settings reference a missing, deleted, or archived active profile
- **THEN** the system selects the default profile, or the first valid profile if the default is unavailable

### Requirement: Switch active sidebar profile quickly

The sidebar SHALL provide a low-friction active profile switcher. Switching profiles SHALL update sidebar project/category rendering without changing provider sessions, thread data, credentials, runtime mode, or underlying workspace definitions.

#### Scenario: Switching profiles

- **WHEN** the user selects a different profile from the sidebar switcher
- **THEN** the sidebar renders that profile's categories and projects

#### Scenario: Distinct category organization

- **WHEN** two profiles assign the same project to different categories
- **THEN** each profile renders the project according to that profile's assignment

#### Scenario: Switching profiles does not change runtime state

- **WHEN** the user switches the active sidebar profile
- **THEN** active provider sessions, thread records, project workspaces, and credentials remain unchanged

### Requirement: Manage project membership per profile

The system SHALL treat a profile's projects as membership references to global logical projects. Removing a project from a profile SHALL remove it from that profile's sidebar tree only and MUST NOT delete the underlying workspace, repository, thread history, or project record.

#### Scenario: Add project to active profile

- **WHEN** the user adds a workspace while a sidebar profile is active
- **THEN** the system adds the resulting logical project to the selected profile and selected category within that profile

#### Scenario: Remove project from profile

- **WHEN** the user removes a project from a profile
- **THEN** the project disappears from that profile's sidebar tree and remains available in other profiles and global project data

#### Scenario: Project belongs to multiple profiles

- **WHEN** the same logical project belongs to multiple profiles
- **THEN** category assignment, visibility, and profile-local ordering are resolved independently per profile

#### Scenario: Existing workspace added to another profile

- **WHEN** the user adds a workspace path that already exists in T3 Code and selects a profile
- **THEN** the system adds the existing logical project to that profile instead of creating a duplicate project

### Requirement: Preserve navigation context for out-of-profile active threads

The sidebar SHALL preserve navigation context when the active thread's project is not a member of the active profile. The system SHALL temporarily reveal the active thread's project or provide an equivalent out-of-profile branch without mutating profile membership.

#### Scenario: Active thread outside active profile

- **WHEN** the active thread belongs to a project that is not a member of the active profile
- **THEN** the sidebar shows enough temporary context to navigate to that active thread

#### Scenario: Temporary reveal does not mutate membership

- **WHEN** an out-of-profile active thread is temporarily revealed
- **THEN** the active profile's persisted project membership remains unchanged

### Requirement: Manage profiles from sidebar settings

The `/settings/sidebar` page SHALL provide profile management alongside existing repository grouping and category controls. Users SHALL be able to create, duplicate, rename, reorder, archive, restore, delete, and set the default profile from sidebar settings.

#### Scenario: Viewing sidebar profiles

- **WHEN** the user opens `/settings/sidebar`
- **THEN** the page lists active profiles, archived profiles, the current active profile, and the default profile

#### Scenario: Archiving a profile

- **WHEN** the user archives a profile
- **THEN** the profile is removed from normal profile switching and remains restorable from sidebar settings

#### Scenario: Deleting a profile

- **WHEN** the user confirms deletion of a profile
- **THEN** the system removes that profile without deleting global project data, workspaces, or thread history

#### Scenario: Last profile cannot be deleted

- **WHEN** only one valid profile remains
- **THEN** the system prevents deleting it or immediately creates a replacement default profile

### Requirement: Reset sidebar organization by profile

The system SHALL support resetting the current profile's organization without resetting other profiles. Profile reset SHALL clear that profile's categories, category order, project assignments, hidden category state, hidden project state when supported, and profile-local project order. Profile reset MUST NOT remove global project records, delete threads, alter repository grouping mode, or mutate other profiles.

#### Scenario: Reset current profile

- **WHEN** the user resets the current profile organization
- **THEN** only the current profile's organization fields are reset

#### Scenario: Other profiles preserved during reset

- **WHEN** the current profile is reset
- **THEN** other profiles keep their project membership, categories, assignments, and hidden state

#### Scenario: Global profile reset

- **WHEN** the user confirms a reset of all sidebar profiles
- **THEN** the system replaces profile data with one usable default profile while preserving global project records and thread history
