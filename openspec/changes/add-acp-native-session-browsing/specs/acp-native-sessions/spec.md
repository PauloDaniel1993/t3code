## ADDED Requirements

### Requirement: Native session listing is offered only when the agent advertises it

The ACP session runtime SHALL provide a `session/list` operation, and T3 Code SHALL offer native
session browsing for a provider instance only when that agent advertises
`agentCapabilities.sessionCapabilities.list`. T3 Code SHALL NOT attempt the call to discover
support.

#### Scenario: Agent advertises session listing

- **WHEN** a provider instance's agent advertises `sessionCapabilities.list`
- **THEN** native session browsing is offered for that instance

#### Scenario: Agent does not advertise session listing

- **WHEN** a provider instance's agent omits `sessionCapabilities.list`
- **THEN** native session browsing is not offered and no `session/list` request is sent

#### Scenario: Provider is not ACP-backed

- **WHEN** a provider does not speak ACP
- **THEN** native session browsing is not offered

### Requirement: Native sessions are presented with enough context to choose between them

The browsing surface SHALL show, for each native session, its working directory and last-updated
time, ordered most recently updated first. Where the agent supplies a meaningful title it SHALL be
shown; where the title is absent or a placeholder, the surface SHALL fall back to working directory
and timestamp rather than showing indistinguishable entries.

#### Scenario: Agent returns placeholder titles

- **WHEN** every listed session carries the same placeholder title
- **THEN** the surface distinguishes entries by working directory and last-updated time

#### Scenario: Agent has no sessions

- **WHEN** `session/list` returns an empty list
- **THEN** the surface reports that there are no native sessions rather than showing an error

#### Scenario: Listing fails

- **WHEN** the `session/list` request fails
- **THEN** the surface reports the failure and does not present a partial or stale list as current

### Requirement: Adopting a native session creates a thread bound to that session

Adopting a native session SHALL create a new thread whose provider resume cursor identifies the
chosen session, and SHALL start it through the provider's existing resume path. Adoption SHALL NOT
retarget an existing thread at a different native session.

#### Scenario: User adopts a session

- **WHEN** the user adopts a listed native session
- **THEN** a new thread is created whose resume cursor names that session, and the session is
  reattached through the normal resume path

#### Scenario: User sends a turn in an adopted thread

- **WHEN** the user sends a turn in a thread adopted from a native session
- **THEN** the agent answers with its existing conversation context

#### Scenario: Adopted session is already bound to another thread

- **WHEN** the user adopts a native session that another thread already resumes
- **THEN** T3 Code surfaces the existing thread instead of creating a second thread bound to the
  same session

### Requirement: An adopted thread does not present a fabricated transcript

An adopted thread SHALL start with no T3 Code transcript entries for turns that happened outside
T3 Code, and SHALL state that prior turns exist in the agent's context but not in the thread's
history. T3 Code SHALL NOT synthesize timeline entries from replayed session history.

#### Scenario: Thread is opened immediately after adoption

- **WHEN** the user opens a freshly adopted thread
- **THEN** the thread shows that it was adopted and that earlier turns are not part of its history,
  rather than showing an unexplained empty conversation

#### Scenario: Agent replays history on reattachment

- **WHEN** the resume primitive replays prior session updates
- **THEN** those updates do not become thread activity entries

### Requirement: A working-directory mismatch is explicit

T3 Code SHALL show the mismatch before adoption, and SHALL NOT silently change either value, when a
native session's working directory differs from the directory of the project the thread is being
created in.

#### Scenario: Session directory matches the project

- **WHEN** the listed session's working directory matches the target project's directory
- **THEN** adoption proceeds without a mismatch warning

#### Scenario: Session directory differs from the project

- **WHEN** the listed session's working directory differs from the target project's directory
- **THEN** the mismatch is shown before adoption and neither directory is rewritten
