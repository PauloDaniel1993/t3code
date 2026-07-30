/**
 * ForkMigrations - migration runner for fork-specific schema changes
 *
 * The upstream base repository owns `Migrations.ts`, the
 * `effect_sql_migrations` ledger, and its entire id space. Fork migrations
 * must use this separate ledger so they cannot collide with or block future
 * upstream migrations.
 *
 * Rules:
 *
 * - New fork migrations go in `ForkMigrations/`, numbered 1, 2, 3, ...
 * - Fork migrations must be idempotent because their schema may already exist
 *   on databases migrated before this ledger was introduced.
 * - Reconciliation runs before base migrations; fork migrations run after.
 */

import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_AttachmentCleanupQueue.ts";
import ForkMigration0002 from "./ForkMigrations/002_ProjectionThreadSessionRecovery.ts";
import ForkMigration0003 from "./ForkMigrations/003_DatabaseCompactionJournal.ts";
import ForkMigration0004 from "./ForkMigrations/004_ProjectionThreadTasks.ts";
import ForkMigration0005 from "./ForkMigrations/005_ProjectionThreadMessageSource.ts";
import ForkMigration0006 from "./ForkMigrations/006_ProjectionThreadNativeAgents.ts";
import ForkMigration0007 from "./ForkMigrations/007_ResetProjectionThreadNativeAgents.ts";
import ForkMigration0008 from "./ForkMigrations/008_BackfillProjectionThreadNativeAgents.ts";

export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

export const forkMigrationEntries = [
  [1, "AttachmentCleanupQueue", ForkMigration0001],
  [2, "ProjectionThreadSessionRecovery", ForkMigration0002],
  [3, "DatabaseCompactionJournal", ForkMigration0003],
  [4, "ProjectionThreadTasks", ForkMigration0004],
  [5, "ProjectionThreadMessageSource", ForkMigration0005],
  [6, "ProjectionThreadNativeAgents", ForkMigration0006],
  [7, "ResetProjectionThreadNativeAgents", ForkMigration0007],
  [8, "BackfillProjectionThreadNativeAgents", ForkMigration0008],
] as const;

export const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export interface RunForkMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Remove only legacy fork-owned base-ledger rows.
 *
 * Matching both id and name preserves upstream migrations that reuse the same
 * ids. The table is intentionally kept; only stale fork rows are removed
 * before the base migrator reads its latest id.
 */
export const reconcileBaseMigrationLedger = Effect.fn("reconcileBaseMigrationLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
  if (ledger.length === 0) {
    return;
  }

  const removed = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`
      DELETE FROM effect_sql_migrations
      WHERE
        (migration_id = 33 AND name IN (
          'AttachmentCleanupQueue',
          'ProjectionThreadSessionRecovery'
        ))
        OR (migration_id = 34 AND name = 'DatabaseCompactionJournal')
      RETURNING migration_id, name
    `;
  if (removed.length > 0) {
    yield* Effect.log("Removed legacy fork migrations from the base ledger").pipe(
      Effect.annotateLogs({
        migrations: removed.map(({ migration_id, name }) => `${migration_id}_${name}`),
      }),
    );
  }
});

/**
 * Run pending fork migrations against the separate fork ledger.
 * Must run after base migrations so fork DDL can build on the base schema.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* ({
  toMigrationInclusive,
}: RunForkMigrationsOptions = {}) {
  yield* Effect.log(
    toMigrationInclusive === undefined
      ? "Running all fork migrations..."
      : `Running fork migrations 1 through ${toMigrationInclusive}...`,
  );
  const executedMigrations = yield* run({
    loader: makeForkMigrationLoader(toMigrationInclusive),
    table: FORK_MIGRATIONS_TABLE,
  });
  yield* Effect.log("Fork migrations ran successfully").pipe(
    Effect.annotateLogs({ migrations: executedMigrations.map(([id, name]) => `${id}_${name}`) }),
  );
  return executedMigrations;
});
