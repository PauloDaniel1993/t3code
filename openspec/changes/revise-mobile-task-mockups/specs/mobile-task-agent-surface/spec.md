## ADDED Requirements

### Requirement: Define a rendering for every task lifecycle state

The mobile task surface design SHALL define a distinct rendering for every task lifecycle state it can encounter, including queued and not yet started, running, cancelled mid-flight, completed with a result the user has not read, and completed and read. No lifecycle state SHALL fall through to a blank row, a missing status indicator, or a chip whose meaning is ambiguous between two states. The design artifacts SHALL render each of these states so that the coverage is verifiable by inspection rather than by inference.

#### Scenario: Task queued and not yet started

- **WHEN** a task exists but no agent has started running
- **THEN** the design renders a state that reads as not-yet-started and does not present it as running, failed, or complete

#### Scenario: Task cancelled mid-flight

- **WHEN** a task is cancelled while agents are still running
- **THEN** the design renders a cancelled state distinguishable from both completion and failure

#### Scenario: Result returned but unread

- **WHEN** a task has returned a result the user has not yet read
- **THEN** the design renders an unread indication distinct from the read completed state

#### Scenario: Every state is rendered somewhere

- **WHEN** a reviewer inspects the design artifacts
- **THEN** every defined lifecycle state appears as an actual rendering, side by side, rather than being described only in prose

### Requirement: State non-steerability with a reason

Where the design presents an agent or task that cannot be steered — including a provider-native in-session agent — it SHALL communicate the reason in words alongside the unavailable control. A control that is merely disabled, greyed, or absent without an accompanying explanation SHALL NOT be considered sufficient, because an unexplained disabled control is indistinguishable from a defect.

#### Scenario: Native in-session agent

- **WHEN** the surface presents a provider-native in-session agent
- **THEN** the steering affordance is visibly unavailable and the reason it is unavailable is stated in words

#### Scenario: Non-steerable task state

- **WHEN** a task is in a state that does not accept steering
- **THEN** the design states why steering is unavailable rather than only disabling the control

#### Scenario: Steerable case is unambiguous

- **WHEN** a task or agent can be steered
- **THEN** the composer is presented as available and carries no unavailability message

### Requirement: Report rollup counts honestly at every cardinality

Rollup indications that summarise tasks, agents, or outcomes SHALL read correctly when the underlying counts are zero, one, or entirely failed. The design MUST NOT present a count of the form "0 of 0", MUST NOT apply plural wording to a count of one, and MUST NOT apply failure styling or a failure indication when no unit has failed.

#### Scenario: Exactly one agent

- **WHEN** a task's turn ran exactly one agent
- **THEN** the rollup wording is singular and the counters read correctly for one unit

#### Scenario: Zero failures

- **WHEN** every agent in a turn succeeded
- **THEN** the rollup presents no failure count and applies no failure styling

#### Scenario: Every agent failed

- **WHEN** every agent in a turn failed
- **THEN** the rollup presents the failure honestly without implying partial success

#### Scenario: Nothing has run yet

- **WHEN** a task has no agents that have started
- **THEN** the rollup does not present an outcome ratio of zero over zero

### Requirement: Attribute every agent failure to a reason

Where the design presents a failed agent, it SHALL present a reason for that failure alongside the failure indication. The design MUST NOT present a failed agent as a bare failure marker with no attribution.

#### Scenario: Single failed agent

- **WHEN** an agent has failed
- **THEN** its row presents a reason for the failure alongside the failure indication

#### Scenario: All agents failed

- **WHEN** every agent in a turn failed
- **THEN** each failure carries its reason and the reasons remain legible in the rolled-up presentation

### Requirement: Meet text contrast in every theme

Text in the design SHALL meet a contrast ratio of at least 4.5:1 against the surface it is rendered on, in every supported theme. This SHALL hold for small metadata text, which is the smallest and lowest-contrast text in the surface, and it SHALL be verified against every surface that text appears on, including the darker card surface as well as the page background. Contrast SHALL be established by measurement rather than by visual judgement.

#### Scenario: Metadata text on the page background

- **WHEN** metadata text is rendered on the page background
- **THEN** its measured contrast ratio against that background is at least 4.5:1

#### Scenario: Metadata text on a card surface

- **WHEN** metadata text is rendered on a card surface darker or lighter than the page background
- **THEN** its measured contrast ratio against that card surface is at least 4.5:1

#### Scenario: Both themes

- **WHEN** the design is viewed in each supported theme
- **THEN** the contrast requirement holds in every one of them

#### Scenario: Verification is measured

- **WHEN** contrast is reported as met
- **THEN** the reported ratios come from measurement of the actual token values in use

### Requirement: Present one converged flow across the mobile surfaces

The design SHALL present a single coherent flow from thread-list entry, through a peek presentation, to a full task view, rather than parallel alternatives for the same decision. Navigation between the artifacts SHALL use the same deep-link convention as the preceding revision so both sets can be compared directly. Every artifact SHALL render without a build step or a network dependency.

#### Scenario: Walk the flow end to end

- **WHEN** a reviewer enters from the thread list, opens the peek, and continues to the full task view
- **THEN** each step links to the next and the three present one consistent visual language

#### Scenario: Deep links resolve

- **WHEN** a reviewer opens any artifact using its documented parameter
- **THEN** the artifact renders the state that parameter names

#### Scenario: No external dependencies

- **WHEN** an artifact is opened directly from the filesystem with no network access
- **THEN** it renders completely and references nothing external

### Requirement: Preserve the prior revision as a comparison baseline

The preceding revision of the mobile task mockups SHALL remain unmodified so that the findings that motivated this revision stay checkable against the artifact they describe. The new revision SHALL be a sibling artifact and SHALL document what changed relative to the prior revision and why.

#### Scenario: Prior revision is untouched

- **WHEN** this change is complete
- **THEN** the prior revision's files are unchanged and still render as originally reviewed

#### Scenario: Changes are attributed

- **WHEN** a reviewer reads the new revision's documentation
- **THEN** it states what changed from the prior revision and which finding motivated each change

### Requirement: Report unverified alignment honestly

Where an input required to verify part of the design is unavailable, the design artifacts SHALL record that verification as outstanding and MUST NOT record it as complete. Work that does not depend on the missing input SHALL proceed rather than block on it.

#### Scenario: Reference input is unavailable

- **WHEN** the reference needed for visual alignment does not exist
- **THEN** the alignment verification is recorded as outstanding and is not marked complete

#### Scenario: Independent work proceeds

- **WHEN** the reference input is unavailable
- **THEN** state coverage, contrast, and flow convergence are completed and verified independently of it

#### Scenario: Reference input arrives

- **WHEN** the reference input becomes available
- **THEN** the alignment pass is performed and its verification is recorded as complete
