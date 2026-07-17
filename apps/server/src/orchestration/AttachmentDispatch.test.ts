// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationEvent,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { expect } from "vite-plus/test";

import { ATTACHMENT_STAGING_DIRECTORY_NAME, sweepAttachmentStaging } from "../attachmentStaging.ts";
import { ATTACHMENT_ID_THREAD_ID_CONSTRAINT_MESSAGE } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "./Services/ProjectionPipeline.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function upload(
  attachment: Omit<UploadChatAttachment, "dataUrl" | "sizeBytes"> & {
    readonly bytes: Uint8Array;
    readonly dataUrl?: string;
    readonly sizeBytes?: number;
  },
): UploadChatAttachment {
  const { bytes, dataUrl: suppliedDataUrl, sizeBytes, ...metadata } = attachment;
  return {
    ...metadata,
    sizeBytes: sizeBytes ?? bytes.byteLength,
    dataUrl: suppliedDataUrl ?? dataUrl(metadata.mimeType, bytes),
  } as UploadChatAttachment;
}

function turnCommand(input: {
  readonly commandId: string;
  readonly messageId?: string;
  readonly threadId?: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
}): Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }> {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(input.commandId),
    threadId: ThreadId.make(input.threadId ?? "thread-attachments"),
    message: {
      messageId: MessageId.make(input.messageId ?? `message-${input.commandId}`),
      role: "user",
      text: "attachments",
      attachments: [...input.attachments],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    createdAt: NOW,
  };
}

function makeFailingTransactionSqlLayer(consumeFailure: () => boolean) {
  return Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const client = new Proxy(sql, {
        get(target, property, receiver) {
          if (property !== "withTransaction") {
            return Reflect.get(target, property, receiver) as unknown;
          }
          return <R, E, A>(effect: Effect.Effect<A, E, R>) => {
            if (!consumeFailure()) {
              return sql.withTransaction(effect);
            }
            return sql.withTransaction(
              effect.pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new SqlError.SqlError({
                      reason: new SqlError.UnknownError({
                        cause: "injected transaction commit failure",
                        message: "injected transaction commit failure",
                        operation: "COMMIT",
                      }),
                    }),
                  ),
                ),
              ),
            );
          };
        },
      });
      return client;
    }),
  ).pipe(Layer.provide(SqlitePersistenceMemory));
}

function makeTestEnvironment(options?: {
  readonly projectionPipeline?: OrchestrationProjectionPipelineShape;
  readonly injectTransactionFailure?: boolean;
}) {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-attachment-dispatch-test-",
  });
  const projectionPipeline =
    options?.projectionPipeline ??
    ({
      bootstrap: Effect.void,
      projectEvent: () => Effect.void,
    } satisfies OrchestrationProjectionPipelineShape);
  let failNextTransaction = false;
  const sqlLayer = options?.injectTransactionFailure
    ? makeFailingTransactionSqlLayer(() => {
        if (!failNextTransaction) return false;
        failNextTransaction = false;
        return true;
      })
    : SqlitePersistenceMemory;
  const layer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, projectionPipeline)),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(sqlLayer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    failNextTransaction: () => {
      failNextTransaction = true;
    },
  };
}

const makeSystem = Effect.fn("makeAttachmentDispatchTestSystem")(function* () {
  const engine = yield* OrchestrationEngineService;
  const config = yield* ServerConfig;
  const published: OrchestrationEvent[] = [];
  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      Effect.sync(() => {
        published.push(event);
      }),
    ),
  );
  yield* Effect.yieldNow;
  return { engine, config, published };
});

const createProjectAndThread = Effect.fn("createAttachmentDispatchTestThread")(function* (
  system: Effect.Success<ReturnType<typeof makeSystem>>,
) {
  yield* system.engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("command-project-create"),
    projectId: ProjectId.make("project-attachments"),
    title: "Attachments",
    workspaceRoot: process.cwd(),
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: NOW,
  });
  yield* system.engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("command-thread-create"),
    threadId: ThreadId.make("thread-attachments"),
    projectId: ProjectId.make("project-attachments"),
    title: "Attachment thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });
});

function finalAttachmentEntries(config: ServerConfig["Service"]): string[] {
  return NodeFS.readdirSync(config.attachmentsDir).filter(
    (entry) => entry !== ATTACHMENT_STAGING_DIRECTORY_NAME,
  );
}

function stagingEntries(config: ServerConfig["Service"]): string[] {
  const stagingRoot = NodePath.join(config.attachmentsDir, ATTACHMENT_STAGING_DIRECTORY_NAME);
  return NodeFS.existsSync(stagingRoot) ? NodeFS.readdirSync(stagingRoot) : [];
}

function expectNoAttachmentOrphans(config: ServerConfig["Service"]): void {
  expect(finalAttachmentEntries(config)).toEqual([]);
  expect(stagingEntries(config)).toEqual([]);
}

const removeFinalAttachments = Effect.fn("removeFinalAttachmentTestFiles")(function* (
  config: ServerConfig["Service"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const entry of finalAttachmentEntries(config)) {
    yield* fileSystem.remove(NodePath.join(config.attachmentsDir, entry), { force: true });
  }
});

function providerTurnPublications(
  published: ReadonlyArray<OrchestrationEvent>,
  commandId: string,
): ReadonlyArray<OrchestrationEvent> {
  return published.filter(
    (event) => event.commandId === commandId && event.type === "thread.turn-start-requested",
  );
}

const dispatchNormalized = Effect.fn("dispatchNormalizedAttachmentCommand")(function* (
  system: Effect.Success<ReturnType<typeof makeSystem>>,
  command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>,
  fileSystem?: FileSystem.FileSystem,
) {
  const normalizeEffect = normalizeDispatchCommand(command);
  const normalized = yield* fileSystem
    ? normalizeEffect.pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
    : normalizeEffect;
  return yield* system.engine.dispatch(
    normalized.command,
    normalized.attachmentStage ? { attachmentStage: normalized.attachmentStage } : undefined,
  );
});

const DefaultAttachmentDispatchEnvironment = makeTestEnvironment();
it.layer(DefaultAttachmentDispatchEnvironment.layer)("authoritative attachment dispatch", (it) => {
  it.effect("rejects validation failures before staging or provider-visible publication", () => {
    return Effect.gen(function* () {
      const system = yield* makeSystem();
      const validText = upload({
        type: "file",
        name: "valid.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("valid"),
      });
      const invalidCases = [
        upload({
          type: "file",
          name: "malformed.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("x"),
          dataUrl: "data:text/plain;base64,eA=*",
        }),
        upload({
          type: "file",
          name: "empty.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("x"),
          dataUrl: "data:text/plain;base64,",
        }),
        upload({
          type: "file",
          name: "mismatch.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("hello"),
          sizeBytes: 4,
        }),
        upload({
          type: "document",
          name: "spoofed.pdf",
          mimeType: "application/pdf",
          bytes: Buffer.from("not a pdf"),
        }),
        upload({
          type: "file",
          name: "binary.txt",
          mimeType: "text/plain",
          bytes: Uint8Array.from([0x61, 0x00, 0x62]),
        }),
        upload({
          type: "file",
          name: "utf32.txt",
          mimeType: "text/plain",
          bytes: Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]),
        }),
        upload({
          type: "file",
          name: "fake.xlsx",
          mimeType: "application/zip",
          bytes: Uint8Array.from([0x50, 0x4b, 0x05, 0x06]),
        }),
      ];

      for (const [index, invalid] of invalidCases.entries()) {
        const command = turnCommand({
          commandId: `command-invalid-${index}`,
          attachments: index === invalidCases.length - 1 ? [validText, invalid] : [invalid],
        });
        const error = yield* normalizeDispatchCommand(command).pipe(Effect.flip);
        expect(error.message).toContain(invalid.name);
        expectNoAttachmentOrphans(system.config);
        expect(providerTurnPublications(system.published, command.commandId)).toEqual([]);
      }
    });
  });

  it.effect("rejects lossy thread ids as typed staging errors without creating files", () => {
    return Effect.gen(function* () {
      const system = yield* makeSystem();
      const command = turnCommand({
        commandId: "command-lossy-thread-id",
        threadId: "notes.1",
        attachments: [
          upload({
            type: "file",
            name: "notes.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("notes"),
          }),
        ],
      });

      const error = yield* normalizeDispatchCommand(command).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(error.message).toContain(ATTACHMENT_ID_THREAD_ID_CONSTRAINT_MESSAGE);
      expectNoAttachmentOrphans(system.config);
    });
  });

  it.effect("persists a mixed valid batch in order before provider-visible publication", () => {
    return Effect.gen(function* () {
      const system = yield* makeSystem();
      yield* createProjectAndThread(system);
      const command = turnCommand({
        commandId: "command-mixed-success",
        attachments: [
          upload({
            type: "image",
            name: "image.png",
            mimeType: "image/png",
            bytes: Buffer.from("image"),
          }),
          upload({
            type: "document",
            name: "guide.pdf",
            mimeType: "application/pdf",
            bytes: Buffer.from("%PDF-1.7\n", "ascii"),
          }),
          upload({
            type: "file",
            name: "source.ts",
            mimeType: "video/mp2t",
            bytes: Buffer.from("export {};\n"),
          }),
          upload({
            type: "file",
            name: "sheet.xlsx",
            mimeType: "application/zip",
            bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x01]),
          }),
        ],
      });

      yield* dispatchNormalized(system, command);
      yield* Effect.yieldNow;

      expect(finalAttachmentEntries(system.config)).toHaveLength(4);
      expect(stagingEntries(system.config)).toEqual([]);
      expect(providerTurnPublications(system.published, command.commandId)).toHaveLength(1);
      const messageEvent = system.published.find(
        (event) => event.commandId === command.commandId && event.type === "thread.message-sent",
      );
      expect(
        messageEvent?.type === "thread.message-sent"
          ? messageEvent.payload.attachments?.map((attachment) => attachment.type)
          : null,
      ).toEqual(["image", "document", "file", "file"]);
      yield* removeFinalAttachments(system.config);
    });
  });

  it.effect("cleans a partially written staging batch and publishes nothing", () => {
    return Effect.gen(function* () {
      const system = yield* makeSystem();
      const fileSystem = yield* FileSystem.FileSystem;
      let stagedWriteCount = 0;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFile: (path, bytes, options) => {
          if (String(path).includes(ATTACHMENT_STAGING_DIRECTORY_NAME)) {
            stagedWriteCount += 1;
            if (stagedWriteCount === 2) {
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "writeFile",
                  pathOrDescriptor: String(path),
                  description: "injected staging write failure",
                }),
              );
            }
          }
          return fileSystem.writeFile(path, bytes, options);
        },
      });
      const command = turnCommand({
        commandId: "command-write-failure",
        attachments: [
          upload({
            type: "file",
            name: "first.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("first"),
          }),
          upload({
            type: "file",
            name: "second.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("second"),
          }),
        ],
      });

      const error = yield* normalizeDispatchCommand(command).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
        Effect.flip,
      );
      expect(error.message).toContain("second.txt");
      expectNoAttachmentOrphans(system.config);
      expect(providerTurnPublications(system.published, command.commandId)).toEqual([]);
    });
  });

  it.effect("rolls back staged and partially finalized files when commit rename fails", () => {
    return Effect.gen(function* () {
      const system = yield* makeSystem();
      yield* createProjectAndThread(system);
      const fileSystem = yield* FileSystem.FileSystem;
      let renameCount = 0;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) => {
          renameCount += 1;
          if (renameCount === 2) {
            return Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: `${String(from)} -> ${String(to)}`,
                description: "injected attachment commit failure",
              }),
            );
          }
          return fileSystem.rename(from, to);
        },
      });
      const command = turnCommand({
        commandId: "command-rename-failure",
        attachments: [
          upload({
            type: "file",
            name: "first.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("first"),
          }),
          upload({
            type: "file",
            name: "second.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("second"),
          }),
        ],
      });

      const error = yield* dispatchNormalized(system, command, failingFileSystem).pipe(Effect.flip);
      expect(error.message).toContain("second.txt");
      yield* Effect.yieldNow;
      expectNoAttachmentOrphans(system.config);
      expect(providerTurnPublications(system.published, command.commandId)).toEqual([]);
    });
  });
});

const ProjectionFailureCommandId = "command-projection-failure";
const ProjectionFailureEnvironment = makeTestEnvironment({
  projectionPipeline: {
    bootstrap: Effect.void,
    projectEvent: (event) =>
      event.commandId === ProjectionFailureCommandId && event.type === "thread.turn-start-requested"
        ? Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "injected projection failure",
            }),
          )
        : Effect.void,
  },
});
it.layer(ProjectionFailureEnvironment.layer)("attachment projection failure", (it) => {
  it.effect("cleans all staged files and publishes nothing when projection fails", () =>
    Effect.gen(function* () {
      const system = yield* makeSystem();
      yield* createProjectAndThread(system);
      const command = turnCommand({
        commandId: ProjectionFailureCommandId,
        attachments: [
          upload({
            type: "document",
            name: "projection.pdf",
            mimeType: "application/pdf",
            bytes: Buffer.from("%PDF-1.7\n"),
          }),
        ],
      });

      const error = yield* dispatchNormalized(system, command).pipe(Effect.flip);
      expect(error.message).toContain("injected projection failure");
      yield* Effect.yieldNow;
      expectNoAttachmentOrphans(system.config);
      expect(providerTurnPublications(system.published, command.commandId)).toEqual([]);
    }),
  );
});

const SqlFailureEnvironment = makeTestEnvironment({ injectTransactionFailure: true });
it.layer(SqlFailureEnvironment.layer)("attachment SQL transaction failure", (it) => {
  it.effect("rolls back finalized files and publishes nothing when the SQL transaction fails", () =>
    Effect.gen(function* () {
      const system = yield* makeSystem();
      yield* createProjectAndThread(system);
      const command = turnCommand({
        commandId: "command-sql-commit-failure",
        attachments: [
          upload({
            type: "file",
            name: "transaction.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("transaction"),
          }),
        ],
      });
      SqlFailureEnvironment.failNextTransaction();

      const error = yield* dispatchNormalized(system, command).pipe(Effect.flip);
      expect(error.message).toContain(
        "Failed to execute OrchestrationEngine.processEnvelope:transaction",
      );
      yield* Effect.yieldNow;
      expectNoAttachmentOrphans(system.config);
      expect(providerTurnPublications(system.published, command.commandId)).toEqual([]);
    }),
  );
});

const RemainingAttachmentDispatchEnvironment = makeTestEnvironment();
it.layer(RemainingAttachmentDispatchEnvironment.layer)(
  "attachment retry and startup sweep",
  (it) => {
    it.effect("aborts newly staged files when an accepted commandId is retried", () => {
      return Effect.gen(function* () {
        const system = yield* makeSystem();
        yield* createProjectAndThread(system);
        const command = turnCommand({
          commandId: "command-duplicate-retry",
          messageId: "message-duplicate-retry",
          attachments: [
            upload({
              type: "file",
              name: "retry.txt",
              mimeType: "text/plain",
              bytes: Buffer.from("retry"),
            }),
          ],
        });

        const firstResult = yield* dispatchNormalized(system, command);
        const firstFiles = finalAttachmentEntries(system.config);
        expect(firstFiles).toHaveLength(1);

        const retryResult = yield* dispatchNormalized(system, command);
        yield* Effect.yieldNow;

        expect(retryResult).toEqual(firstResult);
        expect(finalAttachmentEntries(system.config)).toEqual(firstFiles);
        expect(stagingEntries(system.config)).toEqual([]);
        expect(providerTurnPublications(system.published, command.commandId)).toHaveLength(1);
        yield* removeFinalAttachments(system.config);
      });
    });

    it.effect(
      "startup sweep removes unaccepted finalized files and preserves accepted ones",
      () => {
        return Effect.gen(function* () {
          const system = yield* makeSystem();
          const orphanCommand = turnCommand({
            commandId: "command-sweep-orphan",
            attachments: [
              upload({
                type: "file",
                name: "orphan.txt",
                mimeType: "text/plain",
                bytes: Buffer.from("orphan"),
              }),
            ],
          });
          const orphan = yield* normalizeDispatchCommand(orphanCommand);
          expect(orphan.attachmentStage).toBeDefined();
          yield* orphan.attachmentStage?.claim ?? Effect.void;
          yield* orphan.attachmentStage?.commit ?? Effect.void;
          expect(finalAttachmentEntries(system.config)).toHaveLength(1);
          expect(stagingEntries(system.config)).toHaveLength(1);

          yield* sweepAttachmentStaging({
            attachmentsDir: system.config.attachmentsDir,
            getReceiptStatus: () => Effect.succeed(Option.none()),
          });
          expectNoAttachmentOrphans(system.config);

          const acceptedCommand = turnCommand({
            commandId: "command-sweep-accepted",
            attachments: [
              upload({
                type: "file",
                name: "accepted.txt",
                mimeType: "text/plain",
                bytes: Buffer.from("accepted"),
              }),
            ],
          });
          const accepted = yield* normalizeDispatchCommand(acceptedCommand);
          yield* accepted.attachmentStage?.claim ?? Effect.void;
          yield* accepted.attachmentStage?.commit ?? Effect.void;

          yield* sweepAttachmentStaging({
            attachmentsDir: system.config.attachmentsDir,
            getReceiptStatus: () => Effect.succeed(Option.some("accepted" as const)),
          });
          expect(finalAttachmentEntries(system.config)).toHaveLength(1);
          expect(stagingEntries(system.config)).toEqual([]);
          expect(system.published).toEqual([]);
        });
      },
    );
  },
);
