## Why

High-volume provider tool updates can overwhelm the shared event-ingestion path, delay terminal
events from every provider, grow persisted state without bound, and exhaust the server heap. After
an unclean exit, T3 Code currently preserves stale `running` turns and strands later user messages,
so the UI can report work that no provider process is performing.

## What Changes

- Make provider event ingestion resilient to bursty and cumulative tool progress without allowing
  one provider or thread to starve lifecycle and user-visible events from other sessions.
- Coalesce or replace intermediate tool state instead of appending every cumulative update with its
  full payload, while preserving meaningful tool lifecycle history and terminal results.
- Bound provider queues and define overload behavior that retains turn/session lifecycle events,
  approvals, user-input requests, assistant output, and final tool state.
- Bound initial thread snapshots and load older activity history incrementally so large historical
  threads do not require the server or client to materialize the entire activity store.
- Compact existing oversized provider-progress data in both the orchestration event store and
  activity projections, then physically reclaim unused SQLite pages through verified offline
  maintenance with rollback.
- Reconcile persisted provider sessions and turns after an unclean restart, surface interrupted work
  truthfully, and resume or explicitly fail stranded pending turn requests.
- Add focused stress, fairness, restart-recovery, persistence-growth, and snapshot-size regression
  coverage, plus operational metrics for queue pressure and event coalescing.

## Capabilities

### New Capabilities

- `provider-event-flow-control`: Defines bounded, fair, lifecycle-safe ingestion and coalescing for
  high-volume provider runtime events.
- `provider-session-crash-recovery`: Defines startup reconciliation for stale provider sessions,
  active turns, and pending turn requests after an unclean exit.
- `bounded-thread-activity-history`: Defines bounded initial snapshots and incremental retrieval of
  historical thread activity.
- `database-state-compaction`: Defines replay-safe logical compaction and physical SQLite space
  reclamation for databases already enlarged by provider-progress floods.

### Modified Capabilities

None.

## Impact

The change affects ACP event normalization, provider and orchestration queues, activity projection
semantics, provider-session runtime persistence, startup reconciliation, snapshot/query contracts,
WebSocket payloads, web/mobile thread synchronization, and database maintenance startup. Existing
provider adapters remain compatible, but intermediate tool updates may be coalesced, historical
activity will be loaded through bounded pages instead of an unbounded initial snapshot, and a
one-time maintenance pass may require temporary disk space and a controlled backend restart.
