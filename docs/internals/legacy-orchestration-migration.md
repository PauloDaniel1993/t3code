# Legacy orchestration migration

Orchestration v2 snapshots `state.sqlite` into `statev2.sqlite` before opening writable persistence
on its first launch. Only the copy receives v2 migrations; the original remains available to v1.
Subsequent launches reuse the copy without refreshing it from v1. It creates v2 thread shell events first and imports
the complete user, assistant, and reasoning transcript lazily when a client reads or continues the thread. The
v1 projection tables remain the import source. Invalid project JSON is normalized only in the V2
copy; its original value is kept in `fork_v1_import_warnings`. The untouched V1 file remains the
recovery source if an import needs investigation.

## Imported data

The shell import preserves the project and thread identifiers, title, provider and model selection,
runtime and interaction modes, branch, worktree path, creation and update times, archive and delete
times, settlement override and timestamps, snooze timestamps, pin timestamp and order, and linked
pull request. The metadata repair path fills snooze, pin order, `unsettledAt`, and linked pull request
fields for threads imported before those fields were covered.

Transcript import reads user, assistant, and reasoning rows from `projection_thread_messages`.
Reasoning becomes V2 reasoning turn items whose `migration:v1:turn-item:<message-id>` identity retains the original message identifier. Fork message
source tags survive in the event payloads; task-result messages keep their user role for provider
compatibility but have system authorship. A message that was still streaming becomes an interrupted
turn item.

Fork startup reconciles the old fork ledger entries before upstream migrations, then runs the separate
fork migration chain. After shell import, [ForkTaskLinkRepair](../../apps/server/src/orchestration-v2/legacy/ForkTaskLinkRepair.ts)
commits task ancestry and native subagent records through the event sink before recovery or command admission.
Its versioned command receipts also gate event compaction. Invalid edges are explicitly accounted for in
`fork_v1_import_warnings`; an orphan stays top-level and a cycle loses the edge from its smallest thread ID.
Do not create replacement task shells before the importer: doing so prevents transcript hydration.

The named `fork(ticket-28:...)` hooks must survive upstream importer rewrites. The compatibility check
inspects stored import events and position reservations, including unfinished imports, before hydration.
An earlier importer can omit reasoning/provenance or reserve incompatible ordinals even without completing
a transcript. Such a destination is refused; a new migration-ledger marker alone cannot establish compatibility.
Stop the server and preserve/move `statev2.sqlite`, `statev2.sqlite-wal`, and `statev2.sqlite-shm` aside
(siblings may be absent), then restart to seed from untouched `state.sqlite`. Keep the moved files for any
V2-native work; that work will not appear in the fresh import. Never delete or reset individual import markers.
Attachment bytes need their own preserved copy; database reseeding cannot restore deleted files.

The importer does not translate provider session identity, native provider runs, checkpoints and
diffs, activities and tool calls, approvals, or proposed plans. V2 therefore must not present those
records as migrated history.

## First continuation

A migrated thread has no active provider thread. Its first continuation creates a fresh provider
session and sends a legacy handoff built only from user and assistant messages. The handoff selects
the newest transcript suffix within a 32,000-character budget, including section labels and the
import notice. This budget is separate from portable provider handoffs.

## Client and server cutover

Clients and servers must agree on `ORCHESTRATION_PROTOCOL_VERSION` (currently 2). The client
runtime appends `orchestrationProtocol=2` to the socket URL, and the `/ws` route rejects a missing
or mismatched version with HTTP 426 (`orchestration_protocol_incompatible`) before any RPC or auth
work runs. The client checks the environment descriptor the same way: a missing version means the
host predates protocol 2, and a different version means both sides need updating. Either direction
blocks the connection as `unsupported` with a message naming the machine to update rather than
running half-upgraded. See `packages/client-runtime/src/connection/compatibility.ts` and
`apps/server/src/ws.ts`.

## Divergent migration ids

`effect_sql_migrations` records `migration_id` and `name`, but the migrator compares ids only:
rows at or below the recorded maximum are skipped without checking names. A database that ran a
local or fork migration under an id this build later assigns to a different migration therefore
never receives this build's migration at that id. `runMigrations` logs each recorded id whose name
differs from the manifest so the skipped schema change is diagnosable. There is no safe id range
for a fork inside this ledger: any id at or below a future upstream id masks it forever, so fork
schema changes belong in a separate migration table or outside the migrator entirely.

## Recovery

There is no supported whole-thread export API. Recovery uses an untouched copy of the environment's
`userdata` directory and opens that copy with SQLite's read-only mode. The user guide documents the
queries against `projection_threads` and `projection_thread_messages`. Never start a server against
the recovery copy because startup can run migrations and write new state.

Import warnings identify the row and field in the server log and retain the rejected value and reason in
`statev2.sqlite`'s `fork_v1_import_warnings` table. Inspect a stopped recovery copy with
`SELECT entity_id, field, reason, original_value FROM fork_v1_import_warnings`.
