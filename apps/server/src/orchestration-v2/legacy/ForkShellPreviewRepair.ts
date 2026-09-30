/**
 * Before this build hydrates a transcript, bring the timeline items an earlier
 * import left for it to this build's mapping.
 *
 * An unpatched V2 build's shell import writes each thread's previews at
 * reasoning-free ordinals, reserves those positions, and writes no source tag,
 * source-derived authorship or leniently decoded attachment. Hydrating around
 * those reservations hits upstream's unique `(thread_id, ordinal)` on the first
 * reasoning item, and task items allocated after them land in the transcript's
 * slots. So, for every thread whose transcript is not imported yet, this moves
 * each imported item's position to this build's ordinal, rewrites an item whose
 * projection differs from this build's mapping, and writes a preview this
 * build's shell import would have written but the earlier one did not.
 * Afterwards the thread's items, messages and positions are those of a fresh
 * import. Items that already match are left alone, so a restart writes nothing.
 */
import {
  EventId,
  OrchestrationV2ConversationMessageJson,
  type OrchestrationV2DomainEvent,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeUtil from "node:util";

import {
  clearForkImportWarning,
  recordForkImportWarning,
} from "../../persistence/ForkImportDiagnostics.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { forkLegacyMessageRoles } from "./ForkLegacyMessages.ts";

const TURN_ITEM_PREFIX = "migration:v1:turn-item:";
/** Suffix of the event ids that rewrite an item an earlier import wrote differently. */
export const FORK_SHELL_REPAIR_EVENT_SUFFIX = ":fork-shell-repair";

export interface ForkShellRepairRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly role: "user" | "assistant" | "reasoning";
  readonly source: string | null;
  readonly text: string;
  readonly attachments_json: string | null;
  readonly context_json: string | null;
  readonly is_streaming: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ordinal: number;
}

interface StoredRow extends ForkShellRepairRow {
  readonly item_json: string | null;
  readonly message_json: string | null;
  readonly position_ordinal: number | null;
  readonly repaired: number;
}

const encodeMessage = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const encodeTurnItem = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const sameJson = (stored: string | null, encoded: string) =>
  stored !== null && NodeUtil.isDeepStrictEqual(parseJson(stored), parseJson(encoded));

/** `messageEvents` is the importer's fork mapping, so repaired items equal hydrated ones. */
export const makeForkShellPreviewRepair = Effect.fn("makeForkShellPreviewRepair")(function* <E>(
  messageEvents: (
    row: ForkShellRepairRow,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, E>,
) {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSinkV2;

  const repairThread = (threadId: string, rows: ReadonlyArray<StoredRow>) =>
    Effect.gen(function* () {
      const moves: Array<StoredRow> = [];
      const events: Array<OrchestrationV2DomainEvent> = [];
      // Highest ordinal first: an earlier import's ordinals never exceed this
      // build's, so every move lands on a free slot, live and on replay.
      for (const row of rows.toSorted((left, right) => right.ordinal - left.ordinal)) {
        const mapped = yield* messageEvents(row);
        let matches = true;
        for (const event of mapped) {
          if (event.type === "message.updated")
            matches &&= sameJson(row.message_json, yield* encodeMessage(event.payload));
          else if (event.type === "turn-item.updated")
            matches &&= sameJson(row.item_json, yield* encodeTurnItem(event.payload));
        }
        if (row.position_ordinal !== row.ordinal) moves.push(row);
        if (matches) continue;
        if (row.repaired === 1) {
          return yield* Effect.fail(`item ${row.message_id} differs again after its repair`);
        }
        // A missing preview gets this build's own ids, as a fresh shell import writes it.
        const suffix = row.item_json === null ? "" : FORK_SHELL_REPAIR_EVENT_SUFFIX;
        events.push(...mapped.map((event) => ({ ...event, id: EventId.make(event.id + suffix) })));
      }
      if (moves.length === 0 && events.length === 0) return false;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const row of moves) {
            yield* sql`
              INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
              VALUES (${threadId}, ${TURN_ITEM_PREFIX + row.message_id}, ${row.ordinal})
              ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = excluded.ordinal
            `;
          }
          if (events.length > 0) yield* eventSink.write({ events });
          yield* clearForkImportWarning(threadId, "shell_preview_repair_failed");
        }),
      );
      yield* recordForkImportWarning(
        threadId,
        "shell_preview_repair",
        "An earlier V2 import wrote this thread's timeline items with another mapping; they were rewritten with this build's before hydration.",
        yield* encodeJson(
          moves.map((row) => ({ messageId: row.message_id, ordinal: row.position_ordinal })),
        ),
      );
      return true;
    });

  return Effect.gen(function* () {
    const rows = yield* sql<StoredRow>`
      WITH legacy AS (
        SELECT message.message_id, message.thread_id, message.role, message.source, message.text,
          message.attachments_json, message.context_json, message.is_streaming,
          message.created_at, message.updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY message.thread_id ORDER BY message.created_at, message.message_id
          ) AS ordinal,
          -- This build's shell previews: the latest message and the latest user message.
          ROW_NUMBER() OVER (
            PARTITION BY message.thread_id ORDER BY message.created_at DESC, message.message_id DESC
          ) AS latest,
          ROW_NUMBER() OVER (
            PARTITION BY message.thread_id, message.role = 'user'
            ORDER BY message.created_at DESC, message.message_id DESC
          ) AS latest_of_role
        FROM projection_thread_messages AS message
        JOIN orchestration_v2_legacy_imports AS imported
          ON imported.thread_id = message.thread_id AND imported.transcript_imported_at IS NULL
        WHERE ${sql.in("message.role", forkLegacyMessageRoles)}
      )
      SELECT legacy.message_id, legacy.thread_id, legacy.role, legacy.source, legacy.text,
        legacy.attachments_json, legacy.context_json, legacy.is_streaming,
        legacy.created_at, legacy.updated_at, legacy.ordinal,
        item.payload_json AS item_json,
        message.payload_json AS message_json,
        position.ordinal AS position_ordinal,
        EXISTS (
          SELECT 1 FROM orchestration_events
          WHERE event_id = ${TURN_ITEM_PREFIX} || legacy.message_id || ${FORK_SHELL_REPAIR_EVENT_SUFFIX}
        ) AS repaired
      FROM legacy
      LEFT JOIN orchestration_v2_projection_turn_items AS item
        ON item.turn_item_id = ${TURN_ITEM_PREFIX} || legacy.message_id
      LEFT JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = legacy.message_id
      LEFT JOIN orchestration_v2_turn_item_positions AS position
        ON position.thread_id = legacy.thread_id
        AND position.turn_item_id = ${TURN_ITEM_PREFIX} || legacy.message_id
      WHERE item.turn_item_id IS NOT NULL OR legacy.latest = 1
        OR (legacy.role = 'user' AND legacy.latest_of_role = 1)
      ORDER BY legacy.thread_id
    `;
    const byThread = Map.groupBy(rows, (row) => row.thread_id);
    let repairedThreadCount = 0;
    for (const [threadId, threadRows] of byThread) {
      // One thread's failure leaves it to fail hydration as before, recorded, and retried next start.
      const repaired = yield* repairThread(threadId, threadRows).pipe(
        Effect.catch((cause) =>
          recordForkImportWarning(
            threadId,
            "shell_preview_repair_failed",
            "Timeline items an earlier V2 import wrote could not be rewritten; hydration may fail for this thread.",
            String(cause),
          ).pipe(Effect.as(false)),
        ),
      );
      if (repaired) repairedThreadCount += 1;
    }
    if (repairedThreadCount > 0) {
      yield* Effect.logWarning("Rewrote timeline items an earlier V2 import wrote (ticket 28)", {
        repairedThreadCount,
        evidence: "statev2.sqlite: fork_v1_import_warnings, field shell_preview_repair",
      });
    }
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
});
