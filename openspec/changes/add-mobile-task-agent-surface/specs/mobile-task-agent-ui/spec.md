## ADDED Requirements

### Requirement: Surface a thread's tasks and in-session agents in the mobile thread list

The mobile thread list SHALL present a thread's child tasks and the provider-native in-session agents of its turns, using the data already carried on the thread payload. A thread that owns tasks or agents SHALL be distinguishable from one that does not, without the user opening it. Threads that own neither SHALL render exactly as they do today.

#### Scenario: Thread owns tasks

- **WHEN** a thread in the mobile list has child tasks
- **THEN** the row presents a rollup of what it owns and can be expanded to show those tasks nested beneath it

#### Scenario: Thread owns nothing

- **WHEN** a thread has no child tasks and no in-session agents
- **THEN** its row presents no rollup affordance and renders as an ordinary thread row

#### Scenario: Agents belong to their turn

- **WHEN** a turn's provider spawned in-session agents
- **THEN** they are presented as belonging to that turn rather than to the thread

### Requirement: Roll up task and agent outcomes from shared rules

The counts the mobile surface presents SHALL be derived from the same rules the desktop surface uses, so the two cannot disagree about the same thread. The rules SHALL live in code both clients import, and SHALL be verifiable without rendering a component.

#### Scenario: Same thread, same counts

- **WHEN** the same thread is presented on desktop and on mobile
- **THEN** both report the same number of running, finished, and failed agents for a given turn

#### Scenario: Rules are testable in isolation

- **WHEN** the rollup rules are exercised
- **THEN** they can be tested directly, without mounting a view

#### Scenario: Desktop behaviour is unchanged

- **WHEN** the rules move to their shared home
- **THEN** the desktop surface renders exactly as it did before the move

### Requirement: Peek at a task or an agent without leaving the list

The mobile surface SHALL let a user inspect a task or an in-session agent from the thread list without navigating away from it. A task and an agent SHALL use the same row anatomy in that presentation; an agent MUST NOT be given a degraded or structurally different treatment. The peek SHALL offer a route to the agent's place in the transcript.

#### Scenario: Peek at a task

- **WHEN** a user inspects a task from the thread list
- **THEN** its status, its turn's agents, and their outcomes are presented without leaving the list context

#### Scenario: Peek at an agent

- **WHEN** a user inspects an in-session agent
- **THEN** it presents the same anatomy a task does, plus a route to where it ran in the transcript

### Requirement: Open a task as the thread it is

A task SHALL be openable as a full thread surface, because a task is a thread. The route into it MUST resolve to that task and not to any other. Every affordance the surface presents SHALL either resolve or state why it is unavailable.

#### Scenario: Open the task that was tapped

- **WHEN** a user opens a task from the list or from a peek
- **THEN** the full view presents that task, not a different one and not a default

#### Scenario: No dead affordances

- **WHEN** the full task view presents a control
- **THEN** that control either performs its action or states in words why it cannot

### Requirement: Use one gesture for the task-row tap

The mobile surface SHALL map the task-row tap to exactly one destination, and that mapping SHALL be consistent everywhere a task row appears. The same gesture MUST NOT resolve to a peek in one place and a navigation in another.

#### Scenario: Consistent destination

- **WHEN** a user taps a task row anywhere in the mobile surface
- **THEN** it resolves to the same kind of destination every time

#### Scenario: The alternative is reachable

- **WHEN** the chosen gesture is the only mapping for the tap
- **THEN** the other destination remains reachable by a different, discoverable affordance

### Requirement: Refuse steering with the reason in words

Where the mobile surface presents a task or agent that cannot be steered, it SHALL state the reason in words alongside the unavailable control. A control that is only disabled, greyed, or absent SHALL NOT be considered sufficient. This SHALL hold for provider-native in-session agents, which cannot be steered independently of the turn that spawned them.

#### Scenario: Native in-session agent

- **WHEN** the surface presents a provider-native in-session agent
- **THEN** the steering affordance is visibly unavailable and the reason is stated in words next to it

#### Scenario: Task state does not accept steering

- **WHEN** a task is in a state that cannot accept steering
- **THEN** the surface states why rather than only disabling the control

#### Scenario: Steerable task

- **WHEN** a task can be steered
- **THEN** the composer is available and carries no unavailability message

### Requirement: Attribute every failure to a reason

Where the mobile surface presents a failed agent, it SHALL present a reason alongside the failure indication. A bare failure marker with no attribution SHALL NOT be sufficient. Where a rollup reports failures without naming them, the reasons SHALL be reachable from that rollup.

#### Scenario: A failed agent

- **WHEN** an agent has failed
- **THEN** its row presents the reason for the failure

#### Scenario: Failures behind a rollup

- **WHEN** a rollup reports a failure count rather than individual failures
- **THEN** the reasons are reachable from that rollup

### Requirement: Report counts honestly at every cardinality

Rollups on the mobile surface SHALL read correctly when the underlying counts are zero, one, or entirely failed. The surface MUST NOT present a ratio of the form "0 of 0", MUST NOT apply plural wording to a count of one, and MUST NOT apply failure styling or a failure count when nothing has failed.

#### Scenario: Exactly one agent

- **WHEN** a turn ran exactly one agent
- **THEN** the wording is singular and the counters read correctly for one unit

#### Scenario: Zero failures

- **WHEN** every agent in a turn succeeded
- **THEN** no failure count is presented and no failure styling appears

#### Scenario: Nothing has started

- **WHEN** a task exists but nothing has run
- **THEN** no outcome ratio is presented

#### Scenario: Everything failed

- **WHEN** every agent in a turn failed
- **THEN** the rollup presents that honestly without implying partial success

### Requirement: Distinguish an unread task result

The mobile surface SHALL present a task result the user has not read as distinct from one that has been read, and SHALL surface that distinction on the parent thread so it is visible without expanding the thread.

#### Scenario: Result returned and unread

- **WHEN** a task has returned a result the user has not read
- **THEN** the task and its parent thread both indicate the unread result

#### Scenario: Result has been read

- **WHEN** the user has read the result
- **THEN** the unread indication is no longer presented

### Requirement: Meet text contrast on the mobile surface in both themes

Text on the mobile task and agent surface SHALL meet a contrast ratio of at least 4.5:1 against the surface it renders on, in every supported theme. Compliance SHALL be established against the colour as **effectively rendered**, including any opacity applied to the text or to an ancestor, rather than against the nominal theme value alone.

#### Scenario: Metadata text

- **WHEN** small metadata text renders on any surface in either theme
- **THEN** its effective contrast against that surface is at least 4.5:1

#### Scenario: Text under an opacity

- **WHEN** text renders inside a view that carries an opacity
- **THEN** the contrast requirement is evaluated against the composited result

#### Scenario: The stated reason is legible

- **WHEN** the surface states why a control is unavailable
- **THEN** that text meets the contrast requirement, because it is the only thing distinguishing an explained control from a broken one
