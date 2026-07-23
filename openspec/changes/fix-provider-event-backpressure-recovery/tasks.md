## 1. Contracts and Flow-Control Policy

- [x] 1.1 Define tested server constants for ACP coalescing cadence, per-thread queue capacity,
      reserved lossless capacity, canonical payload limits, and activity page sizes.
- [x] 1.2 Add provider-event classification and stable tool-activity identity helpers with focused
      unit tests for lossless, mergeable, and replaceable event classes.
- [x] 1.3 Add additive contract schemas for activity upserts, initial activity-page metadata,
      opaque history cursors, and older-activity request/response messages.
- [x] 1.4 Add contract schemas for interrupted startup recovery and typed pending-turn recovery
      failures while preserving decoding of snapshots produced before this change.
- [x] 1.5 Add additive maintenance estimate, phase, progress, completion, and typed failure contracts
      without exposing compacted provider payload content.

## 2. ACP Tool Progress Normalization

- [x] 2.1 Implement a deterministic secret-safe normalizer that removes full intermediate tool data
      and caps terminal serialized data with explicit truncation metadata.
- [x] 2.2 Implement keyed ACP tool-progress coalescing that emits first, bounded periodic latest, and
      terminal state while keeping separate tool identities independent.
- [x] 2.3 Integrate the coalescer into `AcpSessionRuntime` so Kimi, Cursor, Grok, and future ACP
      adapters share the same behavior without adapter-specific throttles.
- [x] 2.4 Add focused ACP tests for cumulative output, interleaved tools, failed/completed terminal
      flushes, cancellation, and notification-stream shutdown.
- [x] 2.5 Add a synthetic high-volume ACP regression proving tens of thousands of updates produce a
      bounded canonical event count and retain the final tool and turn state.

## 3. Fair Provider Runtime Ingestion

- [x] 3.1 Implement a scoped bounded provider-ingestion scheduler with per-thread lanes, keyed
      replacement, adjacent lossless-delta merging, round-robin selection, and deterministic draining.
- [x] 3.2 Reserve lossless capacity and enforce same-item flush ordering so terminal, approval,
      user-input, assistant, and error events cannot be dropped behind replaceable progress.
- [x] 3.3 Replace the generic unbounded worker in `ProviderRuntimeIngestion` with the dedicated
      scheduler without changing unrelated reactor workers.
- [x] 3.4 Instrument queue depth, oldest-event age, coalescing, backpressure, and terminal latency
      using provider/event-class dimensions only, with thresholded secret-safe warnings.
- [x] 3.5 Add scheduler tests proving cross-provider fairness, bounded pressure behavior, exact
      assistant text reconstruction, terminal ordering, and interruption-safe scope shutdown.
- [x] 3.6 Add an ingestion stress test where a Kimi-style progress flood runs concurrently with a
      Codex completion and assert that both terminal projections finish within the focused test bound.

## 4. Stable Tool Activity Projection

- [x] 4.1 Add activity-upsert orchestration command/event handling and durable receipts while
      retaining append behavior for non-replaceable and historical activities.
- [x] 4.2 Update activity persistence and projection logic to replace a stable logical tool row
      without changing its original display order.
- [x] 4.3 Map provider tool start, progress, completion, and failure to deterministic logical
      activity identities and bounded intermediate/terminal payloads.
- [x] 4.4 Update shared client-runtime reducers to replace activities by identity and deduplicate
      replayed or paged rows without disrupting the live activity order.
- [x] 4.5 Add focused orchestration, projection, and reducer tests proving one logical row per tool,
      distinct concurrent tools, terminal finalization, and compatibility with appended activities.
- [x] 4.6 Add a persistence-growth regression proving repeated cumulative updates do not cause row
      or payload growth proportional to the raw update count.

## 5. Bounded Activity Snapshots and Paging

- [x] 5.1 Change snapshot SQL to select only the latest configured activity window per thread at the
      database layer and return `hasMoreBefore` plus an opaque composite cursor.
- [x] 5.2 Implement validated older-activity page queries using sequence, creation time, and activity
      identity tie-breakers with `limit + 1` pagination.
- [x] 5.3 Wire activity-history requests and typed responses through the server WebSocket protocol
      with authorization and malformed-cursor handling.
- [x] 5.4 Extend client-runtime thread state with per-thread history-page metadata and prepend
      identity-deduplicated pages while preserving live tail events.
- [x] 5.5 Add the web timeline interaction for loading older activity and preserve scroll position,
      loading state, retry state, and accessibility announcements.
- [x] 5.6 Add equivalent bounded-history state and loading behavior to the mobile thread surface.
- [x] 5.7 Add focused query and client tests for large histories, equal timestamps, invalid cursors,
      page boundaries, live-update races, and backward-compatible snapshots without page metadata.

## 6. Crash-Safe Provider Session Recovery

- [x] 6.1 Add repository queries for persisted starting/running bindings, projected active turns,
      live adapter ownership, and pending turn starts with no provider turn id.
- [x] 6.2 Implement an idempotent startup recovery service that marks unmatched active turns
      interrupted, clears active-turn markers, makes runtime bindings non-running, and preserves valid
      resume cursors.
- [x] 6.3 Implement exactly-once re-enqueue for never-delivered pending turn starts using durable
      command receipts, and map unrecoverable sends to visible typed terminal errors.
- [x] 6.4 Ensure turns that already have a provider turn id are interrupted without automatic resend
      and cleanly stopped sessions remain unchanged.
- [x] 6.5 Insert recovery and projection draining into the server startup readiness barrier before
      provider commands, snapshots, or client synchronization are accepted.
- [x] 6.6 Add aggregate secret-safe recovery diagnostics for reconciled sessions, interrupted turns,
      replayed pending requests, and failures.
- [x] 6.7 Add focused restart tests for lost terminal events, preserved cursors, pending replay,
      repeated crashes during recovery, provider unavailability, clean shutdown, and concurrent client
      connection attempts.

## 7. Existing Database Compaction and Physical Reclamation

- [x] 7.1 Add a compaction journal and repository for safety watermark, phase, batch cursor,
      eligible/skipped counts, logical bytes, physical bytes, and terminal outcome.
- [x] 7.2 Implement a secret-safe estimator for database size, free pages, reclaimable event payload
      bytes, superseded projection bytes, temporary disk requirement, and compaction eligibility.
- [x] 7.3 Implement bounded replay-safe rewriting of eligible historical `tool.updated` event
      payloads while preserving event ids, sequences, stream versions, command ids, metadata, and
      causation relationships.
- [x] 7.4 Compact superseded legacy `tool.updated` projection rows by derived logical identity while
      retaining terminal state and every non-tool activity, message, request, and checkpoint.
- [x] 7.5 Make logical compaction watermark-bounded, resumable, idempotent, and conservative for
      malformed or unclassifiable rows, with aggregate progress reporting.
- [x] 7.6 Make projection replay derive the same stable identity for compacted legacy envelopes so a
      rebuild produces the same bounded user-visible state without decode failures.
- [x] 7.7 Add a pre-open maintenance helper that obtains exclusive database ownership, checkpoints
      sidecars, verifies free disk, and creates a sibling compact candidate with `VACUUM INTO`.
- [x] 7.8 Validate the candidate with SQLite integrity checks and T3 sequence, stream-head,
      projection-watermark, lifecycle, message, checkpoint, and compaction-journal invariants.
- [x] 7.9 Implement crash-safe original-to-rollback and candidate-to-active atomic replacement,
      deterministic recovery of partial maintenance files, and rollback retention through startup
      readiness.
- [x] 7.10 Add a controlled maintenance command and desktop/backend restart path that refuses active
      provider work, reports estimate and progress, and reports before/after disk usage.
- [x] 7.11 Add focused logical-compaction tests for large histories, missing legacy fields, stream
      heads, receipt idempotency, causation, concurrent later appends, interrupted batches, reruns, and
      full replay equivalence.
- [x] 7.12 Add physical-maintenance tests for insufficient disk, active writers, corrupt candidates,
      interruption before and after swap, rollback selection, WAL sidecars, integrity failures, and
      verified file-size reduction.

## 8. Focused Verification

- [x] 8.1 Run focused contract, ACP, provider-ingestion, orchestration, persistence, migration, and
      client-runtime tests for the changed files and record the commands used.
- [x] 8.2 Run targeted formatting, lint, and type checks for the affected packages without invoking
      the full workspace suites.
- [x] 8.3 Run the high-volume event and large-snapshot regression against a temporary database and
      confirm bounded rows, bounded payload bytes, terminal fairness, and bounded snapshot response.
- [x] 8.4 Run the current-incident-shaped compaction regression against a temporary 1 GB-class
      database and verify replay equivalence plus substantial physical file-size reduction.
- [x] 8.5 Use the `test-t3-app` skill for one integrated web pass covering live tool updates,
      terminal completion, older-history loading, recovered interrupted state, and the controlled
      maintenance flow.
- [ ] 8.6 Use the `test-t3-mobile` skill for one representative mobile pass covering bounded history,
      live activity merging, and recovered interrupted state.

## 9. Review Remediation

- [x] 9.1 Make terminal tool-data truncation provider-neutral with a discriminated contract envelope
      used only when truncation occurs, and cover ACP normalization through runtime ingestion.
- [x] 9.2 Make stable activity collapse terminal-safe across live coalescing, projection replay,
      compaction retention, and client reducers while separating legacy identities by provider
      instance.
- [x] 9.3 Isolate startup recovery per row and per dispatch, tolerate corrupt recovery rows, settle
      turns-only candidates, bound provider I/O, and degrade recovery failures without bricking
      command readiness.
- [x] 9.4 Align compaction estimates and blockers with executable predicates, allow terminal journals
      to rerun, and harden physical maintenance recovery, cleanup, ownership checks, and filesystem
      durability.
- [x] 9.5 Capability-gate activity upserts for older clients, fix cached history retry handling,
      preserve durable live ordering, and align client tie-breaking with SQLite ordering.
- [x] 9.6 Preserve Codex MCP item identity, avoid anonymous progress mis-coalescing, bound ACP ingress,
      and make scheduler draining wait for backpressured enqueues.
