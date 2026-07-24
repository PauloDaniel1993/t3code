## ADDED Requirements

### Requirement: Compact existing replaceable provider history replay-safely

The system SHALL compact oversized historical provider-progress data in both
`orchestration_events` and `projection_thread_activities`. Event-store compaction MUST preserve
event identifiers, global sequences, aggregate stream versions, stream heads, command-receipt
idempotency, causation references, and schema-valid replay while removing or bounding cumulative
tool data that is not required to reproduce the final user-visible state.

#### Scenario: Existing event store contains cumulative tool updates

- **WHEN** many `thread.activity-appended` events describe replaceable `tool.updated` state for the
  same logical tool
- **THEN** maintenance rewrites their oversized replaceable fields to bounded replay-valid
  envelopes without renumbering or deleting their event identities

#### Scenario: Existing projection contains repeated logical tool rows

- **WHEN** many projected `tool.updated` rows belong to the same thread, turn, and tool identity
- **THEN** maintenance retains at most the bounded latest progress needed before terminal state and
  removes superseded projection rows

#### Scenario: Existing tool has terminal state

- **WHEN** historical tool progress is followed by completed or failed tool state
- **THEN** compaction preserves the terminal state and every message, approval, user-input record,
  checkpoint, lifecycle event, and non-tool activity

#### Scenario: Event stream receives later appends

- **WHEN** compaction processes events below a captured applied-sequence watermark
- **THEN** later appends retain monotonic stream versions and are not rewritten by that compaction
  pass

#### Scenario: Projection is rebuilt after compaction

- **WHEN** projectors replay the compacted event store from sequence zero
- **THEN** they reproduce the same bounded user-visible tool outcome and all non-replaceable state
  without decode failures

### Requirement: Make logical database compaction resumable and measurable

Logical compaction SHALL run in bounded transactions, persist its watermark and progress, and be
idempotent after interruption. Before changing data, the system SHALL report database size,
reclaimable logical bytes, eligible row counts, and the safety watermark without exposing provider
payload content.

#### Scenario: Compaction is interrupted between batches

- **WHEN** the server stops after committing some logical-compaction batches
- **THEN** the next pass resumes from durable progress and produces the same result as one
  uninterrupted pass

#### Scenario: Compaction is run again

- **WHEN** maintenance runs against a database that is already logically compacted through the
  recorded watermark
- **THEN** it performs no destructive rewrites and reports no additional eligible history

#### Scenario: A row is malformed or cannot be classified safely

- **WHEN** an event or activity does not contain the identifiers required to prove that it is
  replaceable
- **THEN** maintenance preserves the row, records an aggregate skipped count, and continues without
  logging its payload

### Requirement: Reclaim physical SQLite file space safely

After logical compaction, the system SHALL provide an offline maintenance phase that creates a
compact SQLite copy, validates it, and atomically installs it only while provider sessions, client
commands, and database writers are stopped. The original database MUST remain recoverable until the
compact copy passes integrity and application-invariant checks and the next server startup reaches
readiness.

#### Scenario: Compact copy validates successfully

- **WHEN** logical compaction is complete, sufficient temporary disk space exists, and the compact
  copy passes SQLite integrity plus T3 event/projection invariant checks
- **THEN** maintenance atomically swaps the compact copy into place, retains a rollback copy through
  startup readiness, and reports the before and after byte counts

#### Scenario: Temporary disk space is insufficient

- **WHEN** preflight cannot guarantee enough space for the compact copy and safety margin
- **THEN** maintenance leaves the active database untouched and reports the required and available
  byte counts with actionable guidance

#### Scenario: Validation of the compact copy fails

- **WHEN** SQLite integrity, event stream heads, projection watermarks, or required row-count checks
  differ unexpectedly
- **THEN** maintenance discards the candidate, restores or retains the original database, and does
  not open the candidate for normal writes

#### Scenario: Process exits during physical compaction

- **WHEN** the maintenance process exits before the atomic install commits
- **THEN** the next startup deterministically selects the last validated original database and
  cleans or resumes the incomplete candidate safely

#### Scenario: New database reaches readiness

- **WHEN** the compact database opens, migrations and projections validate, and startup recovery
  completes successfully
- **THEN** the system marks the replacement successful and may remove the rollback copy according
  to the documented retention policy

### Requirement: Offer controlled current-installation remediation

The system SHALL expose a user-invoked or threshold-recommended maintenance action for the current
installation that reports estimated savings, requires a controlled backend restart, and displays
progress and terminal success or failure. It MUST NOT start physical compaction while provider work
or unresolved client commands are active.

#### Scenario: Database exceeds the maintenance threshold

- **WHEN** reclaimable bytes or free-page ratio exceeds the configured threshold
- **THEN** diagnostics recommend compaction and show estimated savings without automatically
  interrupting active work

#### Scenario: User starts maintenance while work is active

- **WHEN** any provider turn, approval, user-input request, or command remains active
- **THEN** the system refuses or defers physical maintenance with a specific actionable reason

#### Scenario: Controlled maintenance completes

- **WHEN** the user accepts maintenance and all preconditions are satisfied
- **THEN** the backend enters maintenance mode, compacts and validates the database, restarts, and
  reports the reclaimed disk space
