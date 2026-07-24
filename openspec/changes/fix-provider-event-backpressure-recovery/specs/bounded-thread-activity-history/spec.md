## ADDED Requirements

### Requirement: Bound activity data in initial snapshots

Initial project and thread synchronization SHALL include at most a server-defined recent activity
window per thread. The response SHALL indicate whether older activities exist and provide an opaque
cursor for retrieving them without requiring the server or client to materialize the complete
activity table.

#### Scenario: Thread has activity within the initial limit

- **WHEN** a thread has no more activities than the configured initial window
- **THEN** synchronization returns all of them in chronological order and reports no older page

#### Scenario: Thread has a large activity history

- **WHEN** a thread has more activities than the configured initial window
- **THEN** synchronization returns only the most recent window, reports that older history exists,
  and includes a cursor for the next older page

#### Scenario: Many historical threads exist

- **WHEN** the server builds an initial snapshot for a project containing many large threads
- **THEN** memory and response size are bounded by the configured per-thread windows rather than
  total historical activity count

### Requirement: Page older thread activity with stable ordering

The system SHALL retrieve older activity in bounded pages using a stable opaque cursor derived from
the durable activity order. Paging MUST avoid duplicates and gaps when multiple rows share a
timestamp or when new live activities arrive after the cursor is issued.

#### Scenario: Client loads an older page

- **WHEN** the client requests activity before a valid cursor
- **THEN** the server returns the immediately preceding bounded page in chronological display order
  with a new cursor and `hasMore` state

#### Scenario: Activities share timestamps

- **WHEN** multiple activities have equal creation times
- **THEN** paging uses sequence and stable identity tie-breakers so each activity appears exactly
  once

#### Scenario: Live activity arrives during history loading

- **WHEN** new events append while the client retrieves an older page
- **THEN** the live tail remains ordered and the historical page merges without duplicating or
  dropping existing activities

#### Scenario: Cursor is invalid or stale

- **WHEN** the client submits a malformed or no-longer-resolvable cursor
- **THEN** the server rejects it with a typed validation response and leaves synchronized state
  unchanged
