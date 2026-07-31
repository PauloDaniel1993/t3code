## ADDED Requirements

### Requirement: ACP agent commands are discovered and kept current

The ACP session runtime SHALL parse `session/update` notifications with
`sessionUpdate: "available_commands_update"` into a typed event carrying each command's name,
description, and optional input hint. The runtime SHALL retain the most recently advertised command
set for the session and SHALL replace it wholesale when the agent advertises a new one. The command
set SHALL be scoped to the session, not to the provider instance.

#### Scenario: Agent advertises commands at session start

- **WHEN** an ACP agent pushes `available_commands_update` after `session/new`
- **THEN** the session's available commands are recorded and published to the client

#### Scenario: Agent republishes a different command set mid-session

- **WHEN** the agent pushes a second `available_commands_update` after a mode or model change
- **THEN** the session's available commands are replaced by the newer set rather than merged

#### Scenario: Commands arrive before any turn is active

- **WHEN** `available_commands_update` arrives while the session has no active turn
- **THEN** the adapter records and publishes the command set instead of discarding the notification

#### Scenario: Agent advertises no commands

- **WHEN** an ACP agent never sends `available_commands_update`
- **THEN** the session reports an empty command set and no command affordance is offered

#### Scenario: Two threads run on one provider instance

- **WHEN** two threads have live sessions on the same provider instance and only one agent
  advertises a command
- **THEN** only that thread offers the command

### Requirement: Users can run an advertised agent command from the composer

The composer SHALL offer the active session's advertised commands, showing each command's name and
description. Selecting a command SHALL dispatch it through the provider's normal prompt path so
that approvals, steering, interruption, and activity recording behave exactly as they do for a
user-authored turn.

#### Scenario: User runs a command with no argument

- **WHEN** the user selects an advertised command that declares no input hint
- **THEN** the command is sent as a prompt turn containing only the command

#### Scenario: User runs a command with an argument

- **WHEN** the user selects a command that declares an input hint and supplies a value
- **THEN** the command and the supplied value are sent together as a single prompt turn

#### Scenario: User interrupts a running command turn

- **WHEN** the user stops a turn that was started by a command
- **THEN** the turn is cancelled through the same interruption path as any other turn

#### Scenario: User sends literal text beginning with a slash

- **WHEN** the user types a message that begins with `/` but does not select a command
- **THEN** the message is sent verbatim as an ordinary prompt

#### Scenario: Provider is not ACP-backed

- **WHEN** the active thread runs on a provider that does not speak ACP
- **THEN** no agent-command affordance is shown

### Requirement: A command turn does not silently diverge from thread history

T3 Code SHALL record a command turn in the thread's activity when that command alters the agent's
own conversation state — for example a compaction command — so the divergence between the native
session's context and the T3 Code transcript is visible to the user.

#### Scenario: Compaction command completes

- **WHEN** a command that compacts the agent's context completes successfully
- **THEN** the thread records the command turn and its outcome rather than showing an unexplained
  gap in agent behavior
