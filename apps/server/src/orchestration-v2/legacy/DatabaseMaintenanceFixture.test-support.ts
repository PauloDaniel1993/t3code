// @effect-diagnostics nodeBuiltinImport:off - All maintenance fixtures are disposable databases.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../../persistence/Migrations.ts";

export async function createMaintenanceFixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-maintenance-"));
  const databasePath = NodePath.join(directory, "statev2.sqlite");
  await Effect.runPromise(
    runMigrations().pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
      Effect.scoped,
    ),
  );
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA user_version = 19;
      PRAGMA application_id = 33;
      CREATE TABLE fork_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO fork_sql_migrations VALUES (8, 'BackfillProjectionThreadNativeAgents');
      CREATE TABLE future_fork_table (id INTEGER PRIMARY KEY, value BLOB, big INTEGER, real REAL);
      INSERT INTO future_fork_table VALUES (1, X'00017FFF', 9223372036854775807, 0.25);
      CREATE TABLE nullable_key (id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO nullable_key VALUES (NULL, 'z'), (NULL, 'a');
      CREATE TABLE attachment_cleanup_queue (id INTEGER PRIMARY KEY, path TEXT);
      INSERT INTO attachment_cleanup_queue VALUES (1, 'legacy/attachment');
      CREATE TABLE database_compaction_journal (journal_id TEXT PRIMARY KEY, phase TEXT);
      INSERT INTO database_compaction_journal VALUES ('database-state-compaction-v1', 'original-moved');
      ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT;
      ALTER TABLE projection_thread_messages ADD COLUMN source TEXT;
      CREATE TABLE maintenance_space (id INTEGER PRIMARY KEY, payload BLOB);
      INSERT INTO maintenance_space VALUES (1, zeroblob(1048576)), (2, zeroblob(4194304));
      DELETE FROM maintenance_space WHERE id = 2;
      INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES ('event', 'thread', 'thread', 1, 'message.updated', 'now', 'system', '{"text":"keep"}', '{}', 2);
      INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type)
        VALUES ('command', 'thread', 'thread', 'now', 1, 'accepted', 'thread.message.send');
    `);
    // Populate every V2 table against its actual migrated schema. The fixture is
    // a storage-preservation test, so opaque payloads need no provider runtime.
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND (name LIKE 'orchestration_v2_%' OR name = 'scheduled_tasks' OR name IN ('projection_projects', 'projection_threads', 'projection_thread_messages', 'projection_thread_activities'))",
      )
      .all();
    for (const table of tables) {
      const name = String(table.name);
      if (database.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get()) continue;
      const columns = database.prepare(`PRAGMA table_info("${name}")`).all();
      const values = columns.map((column) => {
        if (column.name === "status") return "pending";
        if (column.name === "payload_json" || String(column.name).endsWith("_json"))
          return '{"preserve":true}';
        if (String(column.type).toUpperCase().includes("INT")) return 1;
        return `${column.name}:fixture`;
      });
      database
        .prepare(
          `INSERT INTO "${name}" (${columns.map((column) => `"${column.name}"`).join(",")}) VALUES (${values.map(() => "?").join(",")})`,
        )
        .run(...values);
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  return { databasePath, directory };
}
