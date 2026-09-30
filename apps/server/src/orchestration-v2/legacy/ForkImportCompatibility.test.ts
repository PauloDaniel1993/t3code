import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionMaintenanceV2 } from "../ProjectionMaintenance.ts";
import { LegacyV1ThreadImporter } from "./LegacyV1ThreadImporter.ts";
import { repairForkTaskLinks } from "./ForkTaskLinkRepair.ts";
import {
  FORK_IMPORT_TURN_ITEM_PREFIX,
  FORK_IMPORT_VERIFIED_KEY,
  assertForkImportCompatible,
  inspectForkImport,
} from "./ForkImportCompatibility.ts";
import { forkLegacyMessageRoles } from "./ForkLegacyMessages.ts";
import { TestLayer, seedThreads, stamp } from "./ForkDataCarryOver.testkit.ts";

const seedHealthy = Effect.gen(function* () {
  yield* seedThreads([
    ["root", null],
    ["child", "root"],
  ]);
  const sql = yield* SqlClient.SqlClient;
  for (const [id, role, source] of [
    ["1-u", "user", "user"],
    ["2-r", "reasoning", "provider"],
    ["3-a", "assistant", null],
    ["4-u", "user", "task-result"],
  ] as const) {
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, source, is_streaming, created_at, updated_at)
      VALUES (${id}, 'child', ${role}, ${id}, ${source}, 0, ${stamp}, ${stamp})`;
  }
});

/** A patched first start, then background hydration of every transcript. */
const importEverything = Effect.gen(function* () {
  const importer = yield* LegacyV1ThreadImporter;
  yield* importer.reconcileShells;
  yield* importer.importPendingTranscripts;
});

const warnings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ entity_id: string }>`
    SELECT entity_id FROM fork_v1_import_warnings WHERE field = 'import_compatibility'
  `;
});

it.effect("checks every start until the import is complete, then reads one marker row", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter;
    yield* seedHealthy;
    // First start: the check runs; nothing is imported yet, so no marker.
    assert.equal((yield* inspectForkImport())._tag, "unfinished");
    yield* importEverything;
    // The next start checks the finished import once and records the pass.
    yield* importer.reconcileShells;
    assert.lengthOf(
      yield* sql`SELECT 1 FROM fork_v1_import_state WHERE key = ${FORK_IMPORT_VERIFIED_KEY}`,
      1,
    );
    // Evidence a check would refuse no longer matters: the check is skipped.
    yield* sql`UPDATE orchestration_events
      SET payload_json = json_remove(payload_json, '$.legacyMessageSource')
      WHERE event_id = ${`${FORK_IMPORT_TURN_ITEM_PREFIX}4-u`}`;
    assert.equal((yield* inspectForkImport())._tag, "skipped");
    yield* importer.reconcileShells;
    // Without the marker the check runs again and refuses the same evidence.
    yield* sql`DELETE FROM fork_v1_import_state`;
    const refused = yield* Effect.flip(importer.reconcileShells);
    assert.include(String(refused.cause), "Incompatible V1 import in statev2.sqlite");
  }).pipe(Effect.provide(TestLayer)),
);

for (const [change, mutate] of [
  [
    "upstream renames its import ids",
    (sql: SqlClient.SqlClient) => sql`UPDATE orchestration_events
      SET event_id = replace(event_id, ${FORK_IMPORT_TURN_ITEM_PREFIX}, 'migration:v1:timeline:')
      WHERE event_id LIKE ${`${FORK_IMPORT_TURN_ITEM_PREFIX}%`}`,
  ],
  [
    "an ordinal matches neither mapping",
    (sql: SqlClient.SqlClient) => sql`UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.ordinal', 999)
      WHERE event_id = ${`${FORK_IMPORT_TURN_ITEM_PREFIX}3-a`}`,
  ],
] as const) {
  it.effect(`starts and records a warning when ${change}`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedHealthy;
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
    assert.deepEqual(
      yield* sql`SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions
        WHERE turn_item_id LIKE ${`${FORK_IMPORT_TURN_ITEM_PREFIX}%`} ORDER BY ordinal`,
      expected.map(([id, ordinal]) => ({
        turn_item_id: `${FORK_IMPORT_TURN_ITEM_PREFIX}${id}`,
        ordinal,
      })),
      "Upstream no longer reserves legacy timeline positions in orchestration_v2_turn_item_positions.",
    );
    yield* (yield* ProjectionMaintenanceV2).compactEventStore;
    assert.deepEqual(
      yield* timeline,
      expected,
      "Upstream compaction now removes legacy turn-item.updated events; ForkImportCompatibility would read a healthy compacted install as incomplete.",
    );
    for (const [table, columns] of [
      ["projection_threads", ["thread_id", "parent_thread_id", "task_json"]],
      ["projection_thread_sessions", ["thread_id", "provider_name"]],
      [
        "projection_thread_messages",
        ["thread_id", "message_id", "role", "source", "created_at", "updated_at"],
      ],
      ["orchestration_v2_legacy_imports", ["thread_id", "transcript_imported_at"]],
    ] as const) {
      const present = new Set(
        (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`).map(
          (row) => row.name,
        ),
      );
      for (const column of columns) {
        assert.isTrue(
          present.has(column),
          `Upstream dropped the legacy column ${table}.${column}, which the fork's import check and task-link repair read on every start until the import is verified.`,
        );
      }
    }
    const inspection = yield* inspectForkImport();
    assert.equal(
      inspection._tag,
      "verified",
      `The fork's import check no longer recognises a healthy import: ${"mismatch" in inspection ? inspection.mismatch.detail : inspection._tag}`,
    );
  }).pipe(Effect.provide(TestLayer)),
);
