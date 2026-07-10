/**
 * ForkMigrations - migration runner for fork-specific schema changes
 *
 * This repository is a fork. The base repository owns `Migrations.ts`, the
 * `effect_sql_migrations` ledger, and its entire id space: the fork must never
 * add entries there. Effect's Migrator only runs ids greater than the latest
 * recorded id, so a fork id below the base's next id is silently skipped and a
 * fork id above it (like the old 999) blocks every future base migration.
 *
 * Fork schema changes instead live here, numbered 1, 2, 3, ... and recorded in
 * the separate `fork_sql_migrations` table. Rules:
 *
 * - New fork migrations go in `ForkMigrations/` and are registered below.
 *   Never touch `Migrations.ts`; keep it identical to the base repository.
 * - Every fork migration must be idempotent (guarded ALTER / IF NOT EXISTS),
 *   because databases migrated before this split already carry the schema.
 * - Fork migrations run after the base migrations each startup.
 * - If a fork feature is upstreamed, replace the fork migration body with a
 *   reconcile step that records the incoming base migration id as applied in
 *   `effect_sql_migrations` on databases where the fork already ran the DDL.
 */

import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_ProviderThreadHandoff.ts";
import ForkMigration0002 from "./ForkMigrations/002_ProjectionThreadMessageModelReroute.ts";

export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

export const forkMigrationEntries = [
  [1, "ProviderThreadHandoff", ForkMigration0001],
  [2, "ProjectionThreadMessageModelReroute", ForkMigration0002],
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
 * One-time repair for databases migrated before the fork ledger existed.
 *
 * Fork migrations used to be recorded in `effect_sql_migrations` as ids 33,
 * 999, and 1000. Those rows poison the base sequence (999+ makes the migrator
 * skip every future base id, and 33 collides with the base's own future 33),
 * so they are removed before the base migrator runs. The schema they created
 * is re-covered by the idempotent fork migrations.
 */
export const reconcileBaseMigrationLedger = Effect.fn("reconcileBaseMigrationLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
  if (ledger.length === 0) {
    return;
  }
  const removed = yield* sql`
      DELETE FROM effect_sql_migrations
      WHERE migration_id IN (33, 999, 1000)
      RETURNING migration_id
    `;
  if (removed.length > 0) {
    yield* Effect.log("Removed legacy fork migration ids from the base ledger").pipe(
      Effect.annotateLogs({
        migrationIds: removed.map((row) => String(row["migration_id"])),
      }),
    );
  }
});

/**
 * Run all pending fork migrations against the `fork_sql_migrations` ledger.
 * Must run after the base `runMigrations` so fork DDL can build on base schema.
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
