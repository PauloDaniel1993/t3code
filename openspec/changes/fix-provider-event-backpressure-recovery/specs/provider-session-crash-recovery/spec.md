## ADDED Requirements

### Requirement: Reconcile stale provider lifecycle state after an unclean exit

The system SHALL reconcile persisted sessions marked starting or running against live adapter
sessions before accepting provider commands or publishing the first client snapshot after startup.
If no live session owns the recorded active turn, the system SHALL clear the active turn, mark the
turn interrupted, preserve valid resume state, and expose a non-running session state.

#### Scenario: Server exits while a turn is running

- **WHEN** the next server process finds a persisted running session and active turn but no live
  adapter session owns them
- **THEN** startup marks the turn interrupted, clears the active turn, and does not present the
  thread as working

#### Scenario: Provider completion was emitted but not projected

- **WHEN** a crash occurs after the provider finished but before its terminal event reached durable
  lifecycle projection
- **THEN** startup treats the unverifiable active turn as interrupted rather than leaving it
  running or claiming that it completed

#### Scenario: Resume state remains valid

- **WHEN** a stale session has a valid provider resume cursor
- **THEN** reconciliation preserves the cursor for the next explicit session recovery while
  clearing the obsolete active-turn marker

#### Scenario: Session stopped cleanly

- **WHEN** persisted runtime and projected session state already show a terminal non-running status
- **THEN** startup does not rewrite the completed, stopped, or interrupted lifecycle

### Requirement: Recover durable pending turn requests exactly once

After stale active-turn reconciliation, the system SHALL resume processing a durable pending turn
request that has never received a provider turn identifier. Recovery MUST be idempotent across
repeated restarts and MUST surface an actionable terminal error if the pending request cannot be
started.

#### Scenario: Pending request was never delivered

- **WHEN** startup finds a pending turn-start request with no provider turn identifier after
  clearing a stale active turn
- **THEN** the command reactor processes that request exactly once using the preserved user message
  and provider binding

#### Scenario: Restart occurs during pending-request recovery

- **WHEN** the server exits again while replaying a pending request
- **THEN** command receipts and projected state prevent duplicate provider delivery on the next
  startup

#### Scenario: Pending request cannot be recovered

- **WHEN** its provider instance is disabled, unavailable, incompatible, or cannot resume
- **THEN** the pending turn moves to a visible error or interrupted state with an actionable reason
  instead of remaining pending indefinitely

#### Scenario: A provider turn identifier was already assigned

- **WHEN** a persisted running turn may already have been delivered to the provider
- **THEN** startup marks it interrupted and does not automatically resend the user request

### Requirement: Make startup recovery deterministic and observable

Recovery SHALL use deterministic command identities or durable receipts, SHALL complete its
projection updates before the startup readiness barrier opens, and SHALL report aggregate recovery
counts without exposing prompt content or provider credentials.

#### Scenario: Recovery runs more than once

- **WHEN** startup reconciliation is invoked repeatedly for unchanged persisted state
- **THEN** the resulting lifecycle projection and pending-request dispatch count are unchanged

#### Scenario: Client connects during startup

- **WHEN** a client requests state while reconciliation is still running
- **THEN** the server delays readiness or the snapshot until recovered thread state has been
  projected

#### Scenario: Recovery finishes

- **WHEN** startup reconciliation completes
- **THEN** diagnostics report counts for interrupted turns, reconciled sessions, replayed pending
  requests, and failed recoveries without prompt or credential data
