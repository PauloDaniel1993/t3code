# sidebar-project-categories Specification (delta)

## MODIFIED Requirements

### Requirement: Organize logical projects into a category tree

The sidebar SHALL render projects in a `category -> project -> thread` hierarchy above the existing
logical project rows. The system SHALL preserve existing logical project grouping, project order,
thread order, and archived-thread filtering within each project row. When a project's category
assignment references a category id that is not present in the current category set, the tree
builder SHALL place that project under `Uncategorized` at render time rather than omitting it; this
fallback MUST hold even when the invalid reference arises mid-session (after decode-time
normalization has already run).

#### Scenario: Rendering categorized projects

- **WHEN** one or more logical projects have category assignments
- **THEN** the sidebar shows each assigned project under its category and shows unassigned projects
  under `Uncategorized`

#### Scenario: Rendering empty categories

- **WHEN** a user-created category has no assigned projects
- **THEN** the sidebar still renders the category header

#### Scenario: Unknown category assignment at render time

- **WHEN** a project's assignment references a category id absent from the category list (e.g. after
  an interleaved cross-window settings write)
- **THEN** the project renders under `Uncategorized` and remains fully usable
