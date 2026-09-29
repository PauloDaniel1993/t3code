import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const ATTACHMENT_REFERENCE_TABLE = "fork_v2_attachment_references";

/** Derived from projections, including lazy legacy transcripts; never from filenames. */
export const initializeAttachmentReferenceIndex = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const exists = yield* sql`SELECT 1 FROM sqlite_master WHERE name = ${ATTACHMENT_REFERENCE_TABLE}`;
  if (exists.length > 0) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(`CREATE TABLE ${ATTACHMENT_REFERENCE_TABLE} (
      source TEXT NOT NULL, row_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL, attachment_json TEXT NOT NULL,
      PRIMARY KEY (source, row_id, attachment_id, attachment_json)
    )`);
      yield* sql.unsafe(
        `CREATE INDEX fork_v2_attachment_id_idx ON ${ATTACHMENT_REFERENCE_TABLE}(attachment_id, thread_id)`,
      );
      yield* sql.unsafe(
        `CREATE INDEX fork_v2_attachment_thread_idx ON ${ATTACHMENT_REFERENCE_TABLE}(thread_id)`,
      );
      for (const source of [
        {
          name: "message",
          table: "orchestration_v2_projection_messages",
          key: "message_id",
          payload: (row: string) => `json_extract(${row}.payload_json, '$.attachments')`,
          // The common streaming update has no attachments. Avoid parsing its growing text.
          changed: `NOT (NEW.streaming = 1 AND instr(NEW.payload_json, '"attachments":[]') > 0 AND instr(OLD.payload_json, '"attachments":[]') > 0)`,
        },
        {
          name: "item",
          table: "orchestration_v2_projection_turn_items",
          key: "turn_item_id",
          payload: (row: string) =>
            `json_object('attachments', json_extract(${row}.payload_json, '$.attachments'), 'answers', json_extract(${row}.payload_json, '$.questionAnswer.attachmentsByQuestionId'))`,
          changed: `(NEW.type IN ('user_message', 'assistant_message', 'user_input_request') OR OLD.type IN ('user_message', 'assistant_message', 'user_input_request')) AND NOT (NEW.type = 'assistant_message' AND instr(NEW.payload_json, '"streaming":true') > 0 AND (instr(NEW.payload_json, '"attachments":[]') > 0 OR instr(NEW.payload_json, '"attachments":') = 0) AND (instr(OLD.payload_json, '"attachments":[]') > 0 OR instr(OLD.payload_json, '"attachments":') = 0))`,
        },
        {
          name: "legacy",
          table: "projection_thread_messages",
          key: "message_id",
          payload: (row: string) => `${row}.attachments_json`,
          changed:
            "NEW.attachments_json IS NOT OLD.attachments_json OR NEW.thread_id IS NOT OLD.thread_id",
        },
      ]) {
        const rawPayload = source.payload;
        const jsonColumn = (row: string) =>
          `${row}.${source.name === "legacy" ? "attachments_json" : "payload_json"}`;
        const safePayload = (row: string) =>
          `CASE WHEN json_valid(${jsonColumn(row)}) THEN ${rawPayload(row)} ELSE NULL END`;
        const invalidRow = (row: string) =>
          `${jsonColumn(row)} IS NOT NULL AND NOT json_valid(${jsonColumn(row)})`;
        const invalid = (row: string) => `INSERT OR IGNORE INTO ${ATTACHMENT_REFERENCE_TABLE}
        SELECT '${source.name}', ${row}.${source.key}, ${row}.thread_id, '*', 'null' WHERE ${invalidRow(row)}`;
        const insert = (row: string) => `INSERT OR IGNORE INTO ${ATTACHMENT_REFERENCE_TABLE}
        SELECT '${source.name}', ${row}.${source.key}, ${row}.thread_id,
          json_extract(attachment.value, '$.id'), attachment.value
        FROM json_tree(${safePayload(row)}) AS attachment
        WHERE attachment.type = 'object' AND json_extract(attachment.value, '$.type') IN ('image', 'file')
          AND json_extract(attachment.value, '$.id') IS NOT NULL`;
        yield* sql.unsafe(`INSERT OR IGNORE INTO ${ATTACHMENT_REFERENCE_TABLE}
        SELECT '${source.name}', row.${source.key}, row.thread_id,
          json_extract(attachment.value, '$.id'), attachment.value
        FROM ${source.table} AS row, json_tree(${safePayload("row")}) AS attachment
        WHERE attachment.type = 'object' AND json_extract(attachment.value, '$.type') IN ('image', 'file')
          AND json_extract(attachment.value, '$.id') IS NOT NULL`);
        yield* sql.unsafe(`INSERT OR IGNORE INTO ${ATTACHMENT_REFERENCE_TABLE}
        SELECT '${source.name}', row.${source.key}, row.thread_id, '*', 'null' FROM ${source.table} AS row WHERE ${invalidRow("row")}`);
        yield* sql.unsafe(`CREATE TRIGGER fork_v2_attachment_${source.name}_insert AFTER INSERT ON ${source.table}
        BEGIN ${insert("NEW")}; ${invalid("NEW")}; END`);
        yield* sql.unsafe(`CREATE TRIGGER fork_v2_attachment_${source.name}_update AFTER UPDATE ON ${source.table}
        WHEN ${source.changed}
        BEGIN DELETE FROM ${ATTACHMENT_REFERENCE_TABLE} WHERE source = '${source.name}' AND row_id = OLD.${source.key};
          ${insert("NEW")}; ${invalid("NEW")}; END`);
        yield* sql.unsafe(`CREATE TRIGGER fork_v2_attachment_${source.name}_delete AFTER DELETE ON ${source.table}
        BEGIN DELETE FROM ${ATTACHMENT_REFERENCE_TABLE} WHERE source = '${source.name}' AND row_id = OLD.${source.key}; END`);
      }
    }),
  );
});
