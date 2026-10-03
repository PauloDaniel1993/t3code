import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { LegacyV1ThreadImporter } from "./LegacyV1ThreadImporter.ts";
import { repairForkTaskLinks } from "./ForkTaskLinkRepair.ts";
import { TestLayer, seedThreads, stamp } from "./ForkDataCarryOver.testkit.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

type Role = "user" | "assistant" | "reasoning";
interface Fixture {
  readonly threads: ReadonlyArray<readonly [string, string | null]>;
  readonly task: string;
  readonly messages: ReadonlyArray<
    readonly [id: string, thread: string, role: Role, source: string | null]
  >;
  /** What the earlier import wrote differently, applied to its projections after its shell import. */
  readonly unpatchedProjection?: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError>;
}

const pdf = {
  type: "document",
  id: "pdf",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 12,
};

/**
 * The verification's case: previews without sources over a transcript with
 * reasoning, a source outside the previews, a PDF preview attachment upstream's
 * strict decoding drops, and a task whose item lands after the transcript.
 */
const verificationCase: Fixture = {
  threads: [
    ["root", null],
    ["child", "root"],
  ],
  task: "child",
  messages: [
    ["1-u", "root", "user", null],
    ["2-r", "root", "reasoning", null],
    ["3-a", "root", "assistant", "provider"],
    ["4-u", "root", "user", null],
    ["5-r", "root", "reasoning", null],
    ["6-a", "root", "assistant", null],
    ["c1-u", "child", "user", null],
    ["c2-a", "child", "assistant", null],
  ],
  unpatchedProjection: (sql) =>
    Effect.gen(function* () {
      yield* sql`UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.attachments', json('[]')) WHERE message_id = '4-u'`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET payload_json = json_set(payload_json, '$.attachments', json('[]'))
        WHERE turn_item_id = 'migration:v1:turn-item:4-u'`;
    }),
};

/**
 * A thread whose latest message is reasoning, which no unpatched shell import
 * writes, in a directory admitted by a tagged preview elsewhere.
 */
const reasoningPreviewCase: Fixture = {
  threads: [
    ["third", null],
    ["child", "third"],
    ["tagged", null],
  ],
  task: "child",
  messages: [
    ["t1-u", "third", "user", null],
    ["t2-a", "third", "assistant", null],
    ["t3-r", "third", "reasoning", null],
    ["k1-u", "child", "user", null],
    ["g1-u", "tagged", "user", "user"],
  ],
};

/**
 * Seed V1. `unpatched` imports the shells first the way an unpatched build
 * does: reasoning is invisible to it (seeded as `system`, which both importers
 * skip), so previews and positions use reasoning-free ordinals, and it sees no
 * source outside a preview.
 */
const seed = (fixture: Fixture, unpatched: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedThreads(fixture.threads);
    const task = {
      title: "Task",
      prompt: "Do it",
      createdBy: "agent",
      status: "finished",
      requestedAt: stamp,
      startedAt: stamp,
      finishedAt: stamp,
      result: { summary: "Done", completedAt: stamp },
      delivery: null,
    };
    yield* sql`UPDATE projection_threads SET task_json = ${yield* encodeJson(task)} WHERE thread_id = ${fixture.task}`;
    for (const [id, thread, role, source] of fixture.messages) {
      const hidden = unpatched && role === "reasoning";
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, source, text, attachments_json, is_streaming, created_at, updated_at)
        VALUES (${id}, ${thread}, ${hidden ? "system" : role}, ${source}, ${id},
          ${id === "4-u" ? yield* encodeJson([pdf]) : null}, 0, ${stamp}, ${stamp})`;
    }
    if (!unpatched) return;
    yield* (yield* LegacyV1ThreadImporter).reconcileShells;
    yield* sql`UPDATE projection_thread_messages SET role = 'reasoning' WHERE role = 'system'`;
    if (fixture.unpatchedProjection) yield* fixture.unpatchedProjection(sql);
    yield* sql`DELETE FROM fork_v1_import_state`;
  });

/** Server startup's order: shells and the compatibility step, task links, then background hydration. */
const start = (hydrate: boolean) =>
  Effect.gen(function* () {
    const importer = yield* LegacyV1ThreadImporter;
    yield* importer.reconcileShells;
    yield* repairForkTaskLinks();
    if (hydrate) yield* importer.importPendingTranscripts;
  });

const eventCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_events`;
  return rows[0]!.count;
});

/** Every carried identity with its full projected payload, and every reserved position. */
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const payloads = (rows: ReadonlyArray<{ id: string; payload_json: string }>) =>
    rows.map((row) => [row.id, parseJson(row.payload_json)] as const);
  return {
    items: payloads(
      yield* sql<{ id: string; payload_json: string }>`
        SELECT turn_item_id AS id, payload_json FROM orchestration_v2_projection_turn_items ORDER BY id`,
    ),
    messages: payloads(
      yield* sql<{ id: string; payload_json: string }>`
        SELECT message_id AS id, payload_json FROM orchestration_v2_projection_messages ORDER BY id`,
    ),
    subagents: payloads(
      yield* sql<{ id: string; payload_json: string }>`
        SELECT subagent_id AS id, payload_json FROM orchestration_v2_projection_subagents ORDER BY id`,
    ),
    positions: yield* sql`SELECT thread_id, turn_item_id, ordinal
      FROM orchestration_v2_turn_item_positions ORDER BY thread_id, ordinal`,
    unfinished: yield* sql`SELECT thread_id FROM orchestration_v2_legacy_imports
      WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL`,
  };
});

/** A fresh import; restarting it before hydration leaves the repair nothing to write. */
const fresh = (fixture: Fixture) =>
  Effect.gen(function* () {
    yield* seed(fixture, false);
    yield* start(false);
    const shells = yield* eventCount;
    yield* start(false);
    assert.equal(yield* eventCount, shells);
    yield* start(true);
    return yield* snapshot;
  }).pipe(Effect.provide(TestLayer));

it.effect.each([
  ["previews without sources over reasoning", verificationCase],
  ["a reasoning preview the earlier import left out", reasoningPreviewCase],
] as const)("hydrates an unpatched shell-only import like a fresh one: %s", ([, fixture]) =>
  Effect.gen(function* () {
    const expected = yield* fresh(fixture);
    const actual = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(fixture, true);
      // First start, stopped before hydration; a restart then writes nothing twice.
      yield* start(false);
      const afterFirst = yield* eventCount;
      yield* start(false);
      assert.equal(yield* eventCount, afterFirst);
      yield* start(true);
      const hydrated = yield* snapshot;
      const afterHydration = yield* eventCount;
      yield* start(true);
      assert.equal(yield* eventCount, afterHydration);
      assert.deepStrictEqual(yield* snapshot, hydrated);
      const unconfirmed = yield* sql`SELECT 1 FROM fork_v1_import_warnings
          WHERE field IN ('import_compatibility', 'shell_preview_repair_failed')`;
      const passes = yield* sql`SELECT 1 FROM fork_v1_import_state`;
      return { hydrated, unconfirmed, passes };
    }).pipe(Effect.provide(TestLayer));
    assert.deepStrictEqual(actual.hydrated.unfinished, []);
    assert.deepStrictEqual(actual.hydrated, expected);
    // Nothing unconfirmed: no compatibility warning, and the pass is recorded.
    assert.lengthOf(actual.unconfirmed, 0);
    assert.lengthOf(actual.passes, 1);
  }),
);
