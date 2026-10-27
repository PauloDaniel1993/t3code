import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

// Damaged legacy metadata must remain repairable without failing a search-index trigger.
export const messageSearchJsonFieldSql = (payload: string, field: string) =>
  `json_extract(CASE WHEN json_valid(${payload}) THEN ${payload} END, '$.${field}')`;

/**
 * Exclude generated notices and subagent threads: search hides them, and ACP subagents rewrite
 * their finished answer on every streamed chunk.
 * Migration triggers, backfill, rebuild and scans share this predicate; `row` may be `new`.
 */
export const indexedMessageConditionSql = (row = "messages") => `
  ${row}.streaming = 0
  AND json_valid(${row}.payload_json)
  AND (
    ${row}.role = 'assistant'
    OR (
      ${row}.role = 'user'
      AND COALESCE(${messageSearchJsonFieldSql(`${row}.payload_json`, "createdBy")}, 'user') = 'user'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads AS subagent_threads
    WHERE subagent_threads.thread_id = ${row}.thread_id
      AND ${messageSearchJsonFieldSql("subagent_threads.payload_json", "lineage.relationshipToParent")} = 'subagent'
  )
`;

export const indexedMessageCondition = (sql: SqlClient.SqlClient, row = "messages") =>
  sql.literal(indexedMessageConditionSql(row));

/**
 * What the index stores for a message: its text with curly apostrophes
 * straight, as search folds a query, since iOS keyboards type "’" and others
 * type "'". Migration 69's triggers use it too. `payload` is the message's
 * JSON column.
 */
export const indexedMessageTextSql = (payload: string) =>
  `replace(replace(${messageSearchJsonFieldSql(payload, "text")}, '’', ''''), '‘', '''')`;

export const indexedMessageText = (sql: SqlClient.SqlClient, payload: string) =>
  sql.literal(indexedMessageTextSql(payload));

/**
 * Refills the search index from the messages table. The index is keyed by
 * message rowid, so anything that may renumber or copy rows (VACUUM, a dev
 * database copy) rebuilds it instead of trusting it. Databases from before
 * migration 69, or on an SQLite without FTS5 trigrams, have no index.
 */
export const rebuildMessageSearch = Effect.fn("MessageSearchIndex.rebuild")(function* (
  sql: SqlClient.SqlClient,
) {
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  if (index.length === 0) return;
  // One transaction: an interrupt between clear and refill would leave an
  // empty index that nothing repairs, since search only checks the table exists.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
        VALUES ('delete-all')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT messages.rowid, ${indexedMessageText(sql, "messages.payload_json")}
        FROM orchestration_v2_projection_messages AS messages
        WHERE ${indexedMessageCondition(sql)}
          AND ${indexedMessageText(sql, "messages.payload_json")} IS NOT NULL
      `;
    }),
  );
});
