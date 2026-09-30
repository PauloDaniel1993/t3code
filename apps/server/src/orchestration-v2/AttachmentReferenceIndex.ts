/**
 * Derived from every projection and legacy transcript, never from filenames.
 * Cleanup may delete only when this index is verified complete and the file is
 * unreferenced. Missing/stale schema or an unfinished rebuild disables deletion.
 * Triggers cover background transcript imports and writes between rebuild passes.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const ATTACHMENT_REFERENCE_TABLE = "fork_v2_attachment_references";
export const ATTACHMENT_REFERENCE_VERSION = 3;
export const ATTACHMENT_REFERENCE_REBUILD_BATCH_SIZE = 64;
export const ATTACHMENT_REFERENCE_REBUILD_BUDGET_MS = 25;
const stateTable = "fork_v2_attachment_reference_state";

const sources = [
  {
    name: "message",
    table: "orchestration_v2_projection_messages",
    key: "message_id",
    payload: (row: string) => `json_extract(${row}.payload_json, '$.attachments')`,
    // Ordinary streaming updates have no attachments; don't parse growing text.
    changed: `NOT (NEW.streaming = 1 AND NEW.thread_id IS OLD.thread_id AND NEW.message_id IS OLD.message_id AND instr(NEW.payload_json, '"attachments":[]') > 0 AND instr(OLD.payload_json, '"attachments":[]') > 0)`,
  },
  {
    name: "item",
    table: "orchestration_v2_projection_turn_items",
    key: "turn_item_id",
    payload: (row: string) =>
      `json_object('attachments', json_extract(${row}.payload_json, '$.attachments'), 'answers', json_extract(${row}.payload_json, '$.questionAnswer.attachmentsByQuestionId'))`,
    changed: `(NEW.type IN ('user_message', 'assistant_message', 'user_input_request') OR OLD.type IN ('user_message', 'assistant_message', 'user_input_request')) AND NOT (NEW.type = 'assistant_message' AND NEW.thread_id IS OLD.thread_id AND NEW.turn_item_id IS OLD.turn_item_id AND instr(NEW.payload_json, '"streaming":true') > 0 AND (instr(NEW.payload_json, '"attachments":[]') > 0 OR instr(NEW.payload_json, '"attachments":') = 0) AND (instr(OLD.payload_json, '"attachments":[]') > 0 OR instr(OLD.payload_json, '"attachments":') = 0))`,
  },
  {
    name: "legacy",
    table: "projection_thread_messages",
    key: "message_id",
    payload: (row: string) => `${row}.attachments_json`,
    changed:
      "NEW.attachments_json IS NOT OLD.attachments_json OR NEW.thread_id IS NOT OLD.thread_id OR NEW.message_id IS NOT OLD.message_id",
  },
];

function inserts(source: (typeof sources)[number], row: string, from = "", where = "1") {
  const column = `${row}.${source.name === "legacy" ? "attachments_json" : "payload_json"}`;
  const safePayload = `CASE WHEN json_valid(${column}) THEN ${source.payload(row)} ELSE NULL END`;
  // Unknown/document descriptors retain their ID, but never authorize a download.
  return [
    `INSERT OR IGNORE INTO ${ATTACHMENT_REFERENCE_TABLE}
      SELECT '${source.name}', ${row}.${source.key}, ${row}.thread_id,
        json_extract(attachment.value, '$.id'), attachment.value
      FROM ${from === "" ? "" : `${from}, `}json_tree(${safePayload}) AS attachment
      WHERE ${where} AND attachment.type = 'object'
        AND json_extract(attachment.value, '$.id') IS NOT NULL`,
    `INSERT OR IGNORE INTO ${ATTACHMENT_REFERENCE_TABLE}
      SELECT '${source.name}', ${row}.${source.key}, ${row}.thread_id, '*', 'null'
      ${from === "" ? "" : `FROM ${from}`}
      WHERE ${where} AND ${column} IS NOT NULL AND NOT json_valid(${column})`,
  ];
}

const definitions = [
  {
    type: "table",
    name: ATTACHMENT_REFERENCE_TABLE,
    ddl: `CREATE TABLE ${ATTACHMENT_REFERENCE_TABLE} (
      source TEXT NOT NULL, row_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL, attachment_json TEXT NOT NULL,
      PRIMARY KEY (source, row_id, attachment_id, attachment_json)
    )`,
  },
  {
    type: "table",
    name: stateTable,
    ddl: `CREATE TABLE ${stateTable} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL,
      complete INTEGER NOT NULL, source_index INTEGER NOT NULL, cursor TEXT
    )`,
  },
  {
    type: "index",
    name: "fork_v2_attachment_id_nocase_idx",
    ddl: `CREATE INDEX fork_v2_attachment_id_nocase_idx ON ${ATTACHMENT_REFERENCE_TABLE}(attachment_id COLLATE NOCASE, thread_id)`,
  },
  {
    type: "index",
    name: "fork_v2_attachment_id_idx",
    ddl: `CREATE INDEX fork_v2_attachment_id_idx ON ${ATTACHMENT_REFERENCE_TABLE}(attachment_id, thread_id)`,
  },
  {
    type: "index",
    name: "fork_v2_attachment_thread_idx",
    ddl: `CREATE INDEX fork_v2_attachment_thread_idx ON ${ATTACHMENT_REFERENCE_TABLE}(thread_id)`,
  },
  ...sources.flatMap((source) => {
    const remove = `DELETE FROM ${ATTACHMENT_REFERENCE_TABLE} WHERE source = '${source.name}' AND row_id = OLD.${source.key}`;
    return [
      {
        type: "trigger",
        name: `fork_v2_attachment_${source.name}_insert`,
        ddl: `CREATE TRIGGER fork_v2_attachment_${source.name}_insert AFTER INSERT ON ${source.table}
          BEGIN ${inserts(source, "NEW").join("; ")}; END`,
      },
      {
        type: "trigger",
        name: `fork_v2_attachment_${source.name}_update`,
        ddl: `CREATE TRIGGER fork_v2_attachment_${source.name}_update AFTER UPDATE ON ${source.table}
          WHEN ${source.changed}
          BEGIN ${remove}; ${inserts(source, "NEW").join("; ")}; END`,
      },
      {
        type: "trigger",
        name: `fork_v2_attachment_${source.name}_delete`,
        ddl: `CREATE TRIGGER fork_v2_attachment_${source.name}_delete AFTER DELETE ON ${source.table}
          BEGIN ${remove}; END`,
      },
    ];
  }),
];
const normalizeDdl = (ddl: string) => ddl.replace(/\s+/g, " ").trim();
const schemaCache = new WeakMap<SqlClient.SqlClient, { version: number; valid: boolean }>();

const hasExpectedSchema = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  // SQLite changes this cookie on DDL, including DDL from other connections.
  const [cookie] = yield* sql<{ schema_version: number }>`PRAGMA schema_version`;
  const cached = schemaCache.get(sql);
  if (cookie !== undefined && cached?.version === cookie.schema_version) return cached.valid;
  const actual = yield* sql<{ type: string; name: string; sql: string }>`
    SELECT type, name, sql FROM sqlite_master WHERE ${sql.in(
      "name",
      definitions.map((definition) => definition.name),
    )} AND sql IS NOT NULL
  `;
  const valid =
    actual.length === definitions.length &&
    definitions.every((expected) =>
      actual.some(
        (row) =>
          row.type === expected.type &&
          row.name === expected.name &&
          normalizeDdl(row.sql) === normalizeDdl(expected.ddl),
      ),
    );
  if (cookie !== undefined) schemaCache.set(sql, { version: cookie.schema_version, valid });
  return valid;
});

interface RebuildState {
  version: number;
  complete: number;
  source_index: number;
  cursor: string | null;
}

export const readAttachmentReferenceIndexState = Effect.fnUntraced(function* () {
  if (!(yield* hasExpectedSchema())) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql<RebuildState>`SELECT version, complete, source_index, cursor FROM ${sql(stateTable)} WHERE singleton = 1`;
  const state = rows[0];
  return state?.version === ATTACHMENT_REFERENCE_VERSION &&
    (state.complete === 0 || (state.complete === 1 && state.source_index === sources.length)) &&
    state.source_index >= 0 &&
    state.source_index <= sources.length
    ? state
    : undefined;
});

export class AttachmentReferenceIndexUnavailable extends Schema.TaggedError<AttachmentReferenceIndexUnavailable>()(
  "AttachmentReferenceIndexUnavailable",
  {},
) {}

/** Call in the same SQL transaction as the reference lookup and unlink. */
export const requireCompleteAttachmentReferenceIndex = Effect.fnUntraced(function* () {
  if ((yield* readAttachmentReferenceIndexState())?.complete !== 1)
    return yield* new AttachmentReferenceIndexUnavailable();
});

export const isCompleteAttachmentReferenceIndex = Effect.fnUntraced(function* () {
  return (yield* readAttachmentReferenceIndexState())?.complete === 1;
});

/** Source lookups during rebuilding only; never use them to authorize deletion. */
export const attachmentSourceRows = Effect.fnUntraced(function* (
  threadId?: string,
  row?: { source: "message" | "item"; id: string },
  remaining?: RebuildState,
) {
  const sql = yield* SqlClient.SqlClient;
  const queries = sources
    .filter(
      (source, index) =>
        (row === undefined || source.name === row.source) &&
        (remaining === undefined || index >= remaining.source_index),
    )
    .map((source) => {
      const column = source.name === "legacy" ? "attachments_json" : "payload_json";
      return sql`SELECT ${source.name} AS source, entry.thread_id,
      CASE WHEN json_valid(${sql(`entry.${column}`)}) THEN ${sql.unsafe(source.payload("entry"))} ELSE NULL END AS payload_json
      FROM ${sql(source.table)} AS entry
      WHERE ${threadId === undefined ? sql`1` : sql`entry.thread_id = ${threadId}`}
        AND ${row === undefined ? sql`1` : sql`${sql(`entry.${source.key}`)} = ${row.id}`}
        AND ${
          remaining?.cursor != null && source === sources[remaining.source_index]
            ? sql`${sql(`entry.${source.key}`)} > ${remaining.cursor}`
            : sql`1`
        }`;
    });
  return queries.length === 0
    ? sql`SELECT NULL AS source, NULL AS thread_id, NULL AS payload_json WHERE 0`
    : sql.join(" UNION ALL ", false)(queries);
});

/** Idempotent migration/fallback: only DDL and indexed existence checks, no backfill. */
export const initializeAttachmentReferenceIndex = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const state = yield* readAttachmentReferenceIndexState();
        if (state !== undefined) return state.complete === 1;
        // A missing trigger may have missed both inserts and deletes. Trust no old rows.
        for (const definition of definitions.toReversed())
          yield* sql.unsafe(`DROP ${definition.type.toUpperCase()} IF EXISTS ${definition.name}`);
        for (const definition of definitions) yield* sql.unsafe(definition.ddl);
        let empty = true;
        for (const source of sources) {
          const rows = yield* sql.unsafe(`SELECT ${source.key} FROM ${source.table} LIMIT 1`);
          if (rows.length > 0) empty = false;
        }
        yield* sql`INSERT INTO ${sql(stateTable)} (singleton, version, complete, source_index, cursor)
      VALUES (1, ${ATTACHMENT_REFERENCE_VERSION}, ${empty ? 1 : 0}, ${empty ? sources.length : 0}, NULL)`;
        return empty;
      }),
    )
    .pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          schemaCache.delete(sql);
        }),
      ),
    );
});

/** Release the connection after <=64 rows or 25ms, checked between individual rows. */
export const rebuildAttachmentReferenceIndexPass = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* initializeAttachmentReferenceIndex();
        const state = yield* readAttachmentReferenceIndexState();
        if (state === undefined) return yield* new AttachmentReferenceIndexUnavailable();
        if (state.complete === 1) return true;
        const source = sources[state.source_index];
        if (source === undefined) {
          yield* sql`UPDATE ${sql(stateTable)} SET complete = 1 WHERE singleton = 1`;
          return true;
        }
        const rows = yield* sql.unsafe<{ id: string }>(
          `SELECT ${source.key} AS id FROM ${source.table} ${state.cursor === null ? "" : `WHERE ${source.key} > ?`}
        ORDER BY ${source.key} LIMIT ${ATTACHMENT_REFERENCE_REBUILD_BATCH_SIZE}`,
          state.cursor === null ? [] : [state.cursor],
        );
        if (rows.length === 0) {
          yield* sql`UPDATE ${sql(stateTable)} SET source_index = ${state.source_index + 1}, cursor = NULL WHERE singleton = 1`;
          return false;
        }
        const started = performance.now();
        for (const row of rows) {
          for (const insert of inserts(
            source,
            "row",
            `${source.table} AS row`,
            `row.${source.key} = ?`,
          ))
            yield* sql.unsafe(insert, [row.id]);
          yield* sql`UPDATE ${sql(stateTable)} SET cursor = ${row.id} WHERE singleton = 1`;
          if (performance.now() - started >= ATTACHMENT_REFERENCE_REBUILD_BUDGET_MS) break;
        }
        return false;
      }),
    )
    .pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          schemaCache.delete(sql);
        }),
      ),
    );
});

/** Drainable by tests; each failed pass retries with Clock-driven, capped backoff. */
export const rebuildAttachmentReferenceIndex = Effect.fnUntraced(function* () {
  while (
    !(yield* rebuildAttachmentReferenceIndexPass().pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Attachment reference rebuild pass failed; retrying", { error }),
      ),
      Effect.retry(
        Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("5 seconds")]),
      ),
    ))
  )
    yield* Effect.yieldNow;
});

/** Run after base and fork migrations. Rebuilding existing data never holds startup. */
export const startAttachmentReferenceIndex = Effect.fnUntraced(function* () {
  if (yield* initializeAttachmentReferenceIndex()) return;
  return yield* rebuildAttachmentReferenceIndex().pipe(Effect.forkScoped);
});
