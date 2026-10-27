// @effect-diagnostics nodeBuiltinImport:off - another connection changes a fixture's schema.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import { SqlError, ConnectionError } from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import {
  EventId,
  CommandId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import { vi } from "vite-plus/test";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ResourceCleanup from "./ResourceCleanupService.ts";
import * as Path from "effect/Path";
import {
  ATTACHMENT_REFERENCE_REBUILD_BATCH_SIZE,
  ATTACHMENT_REFERENCE_REBUILD_BUDGET_MS,
  attachmentSourceRows,
  readAttachmentReferenceIndexState,
  initializeAttachmentReferenceIndex,
  rebuildAttachmentReferenceIndex,
  rebuildAttachmentReferenceIndexPass,
  requireCompleteAttachmentReferenceIndex,
  startAttachmentReferenceIndex,
  awaitAttachmentReferenceIndex,
} from "./AttachmentReferenceIndex.ts";
import attachmentReferenceMigration from "../persistence/ForkMigrations/010_AttachmentReferenceIndex.ts";
import {
  applyWithAttachmentPruning,
  findReadableAttachment,
  referencedAttachmentPaths,
} from "./AttachmentReferences.ts";
import { EffectOutboxV2, layer as outboxLayer } from "./EffectOutbox.ts";

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
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);
const id = (i: number) =>
  `thread-${Math.floor(i / 10)}-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

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
  it.effect("retains extracted text with referenced files and removes both after release", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      yield* rebuildAttachmentReferenceIndex();
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-0-00000000-0000-4000-8000-000000099998-pdf";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.pdf`);
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(attachmentPath, "document");
      yield* fs.writeFileString(`${attachmentPath}.txt`, "extracted text");
      const payload = JSON.stringify({
        attachments: [
          {
            type: "file",
            id: attachmentId,
            name: "document.pdf",
            mimeType: "application/pdf",
            sizeBytes: 8,
          },
        ],
      });
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${payload} WHERE message_id = 'message-000'`;
      const cleanup = yield* ResourceCleanup.ResourceCleanupService;
      yield* cleanup.cleanupAttachments([attachmentId]);
      expect(yield* fs.exists(attachmentPath)).toBe(true);
      expect(yield* fs.exists(`${attachmentPath}.txt`)).toBe(true);
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-000'`;
      yield* cleanup.cleanupAttachments([attachmentId]);
      expect(yield* fs.exists(attachmentPath)).toBe(false);
      expect(yield* fs.exists(`${attachmentPath}.txt`)).toBe(false);
    }).pipe(
      Effect.provide(
        ResourceCleanup.layer.pipe(
          Layer.provideMerge(testLayer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-sidecar-cleanup-" }),
          ),
          Layer.provide(Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void })),
          Layer.provide(Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void })),
          Layer.provide(
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              deleteForThread: () => Effect.void,
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("indexes eligible guest uploads during rebuild and follows share dismissal", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      const sql = yield* SqlClient.SqlClient;
      const attachment = {
        type: "image",
        id: "thread-0-00000000-0000-4000-8000-000000099999",
        name: "guest.png",
        mimeType: "image/png",
        sizeBytes: 1,
      };
      const payload = (status: string) =>
        JSON.stringify({
          guestShare: {
            messages: [{ id: "guest-message", status, attachments: [attachment] }],
          },
        });
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload("pending")} WHERE thread_id = 'thread-0'`;
      expect((yield* findReadableAttachment(attachment.id))?.threadId).toBe("thread-0");
      expect(yield* findReadableAttachment(attachment.id, "another-thread")).toBeNull();
      yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
      yield* initializeAttachmentReferenceIndex();
      expect((yield* findReadableAttachment(attachment.id))?.threadId).toBe("thread-0");
      yield* rebuildAttachmentReferenceIndex();
      expect((yield* referencedAttachmentPaths([attachment.id])).has(`${attachment.id}.png`)).toBe(
        true,
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload("dismissed")} WHERE thread_id = 'thread-0'`;
      expect(yield* findReadableAttachment(attachment.id)).toBeNull();
      expect((yield* referencedAttachmentPaths([attachment.id])).size).toBe(0);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload("pending")} WHERE thread_id = 'thread-0'`;
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-01' WHERE project_id = 'project'`;
      expect(yield* findReadableAttachment(attachment.id)).toBeNull();
      yield* sql`UPDATE projection_projects SET deleted_at = NULL WHERE project_id = 'project'`;
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'thread-0'`;
      expect((yield* referencedAttachmentPaths([attachment.id])).size).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("repairs malformed guest payloads and clears conservative references", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      yield* rebuildAttachmentReferenceIndex();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES ('thread-broken', 'project', 'Broken', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', '{')`;
      const references = () => sql<{ attachment_id: string }>`
        SELECT attachment_id FROM fork_v2_attachment_references
        WHERE source = 'guest' AND row_id = 'thread-broken'`;
      expect(yield* references()).toEqual([{ attachment_id: "*" }]);
      const attachment = {
        type: "image",
        id: "thread-broken-00000000-0000-4000-8000-000000099999",
        name: "guest.png",
        mimeType: "image/png",
        sizeBytes: 1,
      };
      const repaired = JSON.stringify({
        guestShare: {
          messages: [{ id: "guest-message", status: "pending", attachments: [attachment] }],
        },
      });
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${repaired} WHERE thread_id = 'thread-broken'`;
      expect(yield* references()).toEqual([{ attachment_id: attachment.id }]);
      expect((yield* findReadableAttachment(attachment.id))?.threadId).toBe("thread-broken");
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{' WHERE thread_id = 'thread-broken'`;
      expect(yield* references()).toEqual([{ attachment_id: "*" }]);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = 'thread-broken'`;
      expect(yield* references()).toEqual([]);
      expect(yield* findReadableAttachment(attachment.id)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "signals workers and releases parked cleanup on startup even with a complete index",
    () =>
      Effect.gen(function* () {
        yield* smallFixture;
        const outbox = yield* EffectOutboxV2;
        yield* outbox.enqueue([
          {
            id: "parked-before-restart",
            commandId: CommandId.make("cleanup"),
            threadId: ThreadId.make("thread-0"),
            availableAt: DateTime.makeUnsafe("9999-12-31T23:59:59.999Z"),
            request: { type: "attachment.cleanup", attachmentIds: ["absent"] },
          },
        ]);
        expect(
          Option.isNone(yield* outbox.claimNext({ workerId: "worker", leaseDurationMs: 1000 })),
        ).toBe(true);
        yield* startAttachmentReferenceIndex();
        yield* outbox.awaitAvailable;
        yield* awaitAttachmentReferenceIndex();
        const claimed = yield* outbox.claimNext({ workerId: "worker", leaseDurationMs: 1000 });
        expect(Option.isSome(claimed)).toBe(true);
        if (Option.isSome(claimed)) expect(claimed.value.id).toBe("parked-before-restart");
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "repairs runtime damage from another connection when the deletion gate notices it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const dbPath = path.join(directory, "runtime.sqlite");
        yield* Effect.gen(function* () {
          yield* smallFixture;
          const sql = yield* SqlClient.SqlClient;
          yield* startAttachmentReferenceIndex();
          yield* awaitAttachmentReferenceIndex();
          const external = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath)),
            (db) => Effect.sync(() => db.close()),
          );
          external.exec("DROP TRIGGER fork_v2_attachment_message_insert");
          external.exec(`INSERT INTO orchestration_v2_projection_messages SELECT 'new-external-message', thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
          FROM orchestration_v2_projection_messages WHERE message_id = 'message-005'`);
          expect(
            yield* sql`SELECT row_id FROM fork_v2_attachment_references WHERE row_id = 'new-external-message'`,
          ).toEqual([]);
          yield* requireCompleteAttachmentReferenceIndex().pipe(Effect.flip);
          yield* awaitAttachmentReferenceIndex();
          yield* requireCompleteAttachmentReferenceIndex();
          expect(
            yield* sql`SELECT row_id FROM fork_v2_attachment_references WHERE row_id = 'new-external-message'`,
          ).toEqual([{ row_id: "new-external-message" }]);
          expect((yield* findReadableAttachment(id(5)))?.threadId).toBe("thread-0");
          // A reset by a CLI is also noticed by a read gate, without another startup.
          yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
          expect((yield* findReadableAttachment(id(5)))?.threadId).toBe("thread-0");
          yield* awaitAttachmentReferenceIndex();
          yield* requireCompleteAttachmentReferenceIndex();
        }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "reads the partial index first and excludes indexed rows and sources from fallback",
    () =>
      Effect.gen(function* () {
        yield* smallFixture;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        SELECT message_id, thread_id, 1, 'user_message', 'completed', updated_at, payload_json FROM orchestration_v2_projection_messages`;
        yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
        yield* initializeAttachmentReferenceIndex();
        yield* rebuildAttachmentReferenceIndexPass();
        const state = yield* readAttachmentReferenceIndexState();
        expect(state?.cursor).not.toBeNull();
        const rows = yield* sql<{ source: string; payload_json: string }>`
        SELECT source, payload_json FROM (${yield* attachmentSourceRows(undefined, undefined, state)})`;
        const [query, parameters] =
          sql`SELECT * FROM (${yield* attachmentSourceRows("thread-0", undefined, state)})`.compile();
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${query}`,
          parameters,
        );
        expect(
          plan.some((row) => row.detail.includes("messages_thread_created_idx (thread_id=?)")),
        ).toBe(true);
        const indexed = yield* sql<{
          attachment_id: string;
        }>`SELECT attachment_id FROM fork_v2_attachment_references`;
        for (const entry of indexed)
          expect(
            rows
              .filter((row) => row.source === "message")
              .some((row) => row.payload_json.includes(entry.attachment_id)),
          ).toBe(false);
        expect(rows.filter((row) => row.source === "item")).toHaveLength(200);
        let scans = 0;
        let readQuery = sql`SELECT 1`;
        const counted = new Proxy(sql, {
          apply: (target, receiver, args) => {
            const statement = Reflect.apply(target, receiver, args);
            if (
              Array.isArray(args[0]) &&
              statement.compile()[0].includes("json_tree(payload.payload_json)")
            ) {
              scans++;
              if (statement.compile()[0].includes("JOIN orchestration_v2_projection_threads"))
                readQuery = statement;
            }
            return statement;
          },
        });
        expect(
          (yield* findReadableAttachment(id(0)).pipe(
            Effect.provideService(SqlClient.SqlClient, counted),
          ))?.threadId,
        ).toBe("thread-0");
        expect(scans).toBe(0);
        for (const owner of [undefined, "thread-0"]) {
          expect(
            (yield* findReadableAttachment(
              "thread-0-00000000-0000-4000-8000-000000000199",
              owner,
            ).pipe(Effect.provideService(SqlClient.SqlClient, counted)))?.threadId,
          ).toBe("thread-0");
          const [readSql, readParameters] = readQuery.compile();
          const readPlan = yield* sql.unsafe<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${readSql}`,
            readParameters,
          );
          for (const index of [
            "messages_thread_created_idx",
            "turn_items_thread_run_idx",
            "idx_projection_thread_messages_thread_created_id",
          ])
            expect(readPlan.some((row) => row.detail.includes(`${index} (thread_id=?)`))).toBe(
              true,
            );
        }
        // Complete the messages, then stop part-way through the next source.
        while ((yield* readAttachmentReferenceIndexState())?.source_index === 0)
          yield* rebuildAttachmentReferenceIndexPass();
        yield* rebuildAttachmentReferenceIndexPass();
        const next = yield* readAttachmentReferenceIndexState();
        const remaining = yield* sql<{ source: string; payload_json: string }>`
        SELECT source, payload_json FROM (${yield* attachmentSourceRows(undefined, undefined, next)})`;
        expect(remaining.every((row) => row.source === "item" || row.source === "guest")).toBe(
          true,
        );
        expect(remaining.filter((row) => row.source === "guest")).toHaveLength(1);
        const done = yield* sql<{
          attachment_id: string;
        }>`SELECT attachment_id FROM fork_v2_attachment_references WHERE source = 'item'`;
        for (const entry of done)
          expect(remaining.some((row) => row.payload_json.includes(entry.attachment_id))).toBe(
            false,
          );
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect("uses the ID segment only to narrow an unindexed mint, never to grant ownership", () =>
    Effect.gen(function* () {
      yield* smallFixture;
      const sql = yield* SqlClient.SqlClient;
      const inherited = "thread-original-00000000-0000-4000-8000-000000000001";
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.attachments[0].id', ${inherited}) WHERE message_id = 'message-199'`;
      yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
      yield* initializeAttachmentReferenceIndex();
      expect(yield* findReadableAttachment(inherited)).toBeNull();
      expect((yield* findReadableAttachment(inherited, "thread-0"))?.threadId).toBe("thread-0");
      expect(yield* findReadableAttachment(id(5), "thread-original")).toBeNull();
      let scans = 0;
      const counted = new Proxy(sql, {
        apply(target, receiver, args) {
          const statement = Reflect.apply(target, receiver, args);
          if (
            Array.isArray(args[0]) &&
            statement.compile()[0].includes("json_tree(payload.payload_json)")
          )
            scans++;
          return statement;
        },
      });
      expect(
        yield* findReadableAttachment("unparseable").pipe(
          Effect.provideService(SqlClient.SqlClient, counted),
        ),
      ).toBeNull();
      expect(scans).toBe(0);
      yield* rebuildAttachmentReferenceIndex();
      expect((yield* findReadableAttachment(inherited))?.threadId).toBe("thread-0");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("shared CLI persistence prepares the index but only server startup rebuilds it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
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
        yield* startAttachmentReferenceIndex();
        yield* awaitAttachmentReferenceIndex();
        yield* requireCompleteAttachmentReferenceIndex();
        expect(yield* sql`SELECT count(*) AS count FROM fork_v2_attachment_references`).toEqual([
          { count: 200 },
        ]);
      }).pipe(Effect.provide(database));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["message", "item", "legacy"] as const)(
    "reads an unindexed %s attachment from live source metadata only",
    (source) =>
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
      // Read-side repair invalidates the DDL cookie once more.
      expect(checks).toBe(4);
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
      yield* startAttachmentReferenceIndex().pipe(
        Effect.provideService(SqlClient.SqlClient, gated),
      );
      expect(yield* Queue.take(attempts)).toBe(1);
      for (const [i, delay] of [100, 200, 400, 800, 1600, 3200, 5000, 5000].entries()) {
        yield* TestClock.adjust(delay - 1);
        expect(failures).toBe(i + 1);
        yield* TestClock.adjust(1);
        if (i < 7) expect(yield* Queue.take(attempts)).toBe(i + 2);
      }
      yield* awaitAttachmentReferenceIndex().pipe(
        Effect.provideService(SqlClient.SqlClient, gated),
      );
      yield* requireCompleteAttachmentReferenceIndex();
      expect((yield* findReadableAttachment(id(5)))?.threadId).toBe("thread-0");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each([
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
  ])("repairs a %s on initialization before trusting any reference", ([damage, statement]) =>
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
      yield* awaitAttachmentReferenceIndex().pipe(
        Effect.provideService(SqlClient.SqlClient, gated),
      );
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
    "keeps indexed lookups and cleanup correct during streaming on 1,000 threads and 10,000 messages",
    () =>
      Effect.gen(function* () {
        yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* findReadableAttachment("unknown")).toBeNull();
        const ids = Array.from({ length: 10 }, (_, i) => id(i));
        for (const attachmentId of ids) {
          expect(yield* findReadableAttachment(attachmentId)).toMatchObject({
            threadId: "thread-0",
            relativePath: `${attachmentId}.png`,
          });
        }
        expect((yield* referencedAttachmentPaths(ids)).size).toBe(10);
        const before = yield* sql`SELECT count(*) AS count FROM fork_v2_attachment_references`;
        let reads = 0;
        const counted = new Proxy(sql, {
          apply: (target, receiver, args) => {
            reads++;
            return Reflect.apply(target, receiver, args);
          },
        });
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

        for (let i = 0; i < 1000; i++)
          yield* applyWithAttachmentPruning(stored, Effect.void).pipe(
            Effect.provideService(SqlClient.SqlClient, counted),
          );
        expect(reads).toBe(0);
        const streamPayload =
          '{"text":"' + "x".repeat(4096) + '","attachments":[],"streaming":true}';
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('stream', 'thread-0', 'assistant', 1, '2026-01-01', '2026-01-01', ${streamPayload})`;
        for (let i = 0; i < 1000; i++)
          yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${streamPayload}
          WHERE message_id = 'stream'`;
        expect(yield* sql`SELECT count(*) AS count FROM fork_v2_attachment_references`).toEqual(
          before,
        );
        expect((yield* referencedAttachmentPaths(ids)).size).toBe(10);
        for (const attachmentId of ids)
          expect((yield* findReadableAttachment(attachmentId))?.threadId).toBe("thread-0");
      }).pipe(Effect.provide(testLayer)),
  );
});
