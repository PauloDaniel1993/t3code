## Context

The incident that motivated this change involved two Kimi ACP threads producing 40,577 durable
`tool.updated` activities before completion. Intermediate records copied cumulative tool data into
both `orchestration_events` and `projection_thread_activities`; those tables reached approximately
583 MB and 509 MB respectively in a 1.24 GB state database. Provider runtime ingestion processes a
single unbounded worker queue, so the Kimi traffic delayed terminal events from both Kimi and Codex.
The initial snapshot query also materializes every activity for every thread. The server eventually
exhausted a roughly 3.6 GB JavaScript heap, and unclean restarts left three sessions and their active
turns permanently marked `running`.

Inspection of the affected database found 59,537 projected `tool.updated` rows representing only
293 logical tool identities. Those rows contain approximately 367 MB in the activity projection,
while their matching event-store payloads contain approximately 382 MB. Preventing future growth is
therefore insufficient: existing installations need logical compaction and a physical SQLite
rebuild to return unused pages to the filesystem.

The solution crosses ACP normalization, the provider event bus, orchestration commands and
projections, persistence migrations, startup ordering, WebSocket contracts, and client state.
Provider-native rotating diagnostics remain available, but canonical durable state must be bounded
and safe to synchronize.

## Goals / Non-Goals

**Goals:**

- Keep lifecycle, assistant, approval, user-input, and error events lossless and ordered.
- Bound memory and persistence growth caused by replaceable provider progress.
- Prevent one thread or provider from starving another.
- Keep initial synchronization proportional to configured page limits rather than total history.
- Repair stale running turns and durable pending requests deterministically after an unclean exit.
- Preserve provider resume cursors without pretending an unverifiable in-flight turn completed.
- Reduce existing databases by compacting replay-safe provider progress and physically reclaiming
  freed SQLite pages with validation and rollback.

**Non-Goals:**

- Preserve every byte or timing edge of intermediate tool progress in orchestration history.
- Automatically resend a turn that may already have reached a provider.
- Delete or renumber event identities, global sequences, stream versions, stream heads, command
  receipts, or causation relationships.
- Replace provider-native diagnostic logs or change provider authentication.
- Introduce cross-device execution failover for an actively running local provider process.

## Decisions

### 1. Classify event delivery semantics before buffering

Provider runtime events will be classified into three delivery classes:

- **Lossless ordered:** session and turn lifecycle, runtime errors, approval and user-input
  requests/resolutions, assistant text, and terminal tool state.
- **Mergeable ordered:** adjacent assistant deltas for the same thread, turn, item, and stream may
  be concatenated up to a byte limit without changing their text.
- **Replaceable state:** non-terminal `item.updated`, tool progress, token usage, and other
  provider-declared snapshots may retain only the newest value for a stable key.

Terminal enqueue flushes earlier mergeable content and the latest replaceable state for the same
logical item before the terminal event. This makes overload behavior explicit instead of relying on
an unbounded FIFO. Treating all events as lossless was rejected because cumulative progress has no
finite producer-side bound; dropping arbitrary events was rejected because it can corrupt the
conversation and lifecycle.

### 2. Coalesce ACP tool progress at the earliest shared boundary

ACP session runtime will coalesce `tool_call_update` notifications by provider instance, thread,
turn, and tool-call id before they become canonical events. The first meaningful state, bounded
periodic latest state, and terminal state are emitted; repeated cumulative detail inside the
coalescing window replaces the pending value. Kimi, Cursor, Grok, and future ACP adapters therefore
share one rule.

Intermediate canonical tool state will contain presentation fields only: identity, kind, status,
title, and bounded detail. Full `rawInput`, `rawOutput`, content arrays, locations, and protocol
payloads will not ride the durable intermediate event. Terminal data will pass through a
deterministic serialized-size cap and indicate truncation. Native provider logs remain the
diagnostic source for redacted raw protocol records.

Adapter-only throttling was rejected because non-ACP providers could reproduce the same failure and
because downstream fairness still needs enforcement.

### 3. Replace the ingestion worker with a bounded fair scheduler

`ProviderRuntimeIngestion` will use a dedicated scheduler rather than changing the generic
`DrainableWorker` used by unrelated reactors. The scheduler will maintain bounded per-thread lanes,
a keyed map for replaceable state, and round-robin selection across ready threads. Reserved capacity
for lossless events prevents progress from occupying every slot. If lossless capacity is exhausted,
enqueue applies backpressure; it does not discard the event.

The scheduler exposes deterministic `drain` behavior for tests and measurements for queue depth,
oldest-event age, coalescing, backpressure, and terminal latency. Metric dimensions use provider
kind and event class only. A single larger bounded FIFO was rejected because it still permits
head-of-line blocking between providers.

### 4. Project a stable logical activity for each tool lifecycle

Canonical tool lifecycle events will derive a deterministic activity identity from provider
instance, thread, turn, and tool item. A new activity-upsert command/event path will replace the
projected row with the latest state and notify clients to replace by identity. Terminal state
finalizes the same activity. Existing append-only activity commands remain supported for historical
and non-replaceable activity kinds.

Intermediate activity payloads omit canonical `data`; terminal activity payloads use the bounded
normalized result. This addresses both row count and payload duplication. Merely upserting the
projection without coalescing ingress was rejected because the immutable event store and in-memory
queue would still grow once per provider update.

### 5. Synchronize a recent activity window and page backward

Initial snapshot queries will use a window function or indexed correlated query to return the latest
configured activity count per thread, plus `hasMoreBefore` and an opaque cursor. The cursor encodes
the existing durable order `(sequence, createdAt, activityId)` and is validated as an opaque
contract value. Older-page queries read `limit + 1` rows in reverse index order and return them in
chronological display order.

Clients will track per-thread history-page state, prepend older pages with identity-based
deduplication, and continue applying live tail events normally. Optional pagination fields preserve
wire decoding during rollout. Loading all activity and trimming in application memory was rejected
because it does not prevent the observed heap failure.

### 6. Reconcile stale lifecycle state behind a startup barrier

After migrations and projection catch-up, but before server readiness and the first snapshot,
startup recovery will compare persisted starting/running bindings and projected active turns with
the adapters' live in-memory sessions. On a cold process, an unmatched active turn is unverifiable:
the system dispatches deterministic recovery commands that mark it interrupted, clear
`activeTurnId`, set the runtime binding non-running, and preserve a valid resume cursor.

Recovery then finds pending turn starts with no provider turn id. Those requests are re-enqueued
exactly once after the stale turn is cleared. Requests with an assigned provider turn id are never
automatically resent. Failure to recover becomes a visible terminal error. Recovery drains its
projection commands before opening readiness, and command receipts make repeated startup passes
idempotent.

Inferring completion from provider log files was rejected because logs are optional, rotated, and
not a transactional source of truth. Eagerly resending every running turn was rejected because it
could repeat external side effects.

### 7. Compact existing event payloads and projections below a safety watermark

A resumable maintenance migration will capture the minimum applied projector sequence and process
only rows at or below that watermark. For historical `thread.activity-appended` events whose
activity kind is replaceable `tool.updated`, it will preserve the schema-required activity
identity, thread/turn/tool identity, creation time, status, bounded summary, and bounded detail while
removing cumulative `data` fields. Event id, sequence, stream version, command id, metadata, and row
position remain unchanged. This preserves append monotonicity, command-receipt idempotency,
causation references, and decoding while reclaiming the dominant payload bytes.

The activity projection will collapse repeated legacy progress by logical tool identity, retaining
terminal state and at most bounded latest non-terminal state. Updated replay logic derives the same
stable tool activity identity, so replaying the compact envelopes does not re-expand the projection.
Rows that lack enough identity or fail schema validation are preserved and counted, never guessed.

Deleting redundant event rows was rejected because the event store allocates new stream versions
from the current stream head and command receipts expose result sequences. Payload-only compaction
recovers most of the measured space without creating version or receipt holes. Keeping the original
oversized event payloads was rejected because it would leave roughly 382 MB of known cumulative
progress data in the affected database.

### 8. Reclaim physical SQLite pages in a pre-open maintenance process

Logical updates and projection deletes create reusable SQLite pages but do not reduce the file size.
After logical compaction completes, a maintenance marker schedules a pre-open database rebuild on a
controlled backend restart. Before normal persistence layers or provider sessions start, a helper
obtains exclusive ownership, checks available disk, checkpoints WAL state, and creates a sibling
compact candidate with `VACUUM INTO`.

The candidate must pass SQLite integrity checks plus T3 invariants: schema version, maximum global
sequence, per-stream head version, projection watermarks, required lifecycle/message/checkpoint
counts, and compaction-journal completion. The helper then closes both databases, renames the
original to a rollback path, atomically installs the candidate, and starts the server. The rollback
copy is retained until migrations, projection bootstrap, crash recovery, and readiness succeed.
Candidate or swap failure restores the original before accepting writes.

In-place `VACUUM` was rejected because an atomic candidate is easier to validate and roll back.
Running physical compaction inside the live server was rejected because open writers, provider
sessions, and Windows file handles make replacement unsafe. An automatic surprise restart was
rejected; the server recommends maintenance from reclaimable-byte and free-page thresholds, while a
user action or explicit maintenance command authorizes the controlled restart.

## Risks / Trade-offs

- **Fine-grained progress is no longer a permanent timeline** → Preserve first, bounded latest, and
  terminal state; retain redacted rotating native diagnostics for deeper investigation.
- **Backpressure could propagate into a provider protocol loop** → Reserve lifecycle capacity,
  coalesce before the provider bus, and ensure no scheduler worker waits on a provider response that
  itself requires the blocked loop.
- **Stable upserts can reorder client activity unexpectedly** → Keep the activity's original
  creation order while updating its content and use identity-based reducer replacement.
- **History pagination can race live updates** → Use the durable composite cursor and client-side
  identity deduplication; never use array offsets.
- **Recovery might repeat a message** → Replay only pending rows with no assigned provider turn id
  and guard dispatch with durable command receipts.
- **Compaction may be expensive on existing databases** → Run bounded resumable batches after
  bounded snapshot support is active and expose progress and estimated savings.
- **Event payload rewriting could make replay diverge** → Preserve schema-valid identity and
  lifecycle fields, compact only below the applied watermark, and compare full projected invariants
  in focused replay tests before enabling maintenance.
- **Physical compaction needs temporary disk and exclusive ownership** → Preflight required bytes,
  refuse when work or writers are active, use a sibling candidate, and retain the original until
  the replacement reaches readiness.
- **Power loss can leave candidate or rollback files** → Persist maintenance phase markers and make
  pre-open recovery deterministically select the last validated original or installed database.
- **Older clients will not request earlier pages** → Keep a useful recent window in the initial
  snapshot and make pagination fields additive.

## Migration Plan

1. Add additive contracts for activity page metadata, history requests/responses, activity upserts,
   and interrupted startup recovery.
2. Make snapshot queries bounded before enabling any projection compaction.
3. Add ACP progress coalescing, bounded canonical payload normalization, and the fair ingestion
   scheduler behind server constants with diagnostics.
4. Switch new tool lifecycles to deterministic activity upserts and update web/mobile reducers.
5. Add the startup reconciliation barrier and idempotent pending-turn recovery.
6. Run replay-safe event-payload and projection compaction below a durable safety watermark in
   bounded resumable batches.
7. Offer the controlled maintenance action and perform the validated pre-open `VACUUM INTO` swap on
   the next authorized backend restart.
8. Enable older-history paging in web and mobile clients.

Rollback disables new coalescing and recovery paths while retaining additive schema fields. The
original database remains at the rollback path until the compact replacement reaches readiness.
Logical payload compaction is versioned and replay-equivalent; it does not renumber events or require
restoring superseded cumulative tool output.

## Open Questions

- Select default coalescing intervals, queue capacities, and activity page sizes from focused stress
  tests; keep them server constants rather than user-facing settings initially.
- Decide which terminal tool-data fields receive typed preservation before applying the generic
  serialized-size cap.
- Set the reclaimable-byte/free-page recommendation threshold and rollback-copy retention period.
- Decide whether command-line maintenance alone is sufficient for the first release or whether the
  desktop UI should expose the same restart-and-compact action immediately.
