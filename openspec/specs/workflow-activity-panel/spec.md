# workflow-activity-panel Specification

## Purpose

TBD - created by archiving change workflow-subagent-tool-display. Update Purpose after archive.

## Requirements

### Requirement: Workflow cards follow the Option F structure and remain associated with their turn

The main conversation area SHALL render a compact workflow activity card containing a step heading, overall step counter, segmented progress strip, clickable step labels, and optional inline worker details. A single activity surface SHALL be anchored directly above the composer and SHALL follow the message cycle selected by the timeline's scroll position. If the selected cycle has no meaningful activity, the surface SHALL be hidden.

#### Scenario: Active plan is available

- **WHEN** the current turn has an active plan
- **THEN** the panel renders each plan step in order and marks it as completed, active, or pending

#### Scenario: No active plan is available

- **WHEN** task activity exists but the current turn has no active plan
- **THEN** the panel renders the workers under an “Activity” heading without inventing plan steps

#### Scenario: Running turn has workflow activity

- **WHEN** a turn with meaningful workflow activity is still running
- **THEN** its card is selected while the timeline is at the live end and is shown directly above the composer

#### Scenario: User scrolls between settled turns

- **WHEN** the timeline scroll position crosses from one message cycle with activity into another
- **THEN** the bottom activity surface switches to the newly selected cycle without requiring the prior surface to be closed

#### Scenario: Selected cycle has no workflow activity

- **WHEN** the message cycle selected by the timeline has no meaningful activity
- **THEN** no activity surface is rendered above the composer

#### Scenario: Scroll-to-end control is visible

- **WHEN** the user has scrolled away from the live end while an activity surface is visible
- **THEN** the scroll-to-end control is positioned above the activity surface rather than overlapping it

#### Scenario: Thread history is restored

- **WHEN** persisted activities for several turns are loaded after a reload or reconnect
- **THEN** the timeline reconstructs an inline activity card for every turn with meaningful activity rather than showing only the latest run

### Requirement: Turn activity cards have independent closed, collapsed, and expanded states

Each turn's activity surface SHALL support `closed`, `collapsed`, and `expanded` states keyed by `turnId`. Changing one card's state SHALL NOT change any other card's state, and a surface with no explicit state SHALL default collapsed.

#### Scenario: User expands two historical turns

- **WHEN** the user expands one historical activity card and then expands another
- **THEN** both cards remain expanded and their details remain associated with their respective turns

#### Scenario: User collapses an expanded card

- **WHEN** the user activates Collapse on an expanded activity card
- **THEN** only that card's details are unmounted and its compact summary remains visible

#### Scenario: User closes an activity card

- **WHEN** the user activates Close on a collapsed or expanded activity card
- **THEN** only that card's bottom surface is dismissed and a compact Activity launcher remains available beside the same turn's response

#### Scenario: User reopens a closed card

- **WHEN** the user activates the launcher for a closed activity card
- **THEN** that turn's activity card reopens expanded without changing another turn's state or activity history

#### Scenario: Historical view state has no session value

- **WHEN** a settled activity card is reconstructed without an explicit session view state
- **THEN** it defaults collapsed while retaining all persisted details for later expansion

### Requirement: Step selection toggles workers in the same container

Clicking a step SHALL expand its workers inside that turn's existing workflow card below a separator; it SHALL NOT create a second card, popover, or detached panel.

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

Tasks marked `skipTranscript` SHALL remain eligible for the workflow activity card's worker list but SHALL be omitted from inline transcript task cards.

#### Scenario: Ambient task is emitted

- **WHEN** a task event has `skipTranscript: true`
- **THEN** it can appear in the workflow panel but does not create a task card in the chat timeline
