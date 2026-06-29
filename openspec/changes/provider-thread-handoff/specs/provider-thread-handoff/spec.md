## ADDED Requirements

### Requirement: Create target threads for provider handoff

The system SHALL create a new target thread when the user hands off a source thread to a different
provider instance. The source thread SHALL remain unchanged. The target thread SHALL be created in
the same project and SHALL copy the source branch, worktree path, runtime mode, and interaction
mode for v1.

#### Scenario: Successful handoff creation

- **WHEN** the client dispatches `thread.handoff.create` with an existing source thread, a new
  target thread id, and a ready target model selection
- **THEN** the system creates the target thread with handoff metadata and leaves the source thread
  unchanged

#### Scenario: Client omits derived source details

- **WHEN** the client dispatches `thread.handoff.create`
- **THEN** the command payload contains only command id, source thread id, target thread id, target
  model selection, and created timestamp, and the server derives project, title, branch, worktree,
  runtime mode, interaction mode, and transcript

#### Scenario: Target thread already exists

- **WHEN** the client dispatches `thread.handoff.create` with a target thread id that already
  exists
- **THEN** the system rejects the command without mutating the source or target thread

#### Scenario: Source is not eligible

- **WHEN** the source thread is missing, deleted, archived, running, awaiting approval, awaiting
  input, or has no importable messages
- **THEN** the system rejects or disables handoff with an actionable reason

#### Scenario: Target provider is not ready

- **WHEN** the target model selection references a provider instance that is not enabled, not
  configured, missing a model, or not ready
- **THEN** the system rejects or disables handoff with an actionable reason

### Requirement: Import source transcript as marked messages

The system SHALL import source transcript messages into the target thread as normal projected
messages marked with `source: "handoff-import"`. Imported messages SHALL include immediate
`sourceThreadId` and SHALL include `sourceMessageId` when the source message id is available.

#### Scenario: Importing completed transcript messages

- **WHEN** the source transcript contains completed user, assistant, or system messages with text
  or attachments
- **THEN** the target thread receives imported message events in chronological order with preserved
  message timestamps and handoff source metadata

#### Scenario: Skipping non-importable messages

- **WHEN** the source transcript contains streaming assistant messages or transient UI-only
  optimistic messages
- **THEN** the system does not import those messages into the target thread

#### Scenario: Importing attachment-only messages

- **WHEN** a completed source message contains attachments but no text
- **THEN** the system imports the message with attachment metadata and does not re-upload the
  attachment to the target provider

#### Scenario: Visible import cap is reached

- **WHEN** the source transcript contains more than 2,000 importable messages
- **THEN** the system caps visible imported messages at 2,000 and records that the visible import
  was capped in handoff metadata

#### Scenario: Handoff chain import

- **WHEN** the source thread is itself a handoff target and contains native messages after the
  previous imported block
- **THEN** the system allows handoff and imports the visible source transcript while recording the
  immediate source thread id

### Requirement: Project handoff metadata and message source

The system SHALL expose `handoff` metadata on thread detail and shell snapshots. The system SHALL
expose strict message source values of `user`, `provider`, `system`, or `handoff-import` and SHALL
derive source from role for historical messages with no stored source.

#### Scenario: Non-handoff thread projection

- **WHEN** a thread was not created by handoff
- **THEN** its projected detail and shell snapshots expose `handoff: null`

#### Scenario: Handoff thread projection

- **WHEN** a thread was created by handoff
- **THEN** its projected detail and shell snapshots expose versioned handoff metadata including
  source thread id, source title, provider instance ids, imported message count, bootstrap status,
  and compression metadata when present

#### Scenario: Historical message source fallback

- **WHEN** a projected message has no stored source value
- **THEN** the system exposes `user` for user role, `provider` for assistant role, and `system` for
  system role

#### Scenario: Imported messages do not affect native thread summaries

- **WHEN** the target thread contains imported user messages but no native user message yet
- **THEN** shell latest-user metadata, first-user title generation, branch generation, and revert
  eligibility ignore the imported user messages

### Requirement: Bootstrap the first native target turn

The system SHALL wrap the first native target-thread user message with bounded handoff context when
the target thread handoff bootstrap is pending. The stored user message SHALL NOT be mutated by the
wrapper.

#### Scenario: First native target turn

- **WHEN** the first non-imported user message is sent in a target thread with pending handoff
  bootstrap
- **THEN** the provider receives a wrapped prompt containing handoff context and the latest user
  message

#### Scenario: Bootstrap succeeds

- **WHEN** the first wrapped provider send resolves successfully
- **THEN** the system records handoff bootstrap completion with a deterministic internal command
  and does not wrap later native messages

#### Scenario: Bootstrap send fails

- **WHEN** context construction or the first wrapped provider send fails before a successful
  response
- **THEN** the target thread bootstrap remains pending so the next native send can retry the
  wrapper

#### Scenario: Concurrent native message while bootstrap is in flight

- **WHEN** a target-thread bootstrap send is already in flight
- **THEN** the system does not wrap a second message for the same target thread

#### Scenario: Oversized handoff context

- **WHEN** imported history and the latest user message exceed the bootstrap budget
- **THEN** the system trims or compresses imported context first while preserving the latest user
  message and keeping final provider input within the configured request limit

### Requirement: Preserve provider-session invariants

The system MUST NOT copy provider-native session state from the source thread to the target thread.
The system MUST keep existing in-thread provider/model switch guards.

#### Scenario: Source resume cursor exists

- **WHEN** the source thread has a provider-native resume cursor
- **THEN** the target provider session starts without receiving the source resume cursor

#### Scenario: In-thread provider switch is attempted

- **WHEN** a started thread attempts an incompatible in-thread provider or driver switch
- **THEN** the existing provider switch guard still rejects the switch

### Requirement: Provide active-chat handoff UI

The web UI SHALL expose handoff from the active chat thread actions menu and SHALL navigate to the
created target thread after the server acknowledges and projects it.

#### Scenario: Opening handoff dialog

- **WHEN** the active source thread is eligible for handoff
- **THEN** the thread actions menu exposes `Hand off to...` and opens a dialog with source provider,
  target providers, target model picker, disabled target reasons, and importable message count

#### Scenario: Selecting target provider

- **WHEN** the dialog resolves target providers
- **THEN** it hides disabled providers by default, disables the exact current provider instance,
  shows enabled but not-ready providers with reasons, and allows a different instance of the same
  provider driver

#### Scenario: Dispatching handoff

- **WHEN** the user confirms the handoff
- **THEN** the UI dispatches `thread.handoff.create`, closes after command acknowledgement, waits
  briefly for the target thread to appear, and navigates to the target thread when available

#### Scenario: Target projection timeout

- **WHEN** the handoff command is acknowledged but the target thread shell or detail does not appear
  within the UI timeout
- **THEN** the UI shows a toast and remains on the source thread

#### Scenario: Rendering imported messages

- **WHEN** the target thread timeline contains imported messages
- **THEN** the UI renders them expanded with an imported marker, keeps copy controls, hides revert
  for imported user messages, and does not show target-provider turn actions for imported assistant
  messages
