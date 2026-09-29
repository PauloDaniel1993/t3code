import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { SqlError, ConnectionError } from "effect/unstable/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import {
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import * as Path from "effect/Path";
import {
  ATTACHMENT_REFERENCE_REBUILD_BATCH_SIZE,
  ATTACHMENT_REFERENCE_REBUILD_BUDGET_MS,
  AttachmentReferenceIndexUnavailable,
  initializeAttachmentReferenceIndex,
  rebuildAttachmentReferenceIndex,
  rebuildAttachmentReferenceIndexPass,
  requireCompleteAttachmentReferenceIndex,
  startAttachmentReferenceIndex,
} from "./AttachmentReferenceIndex.ts";
import attachmentReferenceMigration from "../persistence/ForkMigrations/010_AttachmentReferenceIndex.ts";
import {
  applyWithAttachmentPruning,
  findReadableAttachment,
  referencedAttachmentPaths,
} from "./AttachmentReferences.ts";
import { layer as outboxLayer } from "./EffectOutbox.ts";

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Test', '/test', '[]', '2026-01-01', '2026-01-01')`;
  yield* sql`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<999)
    INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    SELECT 'thread-'||i, 'project', 'Test', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', '{}' FROM n`;
  yield* sql`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<9999)
    INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    SELECT 'message-'||i, 'thread-'||(i/10), 'user', 0, '2026-01-01', '2026-01-01',
      json_object('text', printf('%4096s','text'), 'attachments', json_array(json_object(
        'type','image', 'id',printf('thread-%d-00000000-0000-4000-8000-%012d',i/10,i),
        'name','image.png','mimeType','image/png','sizeBytes',1))) FROM n`;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
    SELECT message_id, thread_id, 1, 'user_message', 'completed', updated_at, payload_json FROM orchestration_v2_projection_messages`;
});
const testLayer = outboxLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
const id = (i: number) =>
  `thread-${Math.floor(i / 10)}-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const encodeBenchmark = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const smallFixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Test', '/test', '[]', '2026-01-01', '2026-01-01')`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('thread-0', 'project', 'Test', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', '{}')`;
  yield* sql`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<199)
    INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    SELECT printf('message-%03d', i), 'thread-0', 'user', 0, '2026-01-01', '2026-01-01',
      json_object('attachments', json_array(json_object('type','image', 'id',printf('thread-0-00000000-0000-4000-8000-%012d',i),
        'name','image.png','mimeType','image/png','sizeBytes',1))) FROM n`;
});

describe("attachment reference index", () => {
  it.effect("shared CLI persistence prepares the index but only server startup rebuilds it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const database = makeSqlitePersistenceLive(path.join(directory, "statev2.sqlite"));
      yield* Effect.gen(function* () {
        yield* smallFixture;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
      }).pipe(Effect.provide(database));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT complete, cursor FROM fork_v2_attachment_reference_state`).toEqual(
          [{ complete: 0, cursor: null }],
        );
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = payload_json WHERE message_id = 'message-005'`;
        expect(yield* sql`SELECT count(*) AS count FROM fork_v2_attachment_references`).toEqual([
          { count: 1 },
        ]);
        const rebuild = yield* startAttachmentReferenceIndex();
        if (rebuild !== undefined) yield* Fiber.join(rebuild);
        yield* requireCompleteAttachmentReferenceIndex();
        expect(yield* sql`SELECT count(*) AS count FROM fork_v2_attachment_references`).toEqual([
          { count: 200 },
        ]);
      }).pipe(Effect.provide(database));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const source of ["message", "item", "legacy"] as const) {
    it.effect(`reads an unindexed ${source} attachment from live source metadata only`, () =>
      Effect.gen(function* () {
        yield* smallFixture;
        const sql = yield* SqlClient.SqlClient;
        if (source === "item")
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
          SELECT message_id, thread_id, 1, 'user_input_request', 'completed', updated_at,
            json_object('questionAnswer', json_object('attachmentsByQuestionId', json_object('answer', json_extract(payload_json, '$.attachments'))))
          FROM orchestration_v2_projection_messages WHERE message_id = 'message-005'`;
        if (source === "legacy")
          yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json)
          SELECT message_id, thread_id, 'user', '', 0, created_at, updated_at, json_extract(payload_json, '$.attachments')
          FROM orchestration_v2_projection_messages WHERE message_id = 'message-005'`;
        if (source !== "message") yield* sql`DELETE FROM orchestration_v2_projection_messages`;
        yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
        yield* initializeAttachmentReferenceIndex();
        expect(yield* sql`SELECT * FROM fork_v2_attachment_references`).toEqual([]);
        expect((yield* findReadableAttachment(id(5), "thread-0"))?.relativePath).toBe(
          `${id(5)}.png`,
        );
        expect(yield* findReadableAttachment(id(5), "other")).toBeNull();
        expect(yield* findReadableAttachment("absent")).toBeNull();
        if (source === "legacy") {
          yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
            VALUES ('thread-0', '2026-01-01', '2026-01-01', '2026-01-01')`;
          expect(yield* findReadableAttachment(id(5))).toBeNull();
        } else {
          yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-01-01'`;
          expect(yield* findReadableAttachment(id(5))).toBeNull();
          yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL`;
          yield* sql`UPDATE projection_projects SET deleted_at = '2026-01-01'`;
          expect(yield* findReadableAttachment(id(5))).toBeNull();
        }
      }).pipe(Effect.provide(testLayer)),
    );
  }

  it.effect("ignores unrelated objects sharing the fork attachment prefix", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE fork_v2_attachment_uploads(id TEXT)`;
      yield* sql`CREATE TABLE forkXv2XattachmentXforeign(id TEXT)`;
      expect(yield* initializeAttachmentReferenceIndex()).toBe(true);
      yield* requireCompleteAttachmentReferenceIndex();
      expect((yield* findReadableAttachment(id(5)))?.threadId).toBe("thread-0");
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'fork_v2_attachment_uploads'`,
      ).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("checks schema definitions once per DDL cookie, never for ordinary reads", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      const sql = yield* SqlClient.SqlClient;
      let checks = 0;
      const counted = new Proxy(sql, {
        apply: (target, receiver, args) => {
          if (
            Array.isArray(args[0]) &&
            args[0].some(
              (part: unknown) => typeof part === "string" && part.includes("FROM sqlite_master"),
            )
          )
            checks++;
          return Reflect.apply(target, receiver, args);
        },
      });
      const reads = Effect.gen(function* () {
        for (let n = 0; n < 10; n++)
          expect((yield* findReadableAttachment(id(5)))?.threadId).toBe("thread-0");
      }).pipe(Effect.provideService(SqlClient.SqlClient, counted));
      yield* initializeAttachmentReferenceIndex().pipe(
        Effect.provideService(SqlClient.SqlClient, counted),
      );
      expect(checks).toBe(1);
      yield* reads;
      expect(checks).toBe(1);
      yield* sql`CREATE TABLE unrelated_schema_change(id TEXT)`;
      yield* reads;
      expect(checks).toBe(2);
      yield* sql`DROP TRIGGER fork_v2_attachment_message_insert`;
      yield* requireCompleteAttachmentReferenceIndex().pipe(
        Effect.provideService(SqlClient.SqlClient, counted),
        Effect.flip,
      );
      expect(checks).toBe(3);
      // Source metadata still authorizes this same attachment despite index damage.
      yield* reads;
      expect(checks).toBe(3);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retries failed passes with test-clock backoff capped at five seconds", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
      const attempts = yield* Queue.unbounded<number>();
      let failures = 0;
      const gated = new Proxy(sql, {
        get: (target, key, receiver) =>
          key === "unsafe"
            ? (query: string, ...args: Array<unknown>) => {
                if (query.startsWith("SELECT message_id AS id") && failures < 8) {
                  failures++;
                  return Queue.offer(attempts, failures).pipe(
                    Effect.andThen(
                      new SqlError({
                        reason: new ConnectionError({ cause: "SQLITE_BUSY_SNAPSHOT" }),
                      }),
                    ),
                  );
                }
                return Reflect.apply(target.unsafe, target, [query, ...args]);
              }
            : Reflect.get(target, key, receiver),
      });
      const rebuild = yield* startAttachmentReferenceIndex().pipe(
        Effect.provideService(SqlClient.SqlClient, gated),
      );
      expect(yield* Queue.take(attempts)).toBe(1);
      for (const [i, delay] of [100, 200, 400, 800, 1600, 3200, 5000, 5000].entries()) {
        yield* TestClock.adjust(delay - 1);
        expect(failures).toBe(i + 1);
        yield* TestClock.adjust(1);
        if (i < 7) expect(yield* Queue.take(attempts)).toBe(i + 2);
      }
      if (rebuild !== undefined) yield* Fiber.join(rebuild);
      yield* requireCompleteAttachmentReferenceIndex();
      expect((yield* findReadableAttachment(id(5)))?.threadId).toBe("thread-0");
    }).pipe(Effect.provide(testLayer)),
  );

  for (const [damage, statement] of [
    ["missing trigger", "DROP TRIGGER fork_v2_attachment_message_insert"],
    [
      "changed trigger",
      "DROP TRIGGER fork_v2_attachment_message_insert; CREATE TRIGGER fork_v2_attachment_message_insert AFTER INSERT ON orchestration_v2_projection_messages BEGIN SELECT 1; END",
    ],
    ["missing index", "DROP INDEX fork_v2_attachment_id_idx"],
    ["missing table", "DROP TABLE fork_v2_attachment_references"],
    ["changed table", "ALTER TABLE fork_v2_attachment_references ADD COLUMN unexpected TEXT"],
    ["old version", "UPDATE fork_v2_attachment_reference_state SET version = 1"],
    ["missing version marker", "DELETE FROM fork_v2_attachment_reference_state"],
  ]) {
    it.effect(`repairs a ${damage} on initialization before trusting any reference`, () =>
      Effect.gen(function* () {
        yield* smallFixture;
        const sql = yield* SqlClient.SqlClient;
        // Separate DDL statements: the driver's unsafe API executes one at a time.
        if (damage === "changed trigger") {
          yield* sql`DROP TRIGGER fork_v2_attachment_message_insert`;
          yield* sql`CREATE TRIGGER fork_v2_attachment_message_insert AFTER INSERT ON orchestration_v2_projection_messages BEGIN SELECT 1; END`;
        } else yield* sql.unsafe(statement!);
        yield* requireCompleteAttachmentReferenceIndex().pipe(Effect.flip);
        expect(yield* initializeAttachmentReferenceIndex()).toBe(false);
        expect(yield* sql`SELECT * FROM fork_v2_attachment_references`).toEqual([]);
        yield* requireCompleteAttachmentReferenceIndex().pipe(Effect.flip);
        yield* attachmentReferenceMigration;
        yield* rebuildAttachmentReferenceIndex();
        yield* requireCompleteAttachmentReferenceIndex();
        expect((yield* findReadableAttachment(id(5)))?.threadId).toBe("thread-0");
        yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-005'`;
        expect(yield* findReadableAttachment(id(5))).toBeNull();
      }).pipe(Effect.provide(testLayer)),
    );
  }

  it.effect("repairs triggers lost to an upstream create-copy-drop-rename table migration", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      const sql = yield* SqlClient.SqlClient;
      const [original] = yield* sql<{
        sql: string;
      }>`SELECT sql FROM sqlite_master WHERE name = 'orchestration_v2_projection_messages'`;
      yield* sql.unsafe(
        original!.sql.replace("orchestration_v2_projection_messages", "messages_next"),
      );
      yield* sql`INSERT INTO messages_next SELECT * FROM orchestration_v2_projection_messages`;
      yield* sql`DROP TABLE orchestration_v2_projection_messages`;
      yield* sql`ALTER TABLE messages_next RENAME TO orchestration_v2_projection_messages`;
      yield* initializeAttachmentReferenceIndex();
      yield* rebuildAttachmentReferenceIndex();
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"attachments":[]}' WHERE message_id = 'message-005'`;
      expect(yield* findReadableAttachment(id(5))).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "bounds and resumes rebuilding while triggers cover changes behind and ahead of the cursor",
    () =>
      Effect.gen(function* () {
        yield* smallFixture;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
        yield* initializeAttachmentReferenceIndex();
        expect(yield* rebuildAttachmentReferenceIndexPass()).toBe(false);
        const count = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM fork_v2_attachment_references`;
        expect(count[0]!.count).toBeGreaterThan(0);
        expect(count[0]!.count).toBeLessThanOrEqual(ATTACHMENT_REFERENCE_REBUILD_BATCH_SIZE);
        yield* requireCompleteAttachmentReferenceIndex().pipe(Effect.flip);
        // A restart resumes the verified cursor rather than repeating completed work.
        const cursor = yield* sql`SELECT cursor FROM fork_v2_attachment_reference_state`;
        expect(yield* initializeAttachmentReferenceIndex()).toBe(false);
        expect(yield* sql`SELECT cursor FROM fork_v2_attachment_reference_state`).toEqual(cursor);
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"attachments":[]}' WHERE message_id = 'message-000'`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages SELECT 'a-background-import', thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
        FROM orchestration_v2_projection_messages WHERE message_id = 'message-005'`;
        yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-199'`;
        yield* rebuildAttachmentReferenceIndex();
        yield* requireCompleteAttachmentReferenceIndex();
        expect(yield* sql`SELECT COUNT(*) AS count FROM fork_v2_attachment_references`).toEqual([
          { count: 199 },
        ]);
        expect(yield* findReadableAttachment(id(0))).toBeNull();
        expect(
          yield* findReadableAttachment("thread-0-00000000-0000-4000-8000-000000000199"),
        ).toBeNull();
        expect(
          yield* sql`SELECT row_id FROM fork_v2_attachment_references WHERE row_id = 'a-background-import'`,
        ).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("ends a pass at the time budget even before its row limit", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
      yield* initializeAttachmentReferenceIndex();
      let elapsed = 0;
      const timer = vi.spyOn(performance, "now").mockImplementation(() => {
        elapsed += ATTACHMENT_REFERENCE_REBUILD_BUDGET_MS + 1;
        return elapsed;
      });
      try {
        expect(yield* rebuildAttachmentReferenceIndexPass()).toBe(false);
        expect(yield* sql`SELECT COUNT(*) AS count FROM fork_v2_attachment_references`).toEqual([
          { count: 1 },
        ]);
      } finally {
        timer.mockRestore();
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns from startup while a background rebuild is blocked, then drains it", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let transactions = 0;
      const withTransaction: typeof sql.withTransaction = (effect) =>
        ++transactions === 1
          ? sql.withTransaction(effect)
          : Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(sql.withTransaction(effect)),
            );
      const gated = new Proxy(sql, {
        get: (target, key, receiver) =>
          key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
      });
      const rebuild = yield* startAttachmentReferenceIndex().pipe(
        Effect.provideService(SqlClient.SqlClient, gated),
      );
      expect(rebuild).toBeDefined();
      yield* Deferred.await(entered);
      expect(yield* sql`SELECT complete FROM fork_v2_attachment_reference_state`).toEqual([
        { complete: 0 },
      ]);
      yield* Deferred.succeed(release, undefined);
      if (rebuild !== undefined) yield* Fiber.join(rebuild);
      yield* requireCompleteAttachmentReferenceIndex();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("never reads a stored row for updates that cannot change attachments", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const base = {
        id: TurnItemId.make("stream-item"),
        threadId: ThreadId.make("thread-0"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      } as const;
      const events: Array<OrchestrationV2StoredEvent["event"]> = [
        {
          id: EventId.make("message"),
          threadId: base.threadId,
          type: "message.updated",
          occurredAt: now,
          payload: {
            id: MessageId.make("stream"),
            threadId: base.threadId,
            runId: null,
            nodeId: null,
            role: "assistant",
            createdBy: "agent",
            creationSource: "provider",
            text: "streaming",
            attachments: [],
            streaming: true,
            createdAt: now,
            updatedAt: now,
          },
        },
        ...[undefined, []].map((attachments): OrchestrationV2StoredEvent["event"] => ({
          id: EventId.make("assistant-item"),
          threadId: base.threadId,
          type: "turn-item.updated",
          occurredAt: now,
          payload: {
            ...base,
            type: "assistant_message",
            messageId: MessageId.make("stream"),
            text: "streaming",
            streaming: true,
            ...(attachments === undefined ? {} : { attachments }),
          },
        })),
        ...[true, false].map((streaming): OrchestrationV2StoredEvent["event"] => ({
          id: EventId.make("reasoning"),
          threadId: base.threadId,
          type: "turn-item.updated",
          occurredAt: now,
          payload: { ...base, type: "reasoning", text: "thinking", streaming },
        })),
      ];
      let applied = 0;
      // Reintroducing any stored-row read fails even when the index exists.
      const sql = yield* SqlClient.SqlClient;
      let reads = 0;
      const unreadableSql = new Proxy(sql, {
        apply: () => {
          reads++;
          throw new Error("Unexpected SQL read on streaming update");
        },
        get: (target, key, receiver) => {
          if (key === "unsafe") {
            reads++;
            throw new Error("Unexpected unsafe SQL read on streaming update");
          }
          return Reflect.get(target, key, receiver);
        },
      });
      for (const event of events)
        expect(
          yield* applyWithAttachmentPruning(
            { sequence: 1, commandId: null, event },
            Effect.sync(() => {
              applied++;
            }),
          ).pipe(Effect.provideService(SqlClient.SqlClient, unreadableSql)),
        ).toBe(0);
      expect(applied).toBe(events.length);
      expect(reads).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "backfills in bounded passes, follows direct writes and projection rebuilds, and uses indexed unknown-ID lookups",
    () =>
      Effect.gen(function* () {
        yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        for (const source of ["message", "item", "legacy"])
          for (const operation of ["insert", "update", "delete"])
            yield* sql.unsafe(`DROP TRIGGER fork_v2_attachment_${source}_${operation}`);
        yield* sql`DROP TABLE fork_v2_attachment_references`;
        yield* initializeAttachmentReferenceIndex();
        yield* rebuildAttachmentReferenceIndex();
        expect((yield* findReadableAttachment(id(5)))?.threadId).toBe("thread-0");
        expect(yield* findReadableAttachment(id(5), "thread-1")).toBeNull();
        expect(yield* findReadableAttachment("unknown")).toBeNull();
        const plan = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN SELECT * FROM fork_v2_attachment_references WHERE attachment_id = 'unknown'`;
        expect(plan.some((row) => row.detail.includes("fork_v2_attachment_id_idx"))).toBe(true);
        yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-5'`;
        yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'message-5'`;
        expect(yield* findReadableAttachment(id(5))).toBeNull();
        yield* initializeAttachmentReferenceIndex();
        expect(yield* findReadableAttachment(id(5))).toBeNull();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "measures the reviewed scans and streaming reads against the indexed branch on 1,000 threads and 10,000 messages",
    () =>
      Effect.gen(function* () {
        yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const payloads = sql`SELECT thread_id, json_extract(payload_json, '$.attachments') AS payload_json FROM orchestration_v2_projection_messages
      UNION ALL SELECT thread_id, json_object('attachments', json_extract(payload_json, '$.attachments'), 'answers', json_extract(payload_json, '$.questionAnswer.attachmentsByQuestionId')) FROM orchestration_v2_projection_turn_items
      UNION ALL SELECT message.thread_id, message.attachments_json FROM projection_thread_messages AS message
        LEFT JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = message.thread_id WHERE imported.transcript_imported_at IS NULL AND message.attachments_json IS NOT NULL`;
        const oldLookup = (attachmentId: string) => sql`
      SELECT attachment.value FROM (${payloads}) AS payload
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = payload.thread_id
      JOIN json_tree(payload.payload_json) AS attachment
      WHERE thread.deleted_at IS NULL AND attachment.type = 'object'
        AND json_extract(attachment.value, '$.type') IN ('image','file')
        AND json_extract(attachment.value, '$.id') = ${attachmentId}`;
        const measure = Effect.fnUntraced(function* (
          count: number,
          operation: () => Effect.Effect<
            unknown,
            SqlError | AttachmentReferenceIndexUnavailable,
            SqlClient.SqlClient
          >,
        ) {
          const started = performance.now();
          for (let i = 0; i < count; i++) yield* operation();
          return (performance.now() - started) / count;
        });
        // Warm both paths before reporting per-call wall-clock cost; no timing assertion.
        yield* oldLookup("unknown");
        yield* findReadableAttachment("unknown");
        const beforeUnknownMs = yield* measure(5, () => oldLookup("unknown"));
        const afterUnknownMs = yield* measure(100, () => findReadableAttachment("unknown"));
        const ids = Array.from({ length: 10 }, (_, i) => id(i));
        const beforeCleanupMs = yield* measure(2, () =>
          Effect.forEach(ids, (value) => sql.withTransaction(oldLookup(value))),
        );
        const afterCleanupMs = yield* measure(100, () =>
          sql.withTransaction(referencedAttachmentPaths(ids)),
        );
        // The previous helper issued this read on every streaming message/item update.
        const beforeStreamingReadMs = yield* measure(
          1000,
          () =>
            sql`SELECT json_extract(payload_json, '$.attachments') FROM orchestration_v2_projection_messages WHERE message_id = 'message-5'`,
        );
        const now = yield* DateTime.now;
        const stored: OrchestrationV2StoredEvent = {
          sequence: 0,
          commandId: null,
          event: {
            id: EventId.make("stream"),
            type: "message.updated",
            threadId: ThreadId.make("thread-0"),
            occurredAt: now,
            payload: {
              id: MessageId.make("stream"),
              threadId: ThreadId.make("thread-0"),
              runId: null,
              nodeId: null,
              role: "assistant",
              createdBy: "agent",
              creationSource: "provider",
              text: "streaming",
              attachments: [],
              streaming: true,
              createdAt: now,
              updatedAt: now,
            },
          },
        };
        const started = performance.now();
        for (let i = 0; i < 1000; i++) yield* applyWithAttachmentPruning(stored, Effect.void);
        const afterStreamingHelperMs = (performance.now() - started) / 1000;
        const streamPayload =
          '{"text":"' + "x".repeat(4096) + '","attachments":[],"streaming":true}';
        yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('stream', 'thread-0', 'assistant', 1, '2026-01-01', '2026-01-01', ${streamPayload})`;
        const update = () =>
          sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${streamPayload} WHERE message_id = 'stream'`;
        const afterStreamingWriteMs = yield* measure(1000, update);
        expect((yield* referencedAttachmentPaths(ids)).size).toBe(10);
        yield* sql`DROP TRIGGER fork_v2_attachment_message_update`;
        const upstreamStreamingWriteMs = yield* measure(1000, update);
        const benchmark = {
          threads: 1000,
          messages: 10000,
          items: 10000,
          beforeUnknownMs,
          afterUnknownMs,
          beforeCleanupMs,
          afterCleanupMs,
          beforeStreamingReadMs,
          afterStreamingHelperMs,
          afterStreamingWriteMs,
          upstreamStreamingWriteMs,
          addedStreamingMs:
            afterStreamingHelperMs + afterStreamingWriteMs - upstreamStreamingWriteMs,
        };
        yield* Console.info("Attachment revision benchmark", benchmark);
        const reportPath = process.env.T3_ATTACHMENT_BENCHMARK_REPORT;
        if (reportPath !== undefined)
          yield* (yield* FileSystem.FileSystem).writeFileString(
            reportPath,
            encodeBenchmark(benchmark),
          );
      }).pipe(Effect.provide(testLayer)),
  );
});
