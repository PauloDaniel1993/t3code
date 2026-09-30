import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionMaintenanceV2 } from "../ProjectionMaintenance.ts";
import { LegacyV1ThreadImporter } from "./LegacyV1ThreadImporter.ts";
import {
  REPAIR_COMMAND as TASK_LINK_REPAIR_COMMAND,
  repairForkTaskLinks,
} from "./ForkTaskLinkRepair.ts";
import {
  FORK_IMPORT_TURN_ITEM_PREFIX,
  FORK_IMPORT_VERIFIED_KEY,
  assertForkImportCompatible,
  inspectForkImport,
} from "./ForkImportCompatibility.ts";
import { forkLegacyMessageRoles } from "./ForkLegacyMessages.ts";
import { TestLayer, seedThreads, seedUnpatchedImport, stamp } from "./ForkDataCarryOver.testkit.ts";

/** One V1 task thread, `child` under `root`, holding the given messages. */
const seedChild = (
  messages: ReadonlyArray<readonly [string, "user" | "assistant" | "reasoning", string | null]>,
) =>
  Effect.gen(function* () {
    yield* seedThreads([
      ["root", null],
      ["child", "root"],
    ]);
    const sql = yield* SqlClient.SqlClient;
    for (const [id, role, source] of messages) {
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, source, is_streaming, created_at, updated_at)
        VALUES (${id}, 'child', ${role}, ${id}, ${source}, 0, ${stamp}, ${stamp})`;
    }
  });

const seedHealthy = seedChild([
  ["1-u", "user", "user"],
  ["2-r", "reasoning", "provider"],
  ["3-a", "assistant", null],
  ["4-u", "user", "task-result"],
]);

/** The verification's thread: reasoning in two parts and no source tags. */
const seedReasoningWithoutSources = seedChild([
  ["1-u", "user", null],
  ["2-r", "reasoning", null],
  ["3-r", "reasoning", null],
  ["4-a", "assistant", null],
]);

/** A finished import whose pass was not recorded, so the next start checks its evidence. */
const importEverything = Effect.gen(function* () {
  const importer = yield* LegacyV1ThreadImporter;
  yield* importer.reconcileShells;
  yield* importer.importPendingTranscripts;
  yield* (yield* SqlClient.SqlClient)`DELETE FROM fork_v1_import_state`;
});

/** Compaction removes the reasoning events and their positions; the projection stays. */
const compactReasoningEventsAndPositions = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM orchestration_events WHERE event_id IN (
      SELECT ${FORK_IMPORT_TURN_ITEM_PREFIX} || message_id
      FROM projection_thread_messages WHERE role = 'reasoning')`;
    yield* sql`DELETE FROM orchestration_v2_turn_item_positions WHERE turn_item_id IN (
      SELECT ${FORK_IMPORT_TURN_ITEM_PREFIX} || message_id
      FROM projection_thread_messages WHERE role = 'reasoning')`;
  });

/** Rewrite the import as an unpatched importer leaves it: no reasoning, no sources. */
const unpatchThread = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* compactReasoningEventsAndPositions(sql);
    yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE type = 'reasoning'`;
    yield* sql`UPDATE orchestration_events
      SET payload_json = json_remove(payload_json, '$.legacyMessageSource')`;
    yield* sql`UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_remove(payload_json, '$.legacyMessageSource')`;
  });

/** Every reasoning id changes consistently: event, payload, position and projection. */
const renameAllReasoningIds = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const ids = yield* sql<{ id: string }>`
      SELECT ${FORK_IMPORT_TURN_ITEM_PREFIX} || message_id AS id
      FROM projection_thread_messages WHERE role = 'reasoning'`;
    for (const { id } of ids) {
      const changed = `changed:${id}`;
      yield* sql`UPDATE orchestration_events
        SET event_id = ${changed}, payload_json = json_set(payload_json, '$.id', ${changed})
        WHERE event_id = ${id}`;
      yield* sql`UPDATE orchestration_v2_turn_item_positions
        SET turn_item_id = ${changed} WHERE turn_item_id = ${id}`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET turn_item_id = ${changed}, payload_json = json_set(payload_json, '$.id', ${changed})
        WHERE turn_item_id = ${id}`;
    }
  });

const warnings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ entity_id: string }>`
    SELECT entity_id FROM fork_v1_import_warnings WHERE field = 'import_compatibility'
  `;
});

const marker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT 1 FROM fork_v1_import_state WHERE key = ${FORK_IMPORT_VERIFIED_KEY}`;
});

it.effect("records the pass with the last imported transcript, then reads one marker row", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter;
    yield* seedHealthy;
    // First start: the check runs; nothing is imported yet, so no marker.
    yield* importer.reconcileShells;
    assert.lengthOf(yield* marker, 0);
    // Background hydration imports the last transcript and records the pass with it.
    yield* importer.ensureTranscript(ThreadId.make("child"));
    assert.lengthOf(yield* marker, 0);
    yield* importer.importPendingTranscripts;
    assert.lengthOf(yield* marker, 1);
    // Evidence a check would refuse no longer matters: the next start skips the check.
    yield* unpatchThread(sql);
    assert.equal((yield* inspectForkImport())._tag, "skipped");
    yield* importer.reconcileShells;
    // Without the marker the check runs again and refuses the same evidence.
    yield* sql`DELETE FROM fork_v1_import_state`;
    const refused = yield* Effect.flip(importer.reconcileShells);
    assert.include(String(refused.cause), "Incompatible V1 import in statev2.sqlite");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("records no pass when this start could not confirm the evidence", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter;
    yield* seedHealthy;
    yield* importer.reconcileShells;
    // Shell evidence this check cannot place, in the event log only, so the
    // preview repair has nothing to rewrite: the start warns and continues.
    yield* sql`UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.ordinal', json_extract(payload_json, '$.ordinal') + 100)
      WHERE event_id LIKE ${`${FORK_IMPORT_TURN_ITEM_PREFIX}%`}`;
    yield* importer.reconcileShells;
    assert.lengthOf(yield* warnings, 1);
    yield* importer.importPendingTranscripts;
    assert.lengthOf(yield* marker, 0);
  }).pipe(Effect.provide(TestLayer)),
);

for (const [change, seed, mutate] of [
  [
    "upstream renames its import ids",
    seedHealthy,
    (sql: SqlClient.SqlClient) => sql`UPDATE orchestration_events
      SET event_id = replace(event_id, ${FORK_IMPORT_TURN_ITEM_PREFIX}, 'migration:v1:timeline:')
      WHERE event_id LIKE ${`${FORK_IMPORT_TURN_ITEM_PREFIX}%`}`,
  ],
  [
    // The verification's compacted-reasoning-item: the reserved position remains.
    "compaction drops one reasoning event",
    seedHealthy,
    (sql: SqlClient.SqlClient) =>
      sql`DELETE FROM orchestration_events WHERE event_id = ${`${FORK_IMPORT_TURN_ITEM_PREFIX}2-r`}`,
  ],
  [
    // The verification's renamed-single-reasoning-id: one id changes, the rest do not.
    "one reasoning event id changes",
    seedHealthy,
    (sql: SqlClient.SqlClient) => sql`UPDATE orchestration_events
      SET event_id = ${"changed:" + FORK_IMPORT_TURN_ITEM_PREFIX + "2-r"}
      WHERE event_id = ${`${FORK_IMPORT_TURN_ITEM_PREFIX}2-r`}`,
  ],
  [
    // The verification's coherent-all-reasoning-ids-renamed.
    "every reasoning id of a thread without sources changes consistently",
    seedReasoningWithoutSources,
    renameAllReasoningIds,
  ],
  [
    // The verification's reasoning-events-and-positions-compacted.
    "a thread without sources keeps only the projection of its reasoning",
    seedReasoningWithoutSources,
    compactReasoningEventsAndPositions,
  ],
  [
    // The directory keeps its other tags and its reasoning.
    "one source tag is missing while the thread keeps its reasoning",
    seedHealthy,
    (sql: SqlClient.SqlClient) => sql`UPDATE orchestration_events
      SET payload_json = json_remove(payload_json, '$.legacyMessageSource')
      WHERE event_id = ${`${FORK_IMPORT_TURN_ITEM_PREFIX}4-u`}`,
  ],
  [
    "one ordinal matches the unpatched count while the thread keeps its reasoning",
    seedHealthy,
    (sql: SqlClient.SqlClient) => sql`UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.ordinal', 2)
      WHERE event_id = ${`${FORK_IMPORT_TURN_ITEM_PREFIX}3-a`}`,
  ],
  [
    "an ordinal matches neither mapping",
    seedHealthy,
    (sql: SqlClient.SqlClient) => sql`UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.ordinal', 999)
      WHERE event_id = ${`${FORK_IMPORT_TURN_ITEM_PREFIX}3-a`}`,
  ],
] as const) {
  it.effect(`starts and records a warning when ${change}`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* importEverything;
      yield* mutate(sql);
      assert.equal((yield* inspectForkImport())._tag, "unknown");
      yield* (yield* LegacyV1ThreadImporter).reconcileShells;
      assert.lengthOf(yield* warnings, 1);
      // Unconfirmed evidence is never recorded as a pass.
      assert.lengthOf(yield* sql`SELECT 1 FROM fork_v1_import_state`, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
}

it.effect("refuses a thread whose reasoning and sources an importer omitted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedHealthy;
    yield* importEverything;
    yield* unpatchThread(sql);
    assert.equal((yield* inspectForkImport())._tag, "unpatched");
    // A task-link receipt is also written only by this build: no longer an unpatched import.
    yield* repairForkTaskLinks();
    assert.equal((yield* inspectForkImport())._tag, "unknown");
  }).pipe(Effect.provide(TestLayer)),
);

for (const stage of ["shell", "partial", "complete"] as const) {
  it.effect(`refuses an unpatched import stopped at the ${stage} stage`, () =>
    Effect.gen(function* () {
      yield* seedUnpatchedImport(stage);
      assert.equal((yield* inspectForkImport())._tag, "unpatched");
      const refused = yield* Effect.flip((yield* LegacyV1ThreadImporter).reconcileShells);
      assert.include(String(refused.cause), "Incompatible V1 import in statev2.sqlite");
    }).pipe(Effect.provide(TestLayer)),
  );
}

it.effect("never refuses a thread without reasoning, source tags or task links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedThreads([["plain", null]]);
    for (const [id, role] of [
      ["1-u", "user"],
      ["2-a", "assistant"],
    ] as const) {
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${id}, 'plain', ${role}, ${id}, 0, ${stamp}, ${stamp})`;
    }
    yield* importEverything;
    assert.equal((yield* inspectForkImport())._tag, "verified");
    // Even with every import event and position gone, nothing says an unpatched build ran.
    yield* sql`DELETE FROM fork_v1_import_state`;
    yield* sql`DELETE FROM orchestration_events WHERE event_id LIKE ${`${FORK_IMPORT_TURN_ITEM_PREFIX}%`}`;
    yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;
    assert.equal((yield* inspectForkImport())._tag, "unknown");
    yield* (yield* LegacyV1ThreadImporter).reconcileShells;
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("starts and records a warning when the evidence cannot be read", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedHealthy;
    yield* importEverything;
    yield* sql`ALTER TABLE projection_thread_messages RENAME TO dropped_by_upstream`;
    yield* assertForkImportCompatible();
    assert.deepEqual(yield* warnings, [{ entity_id: "statev2.sqlite" }]);
  }).pipe(Effect.provide(TestLayer)),
);

// The check and the task-link repair read upstream internals they do not own.
// When a merge changes one, this names it instead of letting healthy installs
// refuse to start or silently skip the check.
it.effect("upstream still provides what the fork's import check reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Before seeding, so a dropped column is named here rather than failing a fixture insert.
    for (const [table, columns] of [
      ["projection_threads", ["thread_id", "parent_thread_id", "task_json"]],
      ["projection_thread_sessions", ["thread_id", "provider_name"]],
      [
        "projection_thread_messages",
        ["thread_id", "message_id", "role", "source", "created_at", "updated_at"],
      ],
      ["orchestration_v2_legacy_imports", ["thread_id", "transcript_imported_at"]],
      ["orchestration_v2_projection_turn_items", ["thread_id", "run_id", "type", "payload_json"]],
      ["orchestration_command_receipts", ["command_type"]],
    ] as const) {
      const present = new Set(
        (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`).map(
          (row) => row.name,
        ),
      );
      for (const column of columns) {
        assert.isTrue(
          present.has(column),
          `Upstream dropped the column ${table}.${column}, which the fork's import check and task-link repair read on every start until the import is verified.`,
        );
      }
    }
    yield* seedHealthy;
    yield* importEverything;
    yield* repairForkTaskLinks();
    const timeline = Effect.gen(function* () {
      const rows = yield* sql<{ message_id: string; event_ordinal: number | null }>`
        SELECT message.message_id, json_extract(event.payload_json, '$.ordinal') AS event_ordinal
        FROM projection_thread_messages AS message
        LEFT JOIN orchestration_events AS event
          ON event.event_id = ${FORK_IMPORT_TURN_ITEM_PREFIX} || message.message_id
          AND event.event_type = 'turn-item.updated'
        WHERE ${sql.in("message.role", forkLegacyMessageRoles)}
        ORDER BY message.message_id
      `;
      return rows.map((row) => [row.message_id, row.event_ordinal] as const);
    });
    const expected: Array<readonly [string, number | null]> = [
      ["1-u", 1],
      ["2-r", 2],
      ["3-a", 3],
      ["4-u", 4],
    ];
    assert.deepEqual(
      yield* timeline,
      expected,
      `Upstream's importer no longer writes each legacy message as a turn-item.updated event with id ${FORK_IMPORT_TURN_ITEM_PREFIX}<messageId> and payload $.ordinal. Update ForkImportCompatibility before merging.`,
    );
    const positions = sql`SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions
      WHERE turn_item_id LIKE ${`${FORK_IMPORT_TURN_ITEM_PREFIX}%`} ORDER BY ordinal`;
    const reserved = expected.map(([id, ordinal]) => ({
      turn_item_id: `${FORK_IMPORT_TURN_ITEM_PREFIX}${id}`,
      ordinal,
    }));
    assert.deepEqual(
      yield* positions,
      reserved,
      "Upstream no longer reserves legacy timeline positions in orchestration_v2_turn_item_positions.",
    );
    yield* (yield* ProjectionMaintenanceV2).compactEventStore;
    assert.deepEqual(
      yield* timeline,
      expected,
      "Upstream compaction now removes legacy turn-item.updated events; ForkImportCompatibility would warn on every healthy compacted install.",
    );
    assert.deepEqual(
      yield* positions,
      reserved,
      "Upstream compaction now removes reserved legacy positions; ForkImportCompatibility would warn on every healthy compacted install.",
    );
    assert.deepEqual(
      yield* sql`SELECT
        (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items
          WHERE type = 'reasoning' AND run_id IS NULL) AS reasoning,
        (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items
          WHERE json_extract(payload_json, '$.legacyMessageSource') IS NOT NULL) AS tagged,
        (SELECT COUNT(*) FROM orchestration_command_receipts
          WHERE command_type = ${TASK_LINK_REPAIR_COMMAND}) AS receipts`,
      [{ reasoning: 1, tagged: 3, receipts: 1 }],
      "Upstream no longer keeps the fork's own import writes (run-less reasoning items, source tags on projected items, task-link receipts); ForkImportCompatibility would refuse a healthy install as unpatched.",
    );
    const inspection = yield* inspectForkImport();
    assert.equal(
      inspection._tag,
      "verified",
      `The fork's import check no longer recognises a healthy import: ${"mismatch" in inspection ? inspection.mismatch.detail : inspection._tag}`,
    );
  }).pipe(Effect.provide(TestLayer)),
);
