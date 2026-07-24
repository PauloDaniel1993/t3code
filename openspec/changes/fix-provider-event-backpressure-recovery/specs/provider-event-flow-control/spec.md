## ADDED Requirements

### Requirement: Schedule provider events with bounded and fair flow control

The system SHALL ingest provider runtime events through bounded per-thread flow control and SHALL
prevent a burst from one provider session from starving lifecycle or user-visible events from other
sessions. When capacity is exhausted, the system MUST replace coalescible state, merge lossless
adjacent deltas, or apply backpressure; it MUST NOT silently discard terminal lifecycle events,
assistant text, approval requests, user-input requests, or runtime errors.

#### Scenario: One provider emits a sustained progress burst

- **WHEN** one thread emits tool progress faster than durable projection can process it while
  another provider completes a turn
- **THEN** the second provider's terminal event is projected without waiting for the first thread's
  full progress history to drain

#### Scenario: A bounded buffer reaches capacity

- **WHEN** a provider event buffer reaches its configured capacity
- **THEN** coalescible updates are replaced by newer state and lossless events are backpressured or
  merged without losing their ordered content

#### Scenario: A turn terminates with pending updates

- **WHEN** a terminal turn event arrives while the same turn has buffered assistant or tool state
- **THEN** the system flushes the required preceding state in order and projects exactly one
  terminal lifecycle transition

### Requirement: Coalesce intermediate tool state by logical tool identity

The system SHALL treat repeated non-terminal updates for the same provider instance, thread, turn,
and tool item as replaceable state. Durable projections SHALL maintain a stable logical activity for
that tool instead of appending one immutable activity for every cumulative update, while distinct
tools and terminal outcomes remain distinct.

#### Scenario: A tool reports cumulative output repeatedly

- **WHEN** a tool sends many `item.updated` events with the same logical identity and increasingly
  cumulative detail
- **THEN** the activity projection retains bounded latest progress rather than one activity row per
  update

#### Scenario: A coalesced tool completes

- **WHEN** a tool with buffered intermediate state emits `item.completed`
- **THEN** the final status and bounded terminal detail replace or finalize the logical tool
  activity exactly once

#### Scenario: Two tools update concurrently

- **WHEN** separate tool identities emit interleaved updates in the same turn
- **THEN** each tool retains its own ordered latest state and one tool's coalescing does not replace
  the other

### Requirement: Bound durable provider activity payloads

The system MUST NOT persist full cumulative provider payloads on every intermediate tool update.
Intermediate activities SHALL contain only bounded presentation and lifecycle fields, and terminal
tool data SHALL pass through an explicit size bound and secret-safe normalization before durable
projection.

#### Scenario: Intermediate update contains large raw output

- **WHEN** an in-progress tool update contains a large `rawOutput`, content array, or raw protocol
  payload
- **THEN** the durable activity stores bounded status and presentation metadata without duplicating
  the full cumulative output

#### Scenario: Terminal result exceeds the durable payload limit

- **WHEN** a final tool result is larger than the configured durable activity limit
- **THEN** the stored result is deterministically truncated or summarized and indicates that detail
  was omitted

#### Scenario: Provider diagnostics are enabled

- **WHEN** bounded canonical events omit raw protocol detail needed for diagnosis
- **THEN** rotating provider diagnostics may retain the existing redacted native record without
  adding that raw payload to orchestration state

### Requirement: Expose provider-flow health without high-cardinality data

The system SHALL expose operational measurements for current queue depth, oldest queued-event age,
coalesced event count, backpressure duration, and terminal-event processing latency. Measurements
MUST be attributable to provider driver and event class without using thread, turn, or tool
identifiers as metric dimensions.

#### Scenario: Ingestion begins falling behind

- **WHEN** queue depth or oldest-event age crosses its warning threshold
- **THEN** diagnostics report the pressured provider and event class without logging message
  content or high-cardinality identifiers

#### Scenario: Coalescing controls a burst

- **WHEN** repeated tool state is replaced before projection
- **THEN** the coalesced-event counter increases and terminal processing remains observable
