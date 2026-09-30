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
import {
  initializeAttachmentReferenceIndex,
  rebuildAttachmentReferenceIndex,
  rebuildAttachmentReferenceIndexPass,
  startAttachmentReferenceIndex,
  awaitAttachmentReferenceIndex,
} from "./AttachmentReferenceIndex.ts";
import { referencedAttachmentPaths } from "./AttachmentReferences.ts";
import {
  OrchestrationEffectExecutorV2,
  OrchestrationEffectExecutionError,
  OrchestrationEffectWorkerV2,
  layerWithOptions as workerLayer,
} from "./EffectWorker.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-protections-" });
const databaseLayer = SqlitePersistenceMemory;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeDraft = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      attachments: Schema.Array(Schema.Struct({ uploadedAttachmentId: Schema.String })),
    }),
  ),
);
const decodeTestClaims = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
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

const signedClaim = Effect.fnUntraced(function* (claims: object, secretOverride?: Uint8Array) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const secret =
    secretOverride ?? (yield* secrets.getOrCreateRandom("asset-access-signing-key", 32));
  const encoded = base64UrlEncode(
    encodeJson({
      version: 1,
      kind: "attachment",
      expiresAt: DateTime.toEpochMillis(yield* DateTime.now) + 10000,
      ...claims,
    }),
  );
  return `${encoded}.${signPayload(encoded, secret)}`;
});

describe("pending draft verification", () => {
  for (const extension of ["png", "pdf"]) {
    it.effect(
      `verifies a persisted pending ${extension} after a draft reload without consulting projections`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig;
          const id = `pending-00000000-0000-4000-8000-000000000002${extension === "pdf" ? "-pdf" : ""}`;
          const file = path.join(config.attachmentsDir, `${id}.${extension}`);
          yield* fs.writeFile(file, new Uint8Array([1, 2, 3]));
          const draft = yield* decodeDraft(
            encodeJson({ attachments: [{ uploadedAttachmentId: id }] }),
          );
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE fork_v2_attachment_references`;
          const minted = yield* issueAssetUrl({
            resource: {
              _tag: "attachment",
              attachmentId: draft.attachments[0]!.uploadedAttachmentId,
            },
          });
          expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "attachment")).toMatchObject({
            kind: "file",
            path: file,
          });
          yield* fs.remove(file);
          expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "attachment")).toBeNull();
          expect(
            (yield* issueAssetUrl({ resource: { _tag: "attachment", attachmentId: id } }).pipe(
              Effect.flip,
            ))._tag,
          ).toBe("AssetAttachmentNotFoundError");
        }).pipe(Effect.provide(testLayer)),
    );
  }
  it.effect(
    "refuses pending claims for a different file, owner, identity, signature or expiry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const id = "pending-00000000-0000-4000-8000-000000000002";
        const otherId = "pending-00000000-0000-4000-8000-000000000003";
        const file = path.join(config.attachmentsDir, `${id}.png`);
        yield* fs.writeFileString(file, "pending");
        yield* fs.writeFileString(path.join(config.attachmentsDir, `${otherId}.png`), "other");
        const minted = yield* issueAssetUrl({ resource: { _tag: "attachment", attachmentId: id } });
        const claims = decodeTestClaims(
          Buffer.from(tokenOf(minted.relativeUrl).split(".")[0]!, "base64url").toString(),
        );
        for (const extra of [
          { relativePath: `${otherId}.png` },
          { attachmentId: otherId },
          { threadId: ownerId },
          { device: "different" },
          { inode: "different" },
          { relativePath: undefined },
          { device: undefined, inode: undefined },
          { expiresAt: 0 },
          { attachmentId: attachment.id, relativePath: `${attachment.id}.png` },
        ])
          expect(
            yield* resolveAsset(yield* signedClaim({ ...claims, ...extra }), "attachment"),
          ).toBeNull();
        expect(yield* resolveAsset(`${tokenOf(minted.relativeUrl)}x`, "attachment")).toBeNull();
        expect(
          yield* resolveAsset(yield* signedClaim(claims, new Uint8Array(32).fill(7)), "attachment"),
        ).toBeNull();
        const replacement = path.join(config.attachmentsDir, "replacement.png");
        yield* fs.writeFileString(replacement, "replacement");
        yield* fs.remove(file);
        yield* fs.rename(replacement, file);
        expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "attachment")).toBeNull();
        yield* TestClock.adjust("61 minutes");
        expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "attachment")).toBeNull();
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect.skipIf(!symlinksSupported)("refuses pending symlinks at issue and redemption", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const id = "pending-00000000-0000-4000-8000-000000000002";
      const file = path.join(config.attachmentsDir, `${id}.png`);
      yield* fs.writeFileString(file, "pending");
      const minted = yield* issueAssetUrl({ resource: { _tag: "attachment", attachmentId: id } });
      const target = path.join(config.stateDir, "outside.png");
      yield* fs.writeFileString(target, "outside");
      yield* fs.remove(file);
      yield* Effect.promise(() => NodeFSP.symlink(target, file));
      expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "attachment")).toBeNull();
      expect(
        (yield* issueAssetUrl({ resource: { _tag: "attachment", attachmentId: id } }).pipe(
          Effect.flip,
        ))._tag,
      ).toBe("AssetAttachmentNotFoundError");
    }).pipe(Effect.provide(testLayer)),
  );
});

for (const bad of [
  "\\\\server\\share\\file",
  `${attachment.id}:stream`,
  attachment.id.toUpperCase(),
]) {
  it.effect(`refuses unsafe ID and signed path ${bad}`, () =>
    Effect.gen(function* () {
      yield* seedAttachment();
      expect(
        (yield* issueAssetUrl({ resource: { _tag: "attachment", attachmentId: bad } }).pipe(
          Effect.flip,
        ))._tag,
      ).toBe("AssetAttachmentNotFoundError");
      expect(
        yield* resolveAsset(
          yield* signedClaim({
            attachmentId: bad,
            threadId: ownerId,
            relativePath: `${attachment.id}.png`,
          }),
          "attachment",
        ),
      ).toBeNull();
      expect(
        yield* resolveAsset(
          yield* signedClaim({ attachmentId: attachment.id, threadId: ownerId, relativePath: bad }),
          "attachment",
        ),
      ).toBeNull();
      const pendingId = "pending-00000000-0000-4000-8000-000000000002";
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      yield* fs.writeFileString(path.join(config.attachmentsDir, `${pendingId}.png`), "pending");
      const minted = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId: pendingId },
      });
      const claims = decodeTestClaims(
        Buffer.from(tokenOf(minted.relativeUrl).split(".")[0]!, "base64url").toString(),
      );
      expect(
        yield* resolveAsset(yield* signedClaim({ ...claims, relativePath: bad }), "attachment"),
      ).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );
}

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
      const result = yield* issue();
      const resolved = yield* resolveAsset(tokenOf(result.relativeUrl), "image.png");
      expect(resolved).toMatchObject({ kind: "file", path: file });
      expect(yield* resolveAsset(`${tokenOf(result.relativeUrl)}x`, "image.png")).toBeNull();
      yield* TestClock.adjust("61 minutes");
      expect(yield* resolveAsset(tokenOf(result.relativeUrl), "image.png")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses orphan files and unsafe IDs even when the file exists", () =>
    Effect.gen(function* () {
      yield* createThread();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      for (const attachmentId of [attachment.id, "../outside", "C:\\outside"]) {
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
      const issued = yield* issue();
      const claims = decodeTestClaims(
        Buffer.from(tokenOf(issued.relativeUrl).split(".")[0]!, "base64url").toString(),
      );
      expect(claims.threadId).toBe(ownerId);
      expect(claims.threadId).not.toBe(collidingId);
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
        yield* sql`DROP TABLE fork_v2_attachment_references`;
        expect(yield* resolveAsset(tokenOf(result.relativeUrl), "image.png")).toBeNull();
        expect((yield* issue().pipe(Effect.flip))._tag).toBe("AssetAttachmentNotFoundError");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "refuses correctly signed legacy claims without an owner and claims for the wrong thread",
    () =>
      Effect.gen(function* () {
        yield* seedAttachment();
        yield* createThread(ThreadId.make("thread-other"));
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const secret = yield* secretStore.getOrCreateRandom("asset-access-signing-key", 32);
        for (const extra of [
          {},
          { threadId: "missing" },
          { threadId: "thread-other" },
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
    "reads only the bound file and owner throughout a rebuild, then prunes missed rows",
    () =>
      Effect.gen(function* () {
        const { file, thread } = yield* seedAttachment();
        const minted = yield* issue();
        const sql = yield* SqlClient.SqlClient;
        const sink = yield* EventSinkV2;
        const other = yield* createThread(ThreadId.make("other-during-rebuild"));
        const otherAttachment = { ...attachment, id: ChatAttachmentId.make("other-file") };
        yield* sink.write({
          events: [yield* messageEvent("other:image", [otherAttachment], other.id)],
        });
        yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
        yield* initializeAttachmentReferenceIndex();
        // No backfill has run: all authorization must come from source tables.
        expect(yield* sql`SELECT * FROM fork_v2_attachment_references`).toEqual([]);
        expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "image.png")).toMatchObject({
          kind: "file",
          path: file,
        });
        expect(
          yield* resolveAsset(tokenOf((yield* issue()).relativeUrl), "image.png"),
        ).toMatchObject({ path: file });
        expect(
          yield* resolveAsset(
            yield* signedClaim({
              attachmentId: attachment.id,
              threadId: other.id,
              relativePath: `${attachment.id}.png`,
            }),
            "image.png",
          ),
        ).toBeNull();
        expect(
          yield* resolveAsset(
            yield* signedClaim({
              attachmentId: attachment.id,
              threadId: ownerId,
              relativePath: "other-file.png",
            }),
            "image.png",
          ),
        ).toBeNull();
        const cleanup = yield* ResourceCleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([attachment.id]).pipe(Effect.flip);
        expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(true);
        yield* sink.write({ events: [yield* messageEvent("unindexed:remove", [])] });
        const effects = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_effect_outbox WHERE effect_type = 'attachment.cleanup'`;
        expect(effects.some((row) => row.payload_json.includes(`${attachment.id}.png`))).toBe(true);
        expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "image.png")).toBeNull();
        expect((yield* issue().pipe(Effect.flip))._tag).toBe("AssetAttachmentNotFoundError");
        yield* rebuildAttachmentReferenceIndex();
        yield* cleanup.cleanupAttachments([attachment.id]);
        expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(false);
        yield* deleteThread(thread);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps a file on a case-insensitive store while a differently cased ID still references it",
    () =>
      Effect.gen(function* () {
        const { file } = yield* seedAttachment();
        const fs = yield* FileSystem.FileSystem;
        const upper = { ...attachment, id: ChatAttachmentId.make(attachment.id.toUpperCase()) };
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const ignoresCase = yield* fs.exists(
          path.join(config.attachmentsDir, `Thread-owner-00000000-0000-4000-8000-000000000001.png`),
        );
        const other = yield* createThread(ThreadId.make("case-holder"));
        const sink = yield* EventSinkV2;
        yield* sink.write({
          events: [
            yield* messageEvent("case:reference", [upper], other.id),
            yield* messageEvent("case:removed", []),
          ],
        });
        const cleanup = yield* ResourceCleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([attachment.id]);
        expect(yield* fs.exists(file)).toBe(ignoresCase);
        // Also check the case-folded index lookup on every platform.
        expect(
          (yield* referencedAttachmentPaths([attachment.id], true)).has(`${attachment.id}.png`),
        ).toBe(true);
        yield* sink.write({
          events: [yield* messageEvent("case:last-reference-removed", [], other.id)],
        });
        yield* cleanup.cleanupAttachments([attachment.id]);
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  for (const completion of ["startup signal", "before parking"] as const) {
    it.effect(`keeps cleanup pending without spending attempts and resumes on ${completion}`, () =>
      Effect.gen(function* () {
        const { file } = yield* seedAttachment();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
        yield* initializeAttachmentReferenceIndex();
        yield* (yield* EventSinkV2).write({ events: [yield* messageEvent("rebuild:removed", [])] });
        const cleanup = yield* ResourceCleanup.ResourceCleanupService;
        const executor = OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            effect.request.type === "attachment.cleanup"
              ? cleanup
                  .cleanupAttachments(effect.request.attachmentIds, effect.request.relativePaths)
                  .pipe(
                    Effect.asVoid,
                    Effect.tapError(() =>
                      completion === "before parking"
                        ? rebuildAttachmentReferenceIndex()
                        : Effect.void,
                    ),
                    Effect.mapError(
                      (cause) =>
                        new OrchestrationEffectExecutionError({
                          effectId: effect.id,
                          effectType: effect.request.type,
                          cause,
                        }),
                    ),
                  )
              : Effect.void,
        });
        const worker = yield* OrchestrationEffectWorkerV2.pipe(
          Effect.provide(workerLayer({ maxAttempts: 1 })),
          Effect.provideService(OrchestrationEffectExecutorV2, executor),
        );
        for (let n = 0; n < (completion === "startup signal" ? 10 : 1); n++) {
          expect(yield* worker.runOnce).toBe(n === 0);
          expect(
            yield* sql`SELECT status, attempt_count FROM orchestration_v2_effect_outbox WHERE effect_type = 'attachment.cleanup'`,
          ).toEqual([{ status: "pending", attempt_count: 0 }]);
          expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(true);
          yield* TestClock.adjust("1 day");
        }
        yield* startAttachmentReferenceIndex();
        yield* awaitAttachmentReferenceIndex();
        expect(yield* worker.drain()).toBe(1);
        expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(false);
        expect(
          yield* sql`SELECT status, attempt_count FROM orchestration_v2_effect_outbox WHERE effect_type = 'attachment.cleanup'`,
        ).toEqual([{ status: "succeeded", attempt_count: 1 }]);
      }).pipe(Effect.provide(testLayer)),
    );
  }

  it.effect("retains an imported V2 document descriptor independently of later type mapping", () =>
    Effect.gen(function* () {
      const { file } = yield* seedAttachment();
      const other = yield* createThread(ThreadId.make("imported-document"));
      const sql = yield* SqlClient.SqlClient;
      const document = { ...attachment, type: "document" };
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('imported-document-message', ${other.id}, 'user', 0, '2026-01-01', '2026-01-01', ${encodeJson({ attachments: [document] })})`;
      yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
        VALUES (${other.id}, '2026-01-01', '2026-01-01', '2026-01-01')`;
      yield* (yield* EventSinkV2).write({
        events: [yield* messageEvent("document:mapped-removed", [])],
      });
      const cleanup = yield* ResourceCleanup.ResourceCleanupService;
      yield* cleanup.cleanupAttachments([attachment.id]);
      expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(true);
      expect((yield* issue().pipe(Effect.flip))._tag).toBe("AssetAttachmentNotFoundError");
      yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
      yield* initializeAttachmentReferenceIndex();
      yield* rebuildAttachmentReferenceIndex();
      yield* cleanup.cleanupAttachments([attachment.id]);
      expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(true);
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'imported-document-message'`;
      yield* cleanup.cleanupAttachments([attachment.id]);
      expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "retains a newly referenced file after a trigger is dropped, throughout repair, and after rebuilding",
    () =>
      Effect.gen(function* () {
        const { file } = yield* seedAttachment();
        const minted = yield* issue();
        const other = yield* createThread(ThreadId.make("shared-after-trigger-loss"));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TRIGGER fork_v2_attachment_message_insert`;
        const sink = yield* EventSinkV2;
        yield* sink.write({
          events: [
            yield* messageEvent("new:unindexed-reference", [attachment], other.id),
            yield* messageEvent("old:removed-reference", []),
          ],
        });
        const cleanup = yield* ResourceCleanup.ResourceCleanupService;
        expect((yield* cleanup.cleanupAttachments([attachment.id]).pipe(Effect.flip))._tag).toBe(
          "ResourceCleanupError",
        );
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(file)).toBe(true);
        // Stale ownership also cannot authorize a download with an old token.
        expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "image.png")).toBeNull();
        expect(
          yield* resolveAsset(tokenOf((yield* issue()).relativeUrl), "image.png"),
        ).toMatchObject({ path: file });
        yield* initializeAttachmentReferenceIndex();
        yield* rebuildAttachmentReferenceIndexPass();
        expect((yield* cleanup.cleanupAttachments([attachment.id]).pipe(Effect.flip))._tag).toBe(
          "ResourceCleanupError",
        );
        expect(yield* fs.exists(file)).toBe(true);
        yield* rebuildAttachmentReferenceIndex();
        yield* cleanup.cleanupAttachments([attachment.id]);
        expect(yield* fs.exists(file)).toBe(true);
        expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "image.png")).toBeNull();
        expect(
          yield* resolveAsset(tokenOf((yield* issue()).relativeUrl), "image.png"),
        ).toMatchObject({ kind: "file", path: file });
        yield* sink.write({
          events: [yield* messageEvent("new:last-reference-removed", [], other.id)],
        });
        yield* cleanup.cleanupAttachments([attachment.id]);
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "indexes unopened legacy PDFs before shells and preserves them through background transcript hydration",
    () =>
      Effect.gen(function* () {
        const owner = yield* createThread();
        const pdf = {
          ...attachment,
          type: "file",
          name: "shared.pdf",
          mimeType: "application/pdf",
        } satisfies ChatAttachment;
        const legacyPdf = { ...pdf, type: "document" };
        const legacyId = ThreadId.make("a-unopened-legacy");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json)
        VALUES ('legacy:pdf', ${legacyId}, 'user', '', 0, '2026-01-01', '2026-01-01', ${encodeJson([legacyPdf])})`;
        const sink = yield* EventSinkV2;
        yield* sink.write({ events: [yield* messageEvent("hydrated:pdf", [pdf])] });
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const path = yield* Path.Path;
        const file = path.join(config.attachmentsDir, `${pdf.id}.pdf`);
        yield* fs.writeFileString(file, "pdf");
        // Force a rebuild: legacy rows must be backfilled even without a V2 shell.
        yield* sql`UPDATE fork_v2_attachment_reference_state SET version = 1`;
        yield* initializeAttachmentReferenceIndex();
        const cleanup = yield* ResourceCleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([pdf.id], [`${pdf.id}.pdf`]).pipe(Effect.flip);
        yield* rebuildAttachmentReferenceIndex();
        expect(
          yield* sql`SELECT attachment_id FROM fork_v2_attachment_references WHERE source = 'legacy' AND row_id = 'legacy:pdf'`,
        ).toEqual([{ attachment_id: pdf.id }]);
        yield* cleanup.cleanupAttachments([pdf.id], [`${pdf.id}.pdf`]);
        expect(yield* fs.exists(file)).toBe(true);
        yield* createThread(legacyId);
        yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at)
        VALUES (${legacyId}, '2026-01-01', '2026-01-01')`;
        // The document row sorts first, but must not hide the readable V2 file.
        const minted = yield* issue();
        expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "shared.pdf")).toMatchObject({
          path: file,
        });
        yield* deleteThread(owner);
        yield* cleanup.cleanupAttachments([pdf.id], [`${pdf.id}.pdf`]);
        expect(yield* fs.exists(file)).toBe(true);
        expect((yield* issue().pipe(Effect.flip))._tag).toBe("AssetAttachmentNotFoundError");
        // Match the importer's ordering: project messages, then mark transcript complete.
        yield* sink.write({ events: [yield* messageEvent("background:pdf", [pdf], legacyId)] });
        yield* cleanup.cleanupAttachments([pdf.id], [`${pdf.id}.pdf`]);
        expect(yield* fs.exists(file)).toBe(true);
        yield* sql`UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = '2026-01-01' WHERE thread_id = ${legacyId}`;
        yield* cleanup.cleanupAttachments([pdf.id], [`${pdf.id}.pdf`]);
        expect(yield* fs.exists(file)).toBe(true);
        expect(
          yield* resolveAsset(tokenOf((yield* issue()).relativeUrl), "shared.pdf"),
        ).toMatchObject({ path: file });
        yield* sink.write({
          events: [yield* messageEvent("background:pdf-removed", [], legacyId)],
        });
        yield* cleanup.cleanupAttachments([pdf.id], [`${pdf.id}.pdf`]);
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses malformed references and retains bytes until metadata is repaired", () =>
    Effect.gen(function* () {
      const { file } = yield* seedAttachment();
      const minted = yield* issue();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = 'malformed' WHERE message_id = ${`message:${ownerId}`}`;
      expect(yield* resolveAsset(tokenOf(minted.relativeUrl), "image.png")).toBeNull();
      expect((yield* issue().pipe(Effect.flip))._tag).toBe("AssetAttachmentNotFoundError");
      const cleanup = yield* ResourceCleanup.ResourceCleanupService;
      yield* cleanup.cleanupAttachments([attachment.id], [`${attachment.id}.png`]);
      expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(true);
      yield* (yield* EventSinkV2).write({ events: [yield* messageEvent("repaired", [])] });
      yield* cleanup.cleanupAttachments([attachment.id], [`${attachment.id}.png`]);
      expect(yield* (yield* FileSystem.FileSystem).exists(file)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("bounds each cleanup pass to 128 paths and continues through a large thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const ids = Array.from(
        { length: 1001 },
        (_, i) => `thread-owner-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
      yield* Effect.forEach(
        ids,
        (id) => fs.writeFileString(path.join(config.attachmentsDir, `${id}.png`), "bytes"),
        { concurrency: 4 },
      );
      const cleanup = yield* ResourceCleanup.ResourceCleanupService;
      let pending: ResourceCleanup.AttachmentCleanupContinuation | void = {
        attachmentIds: ids,
        relativePaths: ids.map((id) => `${id}.png`),
      };
      let passes = 0;
      while (pending !== undefined) {
        pending = yield* cleanup.cleanupAttachments(pending.attachmentIds, pending.relativePaths);
        passes++;
        expect((yield* fs.readDirectory(config.attachmentsDir)).length).toBe(
          Math.max(0, 1001 - 128 * passes),
        );
        // Other SQL can make progress between passes.
        expect(yield* (yield* SqlClient.SqlClient)`SELECT 1 AS ready`).toEqual([{ ready: 1 }]);
      }
      expect(passes).toBe(8);
    }).pipe(Effect.provide(testLayer)),
  );
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
      yield* sql`DROP TABLE fork_v2_attachment_references`;
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
