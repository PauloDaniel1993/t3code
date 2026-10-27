// @effect-diagnostics nodeBuiltinImport:off - Offline validation streams rows through node:sqlite.
import * as NodeCrypto from "node:crypto";
import type * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import {
  indexedMessageConditionSql,
  indexedMessageTextSql,
} from "../orchestration-v2/messageSearchIndex.ts";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const Table = Schema.Struct({ name: Schema.String, type: Schema.String });
const Column = Schema.Struct({ name: Schema.String, pk: Schema.Number });
const decodeTables = Schema.decodeUnknownSync(Schema.Array(Table));
const decodeColumns = Schema.decodeUnknownSync(Schema.Array(Column));
const messageSearchTable = "orchestration_v2_message_search";

function derivedSearchTables(database: NodeSqlite.DatabaseSync): Set<string> {
  const definition = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(messageSearchTable)?.sql;
  if (typeof definition !== "string" || !/\bUSING\s+fts5\s*\(/i.test(definition)) return new Set();
  const shadows = new Set(
    ["data", "idx", "content", "docsize", "config"].map(
      (suffix) => `${messageSearchTable}_${suffix}`,
    ),
  );
  return new Set(
    decodeTables(database.prepare("PRAGMA main.table_list").all())
      .filter(
        (table) =>
          (table.type === "virtual" && table.name === messageSearchTable) ||
          (table.type === "shadow" && shadows.has(table.name)),
      )
      .map((table) => table.name),
  );
}

export function rebuildDatabaseMessageSearch(database: NodeSqlite.DatabaseSync): void {
  if (!derivedSearchTables(database).has(messageSearchTable)) return;
  database.exec("BEGIN");
  try {
    database.exec(`
      INSERT INTO ${messageSearchTable} (${messageSearchTable}) VALUES ('delete-all');
      INSERT INTO ${messageSearchTable} (rowid, text)
      SELECT messages.rowid, ${indexedMessageTextSql("messages.payload_json")}
      FROM orchestration_v2_projection_messages AS messages
      WHERE ${indexedMessageConditionSql()}
          AND ${indexedMessageTextSql("messages.payload_json")} IS NOT NULL;
    `);
    database.exec("COMMIT");
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
}

function hashValue(hash: NodeCrypto.Hash, value: NodeSqlite.SQLOutputValue): void {
  if (value === null) {
    hash.update("null;");
  } else if (value instanceof Uint8Array) {
    hash.update(`blob:${value.byteLength}:`).update(value);
  } else {
    const text = String(value);
    hash.update(`${typeof value}:${Buffer.byteLength(text)}:`).update(text);
  }
}

function hashRows(database: NodeSqlite.DatabaseSync, query: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const statement = database.prepare(query);
  statement.setReadBigInts(true);
  for (const row of statement.iterate()) {
    hash.update("row:");
    for (const [key, value] of Object.entries(row)) {
      hashValue(hash, key);
      hashValue(hash, value);
    }
  }
  return hash.digest("hex");
}

export function checkDatabaseIntegrity(database: NodeSqlite.DatabaseSync): void {
  const result = database.prepare("PRAGMA integrity_check").all();
  if (result.length !== 1 || result[0]?.integrity_check !== "ok") {
    throw new Error("Database failed integrity_check.");
  }
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
    throw new Error("Database failed foreign_key_check.");
  }
}

/** Validate the V2 boundary without migrating, importing, or deleting any history. */
export function requireV2Database(database: NodeSqlite.DatabaseSync): void {
  const migration = database
    .prepare("SELECT name FROM effect_sql_migrations WHERE migration_id = 55")
    .get();
  if (migration?.name !== "OrchestrationV2") {
    throw new Error("Maintenance requires an already migrated orchestration v2 database.");
  }
  const latest = database
    .prepare(
      "SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1",
    )
    .get();
  const supported = new Map([
    [56, "RemoveRedundantProjectionIndexes"],
    [57, "ScheduledTaskWebhooks"],
    [58, "WebhookRelayDeliveries"],
    [59, "McpAppModelContext"],
    [60, "ThreadSnapshotWindowIndexes"],
    [61, "PullRequestReviewGuides"],
    [62, "ThreadFailureLookupIndex"],
    [63, "DropUnusedV1Projections"],
    [64, "CanonicalizeThreadPullRequestLinks"],
    [65, "CodexUsageNativeTurnIndex"],
    [66, "RepairClientSettlementTimestamps"],
    [67, "WebhookDedupe"],
    [68, "ShellStopRequestIndex"],
    [69, "ThreadMessageSearch"],
  ]);
  if (
    typeof latest?.migration_id !== "number" ||
    supported.get(latest.migration_id) !== latest.name
  ) {
    throw new Error("Maintenance requires a supported V2 schema version (migrations 56–69).");
  }
  for (const name of [
    "orchestration_events",
    "orchestration_command_receipts",
    "orchestration_v2_projection_threads",
    "orchestration_v2_projection_metadata",
    "orchestration_v2_effect_outbox",
    "orchestration_v2_legacy_imports",
    "scheduled_tasks",
  ]) {
    if (
      !database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)
    ) {
      throw new Error(`Required V2 table is missing: ${name}.`);
    }
  }
  const derived = derivedSearchTables(database);
  for (const table of decodeTables(database.prepare("PRAGMA main.table_list").all())) {
    if (table.type !== "table" && table.type !== "view" && !derived.has(table.name)) {
      throw new Error(`Maintenance cannot validate ${table.type} table ${table.name}.`);
    }
  }
}

/**
 * Hash the schema and every stored column of every table, including future fork
 * tables, both ledgers, V1 import sources, outbox and SQLite's sequence counters.
 * Rows stream in key order; nullable/no-key tables use a complete binary ordering.
 * Hidden rowids are deliberately excluded: VACUUM may renumber those identifiers.
 */
export function fingerprintDatabase(database: NodeSqlite.DatabaseSync): string {
  // FTS is rebuilt from the fingerprinted messages; its rowids change with VACUUM.
  const derived = derivedSearchTables(database);
  const tables = decodeTables(database.prepare("PRAGMA main.table_list").all())
    .filter(({ name }) => name !== "sqlite_schema" && !derived.has(name))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = NodeCrypto.createHash("sha256");
  hash.update(
    hashRows(database, "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name"),
  );
  for (const pragma of ["user_version", "application_id", "encoding", "page_size", "auto_vacuum"]) {
    hash.update(hashRows(database, `PRAGMA ${pragma}`));
  }
  for (const table of tables) {
    if (table.type === "view") continue;
    if (table.type !== "table") {
      throw new Error(`Maintenance cannot validate ${table.type} table ${table.name}.`);
    }
    const columns = decodeColumns(
      database.prepare(`PRAGMA table_xinfo(${identifier(table.name)})`).all(),
    );
    const keys = columns.filter((column) => column.pk > 0).toSorted((a, b) => a.pk - b.pk);
    const hasNullKey =
      keys.length === 0 ||
      database
        .prepare(
          `SELECT 1 FROM ${identifier(table.name)} WHERE ${keys.map((key) => `${identifier(key.name)} IS NULL`).join(" OR ")} LIMIT 1`,
        )
        .get() !== undefined;
    const order = hasNullKey
      ? columns.flatMap(({ name }) => [
          `typeof(${identifier(name)})`,
          `${identifier(name)} COLLATE BINARY`,
        ])
      : keys.map(({ name }) => `${identifier(name)} COLLATE BINARY`);
    hashValue(hash, table.name);
    hash.update(
      hashRows(database, `SELECT * FROM ${identifier(table.name)} ORDER BY ${order.join(", ")}`),
    );
  }
  return hash.digest("hex");
}
