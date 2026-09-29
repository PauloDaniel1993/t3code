// @effect-diagnostics nodeBuiltinImport:off - tests plant filesystem escapes in isolated fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { issueAssetUrl, resolveAsset } from "../assets/AssetAccess.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode, signPayload } from "../auth/utils.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ProjectFaviconResolver } from "../project/ProjectFaviconResolver.ts";
import { NativeAppIconResolver } from "../assets/NativeAppIconResolver.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { EffectOutboxV2, layer as outboxLayer } from "./EffectOutbox.ts";
import * as ResourceCleanup from "./ResourceCleanupService.ts";
import { OrchestrationV2EventSinkLayerLive } from "./runtimeLayer.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-protections-" });
const databaseLayer = SqlitePersistenceMemory;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const testLayer = Layer.mergeAll(
  databaseLayer,
  configLayer,
  WorkspacePaths.layer,
  Layer.mock(ProjectFaviconResolver)({ resolvePath: () => Effect.die("unused favicon") }),
  Layer.mock(NativeAppIconResolver)({ resolve: () => Effect.die("unused icon") }),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
  OrchestrationV2EventSinkLayerLive.pipe(Layer.provide(databaseLayer)),
  outboxLayer.pipe(Layer.provide(databaseLayer)),
  ResourceCleanup.live.pipe(
    Layer.provide(configLayer),
    Layer.provide(databaseLayer),
    Layer.provide(Layer.mock(TerminalManager)({ close: () => Effect.void })),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const attachment = {
  type: "image",
  id: ChatAttachmentId.make("thread-owner-00000000-0000-4000-8000-000000000001"),
  name: "image.png",
  mimeType: "image/png",
  sizeBytes: 3,
} satisfies ChatAttachment;
const ownerId = ThreadId.make("thread-owner");

const createThread = Effect.fnUntraced(function* (id = ownerId) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const providerInstanceId = ProviderInstanceId.make("codex");
  const thread: OrchestrationV2AppThread = {
    id,
    projectId: ProjectId.make(`project:${id}`),
    title: id,
    createdBy: "user",
    creationSource: "web",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${thread.projectId}, 'Test', '/test', '[]', '2026-01-01', '2026-01-01')`;
  const sink = yield* EventSinkV2;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`created:${id}`),
        type: "thread.created",
        threadId: id,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  return thread;
});

const messageEvent = Effect.fnUntraced(function* (
  id: string,
  attachments: ReadonlyArray<ChatAttachment>,
  threadId: ThreadId = ownerId,
): Effect.fn.Return<OrchestrationV2DomainEvent> {
  const now = yield* DateTime.now;
  return {
    id: EventId.make(id),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: MessageId.make(`message:${threadId}`),
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      createdBy: "user",
      creationSource: "web",
      text: "Test",
      attachments,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  };
});

const seedAttachment = Effect.fnUntraced(function* () {
  const thread = yield* createThread();
  const sink = yield* EventSinkV2;
  yield* sink.write({ events: [yield* messageEvent("message:initial", [attachment])] });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const file = path.join(config.attachmentsDir, `${attachment.id}.png`);
  yield* fs.writeFile(file, new Uint8Array([1, 2, 3]));
  return { thread, file };
});

const issue = () =>
  issueAssetUrl({ resource: { _tag: "attachment", attachmentId: attachment.id } });
const tokenOf = (relativeUrl: string) => relativeUrl.split("/")[3]!;
const deleteThread = Effect.fnUntraced(function* (thread: OrchestrationV2AppThread) {
  const sink = yield* EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`deleted:${thread.id}`),
        type: "thread.deleted",
        threadId: thread.id,
        occurredAt: now,
        payload: { ...thread, deletedAt: now },
      },
    ],
  });
});

describe("signed attachment ownership", () => {
  it.effect.skipIf(!symlinksSupported)(
    "refuses a referenced path replaced by a symlink outside the attachment directory",
    () =>
      Effect.gen(function* () {
        const { file } = yield* seedAttachment();
        const result = yield* issue();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const outside = path.join(config.stateDir, "outside.png");
        yield* fs.writeFileString(outside, "outside");
        const otherFile = path.join(config.attachmentsDir, "other-attachment.png");
        yield* fs.writeFileString(otherFile, "other attachment");
        yield* fs.remove(file);
        for (const target of [outside, otherFile]) {
          yield* Effect.promise(() => NodeFSP.symlink(target, file));
          expect(yield* resolveAsset(tokenOf(result.relativeUrl), "image.png")).toBeNull();
          expect((yield* issue().pipe(Effect.flip))._tag).toBe("AssetAttachmentNotFoundError");
          yield* fs.remove(file);
        }
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect("derives a real owner for old clients and refuses another or missing thread", () =>
    Effect.gen(function* () {
      const { file } = yield* seedAttachment();
      const otherId = ThreadId.make("thread-other");
      yield* createThread(otherId);
      for (const threadId of [otherId, ThreadId.make("missing")]) {
        const error = yield* issueAssetUrl({
          resource: { _tag: "attachment", attachmentId: attachment.id, threadId },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("AssetAttachmentNotFoundError");
      }
      const result = yield* issue();
      const resolved = yield* resolveAsset(tokenOf(result.relativeUrl), "image.png");
      expect(resolved).toMatchObject({ kind: "file", path: file });
      expect(yield* resolveAsset(`${tokenOf(result.relativeUrl)}x`, "image.png")).toBeNull();
      yield* TestClock.adjust("61 minutes");
      expect(yield* resolveAsset(tokenOf(result.relativeUrl), "image.png")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses orphan and pending files even when they have a plausible thread prefix", () =>
    Effect.gen(function* () {
      yield* createThread();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      for (const attachmentId of [
        attachment.id,
        "pending-00000000-0000-4000-8000-000000000001",
        "../outside",
        "C:\\outside",
      ]) {
        if (!attachmentId.includes("/") && !attachmentId.includes("\\"))
          yield* fs.writeFile(
            path.join(config.attachmentsDir, `${attachmentId}.png`),
            new Uint8Array([1]),
          );
        const error = yield* issueAssetUrl({ resource: { _tag: "attachment", attachmentId } }).pipe(
          Effect.flip,
        );
        expect(error._tag).toBe("AssetAttachmentNotFoundError");
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not confuse thread ids whose normalized filename segments collide", () =>
    Effect.gen(function* () {
      yield* seedAttachment();
      const collidingId = ThreadId.make("Thread Owner");
      yield* createThread(collidingId);
      const error = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId: attachment.id, threadId: collidingId },
      }).pipe(Effect.flip);
      expect(error._tag).toBe("AssetAttachmentNotFoundError");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "revokes a minted URL after its reference disappears, even if another thread retains the bytes",
    () =>
      Effect.gen(function* () {
        yield* seedAttachment();
        const result = yield* issue();
        const otherId = ThreadId.make("thread-other");
        yield* createThread(otherId);
        const sink = yield* EventSinkV2;
        yield* sink.write({
          events: [
            yield* messageEvent("other:reference", [attachment], otherId),
            yield* messageEvent("owner:pruned", []),
          ],
        });
        expect(yield* resolveAsset(tokenOf(result.relativeUrl), "image.png")).toBeNull();
        expect(
          yield* resolveAsset(tokenOf((yield* issue()).relativeUrl), "image.png"),
        ).toMatchObject({ kind: "file" });
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "revokes downloads after thread or project deletion and fails closed on reference-query errors",
    () =>
      Effect.gen(function* () {
        const { thread } = yield* seedAttachment();
        const result = yield* issue();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_projects SET deleted_at = '2026-01-01' WHERE project_id = ${thread.projectId}`;
        expect(yield* resolveAsset(tokenOf(result.relativeUrl), "image.png")).toBeNull();
        expect((yield* issue().pipe(Effect.flip))._tag).toBe("AssetAttachmentNotFoundError");
        yield* sql`UPDATE projection_projects SET deleted_at = NULL WHERE project_id = ${thread.projectId}`;
        yield* deleteThread(thread);
        expect(yield* resolveAsset(tokenOf(result.relativeUrl), "image.png")).toBeNull();
        expect((yield* issue().pipe(Effect.flip))._tag).toBe("AssetAttachmentNotFoundError");
        yield* sql`DROP TABLE orchestration_v2_projection_messages`;
        expect(yield* resolveAsset(tokenOf(result.relativeUrl), "image.png")).toBeNull();
        expect((yield* issue().pipe(Effect.flip))._tag).toBe("AssetAttachmentNotFoundError");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "refuses correctly signed legacy claims without an owner and claims for the wrong thread",
    () =>
      Effect.gen(function* () {
        yield* seedAttachment();
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const secret = yield* secretStore.getOrCreateRandom("asset-access-signing-key", 32);
        for (const extra of [
          {},
          { threadId: "missing" },
          { threadId: "thread-owner", attachmentId: "../outside" },
          { threadId: "thread-owner", relativePath: "../outside" },
        ]) {
          const encoded = base64UrlEncode(
            encodeJson({
              version: 1,
              kind: "attachment",
              attachmentId: attachment.id,
              relativePath: `${attachment.id}.png`,
              expiresAt: DateTime.toEpochMillis(yield* DateTime.now) + 10000,
              ...extra,
            }),
          );
          expect(
            yield* resolveAsset(`${encoded}.${signPayload(encoded, secret)}`, "image.png"),
          ).toBeNull();
        }
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("attachment pruning through the effect outbox", () => {
  it.effect(
    "commits stale paths with message edits and preserves the pending effect across replay",
    () =>
      Effect.gen(function* () {
        const { file } = yield* seedAttachment();
        const sink = yield* EventSinkV2;
        const outbox = yield* EffectOutboxV2;
        const commandId = CommandId.make("edit:attachments");
        const event = yield* messageEvent("edit:message", []);
        const input = {
          commandId,
          threadId: ownerId,
          commandType: "queued-run.edit",
          acceptedAt: yield* DateTime.now,
          events: [event],
          effects: [],
        };
        expect((yield* sink.commitCommand(input)).committed).toBe(true);
        expect((yield* sink.commitCommand(input)).committed).toBe(false);
        const effects = yield* outbox.listByCommandId(commandId);
        expect(effects).toHaveLength(1);
        expect(effects[0]?.request).toEqual({
          type: "attachment.cleanup",
          attachmentIds: [attachment.id],
          relativePaths: [`${attachment.id}.png`],
        });
        const claimed = yield* outbox.claimNext({ workerId: "test", leaseDurationMs: 10000 });
        expect(Option.isSome(claimed)).toBe(true);
        expect(yield* outbox.reconcileAfterProcessLoss).toEqual({ requeued: 1, cancelled: 0 });
        const reclaimed = yield* outbox.claimNext({ workerId: "restart", leaseDurationMs: 10000 });
        expect(Option.isSome(reclaimed)).toBe(true);
        const cleanup = yield* ResourceCleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([attachment.id], [`${attachment.id}.png`]);
        yield* cleanup.cleanupAttachments([attachment.id], [`${attachment.id}.png`]);
        expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rolls back both the projection and cleanup when a later event cannot be projected",
    () =>
      Effect.gen(function* () {
        yield* seedAttachment();
        const sink = yield* EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER refuse_thread_update BEFORE UPDATE ON orchestration_v2_projection_threads BEGIN SELECT RAISE(ABORT, 'test refusal'); END`;
        const thread = yield* createThread(ThreadId.make("other"));
        const event = yield* messageEvent("edit:rollback", []);
        yield* sink
          .write({
            events: [
              event,
              {
                id: EventId.make("thread:refused"),
                type: "thread.metadata-updated",
                threadId: thread.id,
                occurredAt: yield* DateTime.now,
                payload: { ...thread, title: "Refused" },
              },
            ],
          })
          .pipe(Effect.flip);
        const result = yield* issue();
        expect(yield* resolveAsset(tokenOf(result.relativeUrl), "image.png")).toMatchObject({
          kind: "file",
        });
        const outbox = yield* EffectOutboxV2;
        expect(Option.isNone(yield* outbox.get(`effect:${event.id}:attachment.prune`))).toBe(true);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "retains shared and unhydrated legacy references before pruning the last reference",
    () =>
      Effect.gen(function* () {
        const { thread, file } = yield* seedAttachment();
        const other = yield* createThread(ThreadId.make("other"));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json)
        VALUES ('legacy:message', ${other.id}, 'user', '', 0, '2026-01-01', '2026-01-01', ${encodeJson([attachment])})`;
        yield* deleteThread(thread);
        const cleanup = yield* ResourceCleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([attachment.id]);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(file)).toBe(true);
        const sink = yield* EventSinkV2;
        yield* sink.write({
          events: [yield* messageEvent("other:shared", [attachment], other.id)],
        });
        yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
        VALUES (${other.id}, '2026-01-01', '2026-01-01', '2026-01-01')`;
        yield* cleanup.cleanupAttachments([attachment.id]);
        expect(yield* fs.exists(file)).toBe(true);
        yield* sink.write({
          events: [yield* messageEvent("other:last-reference-removed", [], other.id)],
        });
        yield* cleanup.cleanupAttachments([attachment.id]);
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "prunes replaced paths while retaining a different format under the same attachment id",
    () =>
      Effect.gen(function* () {
        const { file } = yield* seedAttachment();
        const fs = yield* FileSystem.FileSystem;
        const jpeg = file.replace(/\.png$/, ".jpg");
        yield* fs.writeFile(jpeg, new Uint8Array([4, 5, 6]));
        const sink = yield* EventSinkV2;
        const replacement = { ...attachment, name: "image.jpg", mimeType: "image/jpeg" };
        const event = yield* messageEvent("edit:format", [replacement]);
        yield* sink.write({ events: [event] });
        const cleanup = yield* ResourceCleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([attachment.id], [`${attachment.id}.png`]);
        expect(yield* fs.exists(file)).toBe(false);
        expect(yield* fs.exists(jpeg)).toBe(true);
        const config = yield* ServerConfig;
        const path = yield* Path.Path;
        const outside = path.join(config.stateDir, "outside.png");
        yield* fs.writeFileString(outside, "outside");
        yield* cleanup.cleanupAttachments(
          [attachment.id],
          ["../outside.png", `subdir/${attachment.id}.jpg`, `${attachment.id}.jpg`],
        );
        expect(yield* fs.exists(jpeg)).toBe(true);
        expect(yield* fs.readFileString(outside)).toBe("outside");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "includes attachments found only in question-answer turn items on thread deletion",
    () =>
      Effect.gen(function* () {
        const thread = yield* createThread();
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${TurnItemId.make("question:answer")}, ${ownerId}, 1, 'user_input_request', 'completed', ${DateTime.formatIso(now)}, ${encodeJson({ questionAnswer: { attachmentsByQuestionId: { question: [attachment] } } })})`;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const path = yield* Path.Path;
        const file = path.join(config.attachmentsDir, `${attachment.id}.png`);
        yield* fs.writeFile(file, new Uint8Array([1, 2, 3]));
        yield* issue();
        yield* deleteThread(thread);
        const outbox = yield* EffectOutboxV2;
        const effect = yield* outbox.get(`effect:deleted:${ownerId}:attachment.prune`);
        expect(Option.isSome(effect)).toBe(true);
        const cleanup = yield* ResourceCleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([attachment.id], [`${attachment.id}.png`]);
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not delete bytes when the reference query fails", () =>
    Effect.gen(function* () {
      const { file } = yield* seedAttachment();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE orchestration_v2_projection_messages`;
      const cleanup = yield* ResourceCleanup.ResourceCleanupService;
      const error = yield* cleanup.cleanupAttachments([attachment.id]).pipe(Effect.flip);
      expect(error._tag).toBe("ResourceCleanupError");
      expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps an attachment restored before its stale cleanup effect executes", () =>
    Effect.gen(function* () {
      const { file } = yield* seedAttachment();
      const sink = yield* EventSinkV2;
      yield* sink.write({
        events: [
          yield* messageEvent("remove:temporarily", []),
          yield* messageEvent("restore:attachment", [attachment]),
        ],
      });
      const cleanup = yield* ResourceCleanup.ResourceCleanupService;
      yield* cleanup.cleanupAttachments([attachment.id], [`${attachment.id}.png`]);
      expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
