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

export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

export const forkMigrationEntries = [[1, "AttachmentCleanupQueue", ForkMigration0001]] as const;

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
 * Remove only the legacy fork-owned base-ledger row.
 *
 * Matching both id and name preserves a future upstream migration that uses id
 * 33 for a different migration. The table is intentionally kept; only the
 * stale row is removed before the base migrator reads its latest id.
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

  const removed = yield* sql<{ readonly migration_id: number }>`
      DELETE FROM effect_sql_migrations
      WHERE migration_id = 33 AND name = 'AttachmentCleanupQueue'
      RETURNING migration_id
    `;
  if (removed.length > 0) {
    yield* Effect.log("Removed legacy attachment cleanup migration from the base ledger").pipe(
      Effect.annotateLogs({ migrationId: "33" }),
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
