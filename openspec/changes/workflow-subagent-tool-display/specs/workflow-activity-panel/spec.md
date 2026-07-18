## ADDED Requirements

### Requirement: Workflow panel follows the Option F structure
The Plan/Tasks side panel SHALL render a compact workflow activity card containing a step heading, overall step counter, segmented progress strip, clickable step labels, and optional inline worker details.

#### Scenario: Active plan is available
- **WHEN** the current turn has an active plan
- **THEN** the panel renders each plan step in order and marks it as completed, active, or pending

#### Scenario: No active plan is available
- **WHEN** task activity exists but the current turn has no active plan
- **THEN** the panel renders the workers under an “Activity” heading without inventing plan steps

### Requirement: Step selection toggles workers in the same container
Clicking a step SHALL expand its workers inside the existing workflow card below a separator; it SHALL NOT create a second card, popover, or detached panel.

#### Scenario: User selects a closed step
- **WHEN** the user clicks a step whose workers are not open
- **THEN** the same workflow card expands and shows that step’s workers

#### Scenario: User selects the open step again
- **WHEN** the user clicks the currently selected step
- **THEN** the inline worker region collapses

#### Scenario: User selects another step
- **WHEN** one step is open and the user clicks a different step
- **THEN** the same worker region remains open and replaces its contents with the newly selected step’s workers

### Requirement: Worker metrics use cumulative task usage
Each worker row/card SHALL show any available cumulative token total, tool count, duration, last tool, and lifecycle status. The panel SHALL use the latest usage snapshot for a task and SHALL NOT sum cumulative progress snapshots.

#### Scenario: Worker progress includes usage
- **WHEN** the latest task event contains `totalTokens`, `toolUses`, and `durationMs`
- **THEN** the worker displays those values in compact form

#### Scenario: Worker usage is absent
- **WHEN** a task has no usage metadata
- **THEN** the worker remains visible and omits unavailable metrics without placeholders that imply measured values

#### Scenario: Multiple progress snapshots exist
- **WHEN** a worker has multiple cumulative usage snapshots
- **THEN** its displayed totals come from the latest valid snapshot rather than the sum of snapshots

### Requirement: Tasks are deterministically associated with plan steps
A task SHALL be associated with the plan step that was active in the latest plan state at or before the task’s start sequence/time.

#### Scenario: Task starts while one step is active
- **WHEN** a task starts after a plan update marks one step `inProgress`
- **THEN** the task appears in that step’s worker list

#### Scenario: No active step exists at task start
- **WHEN** a task starts without an active plan step
- **THEN** it appears in an “Other activity” group and is not assigned to a pending or completed step

### Requirement: Displayable progress feedback is collapsed by default
When a task event contains a provider-supplied progress summary, the worker card SHALL show a collapsed “Progress” disclosure. Detailed text SHALL appear only after activation.

#### Scenario: Provider supplies task progress summary
- **WHEN** a task has a non-empty progress summary
- **THEN** the worker card renders a collapsed progress disclosure with a summary/update indicator

#### Scenario: User expands progress feedback
- **WHEN** the user activates the progress disclosure
- **THEN** the provider-supplied summary text becomes visible within the same worker card

#### Scenario: Provider supplies no progress summary
- **WHEN** a task has no displayable progress summary
- **THEN** no empty progress disclosure is rendered

### Requirement: Provider-supplied reasoning is not treated as hidden chain-of-thought
The panel MAY show non-empty reasoning text explicitly emitted by the provider for user display, but SHALL label it as a reasoning summary, keep it collapsed by default, and SHALL NOT claim to expose hidden or raw chain-of-thought.

#### Scenario: Provider emits displayable reasoning text
- **WHEN** the current turn contains non-empty provider reasoning content
- **THEN** the workflow panel renders a collapsed “Reasoning” or “Reasoning summary” disclosure at the turn/workflow level

#### Scenario: Provider omits reasoning text
- **WHEN** reasoning content is absent or empty
- **THEN** the panel renders no reasoning disclosure

### Requirement: Recent tools remain compact
The panel SHALL render a bounded list of recent tool calls as compact rows with type icon, label/detail, and lifecycle status.

#### Scenario: Recent tool calls exist
- **WHEN** tool lifecycle entries are available for the current turn
- **THEN** the panel shows the most recent calls without converting every call into a full-size card

### Requirement: Transcript-hidden tasks stay out of the timeline
Tasks marked `skipTranscript` SHALL remain eligible for the side-panel worker list but SHALL be omitted from inline transcript task cards.

#### Scenario: Ambient task is emitted
- **WHEN** a task event has `skipTranscript: true`
- **THEN** it can appear in the workflow panel but does not create a task card in the chat timeline
