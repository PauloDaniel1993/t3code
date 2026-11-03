import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Definitions from "./FlowDefinitions.ts";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as Settings from "../serverSettings.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Runtime from "./FlowRuntime.ts";
import { attachmentIsPendingUpload } from "../orchestration-v2/AttachmentClaims.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

it.effect(
  "finds continuations only for the current step message and tolerates a never-launched thread",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const threadId = ThreadId.make("thread");
      const shell = liveThreadShell(threadId);
      const now = DateTime.makeUnsafe("2026-10-31T00:00:00Z");
      const run = (id: string, messageId: string, parent?: string): OrchestrationV2Run => ({
        id: RunId.make(id),
        threadId,
        ordinal: 1,
        userMessageId: MessageId.make(messageId),
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: shell.modelSelection,
        providerThreadId: null,
        rootNodeId: null,
        activeAttemptId: null,
        status: "cancelled",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
        ...(parent ? { restartContinuationOfRunId: RunId.make(parent) } : {}),
      });
      const runs = [
        run("old", "old-message"),
        run("old-continuation", "old-continuation-message", "old"),
        run("current", "current-message"),
      ];
      const program = Effect.gen(function* () {
        const runtime = yield* Runtime.FlowRuntime;
        expect(yield* runtime.continuing(threadId, "current-message")).toBeNull();
        expect(yield* runtime.continuing(ThreadId.make("missing"), "message")).toBeNull();
        expect(yield* runtime.settled(ThreadId.make("missing"), "message")).toBeNull();
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count, available_at, created_at, updated_at) VALUES ('continue', 'continue', ${threadId}, 'provider-runtime.continue', '{"type":"provider-runtime.continue","sourceRunId":"current"}', 'pending', 0, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')`;
        expect(yield* runtime.continuing(threadId, "current-message")).toBe(
          "message:restart-continuation:current",
        );
        expect(
          yield* runtime.settled(threadId, "message:restart-continuation:current", true),
        ).toMatchObject({ failed: true, interrupted: true });
        runs.push(run("current-continuation", "new-message", "current"));
        expect(yield* runtime.continuing(threadId, "current-message")).toBe("new-message");
      });
      yield* program.pipe(
        Effect.provide(
          Runtime.layer.pipe(
            Layer.provide(Layer.mock(Definitions.FlowDefinitions)({})),
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-flow-runtime-" })),
            Layer.provide(Layer.mock(DocumentText.DocumentText)({})),
            Layer.provide(NodeServices.layer),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Launch.ThreadLaunchService)({}),
                Outbox.layer,
                Layer.mock(Settings.ServerSettingsService)({
                  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                }),
                Layer.mock(Projects.ProjectService)({}),
                Layer.mock(Registry.ProviderInstanceRegistry)({}),
                Layer.mock(Threads.ThreadManagementService)({
                  getThreadShell: (id) => Effect.succeed(id === threadId ? shell : null),
                  getThreadRecords: () => Effect.succeed({ ...idleThreadProjection(shell), runs }),
                }),
                Layer.mock(Sink.EventSinkV2)({
                  latestSequence: () => Effect.succeed(0),
                  stream: () => Stream.empty,
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "launches without provider defaults and sends images with stable ids and path-specific failures",
  () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("devReplay");
      const driver = ProviderDriverKind.make("devReplay");
      const snapshot = Effect.succeed({
        instanceId: id,
        driver,
        enabled: true,
        installed: true,
        version: null,
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        checkedAt: "2026-10-31T00:00:00Z",
        models: [
          {
            slug: "showcase",
            name: "Showcase",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      });
      const instance = {
        instanceId: id,
        driverKind: driver,
        displayName: undefined,
        enabled: true,
        continuationIdentity: { driverKind: driver, continuationKey: id },
        snapshot: {
          getSnapshot: snapshot,
          refresh: snapshot,
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
          resolveMaintenance: () => Effect.die("unused"),
        },
        get orchestrationAdapter(): never {
          throw new Error("unused");
        },
        get textGeneration(): never {
          throw new Error("unused");
        },
      };
      const projectId = ProjectId.make("project");
      const shell = liveThreadShell(ThreadId.make("flow"));
      const inputs: Launch.ThreadLaunchInput[] = [];
      const sent: Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0][] = [];
      const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 128]);
      yield* Effect.gen(function* () {
        const runtime = yield* Runtime.FlowRuntime;
        expect(
          yield* runtime.launch({
            projectId,
            threadId: shell.id,
            commandId: "flow",
            title: "Command-only run",
            workspace: { type: "root" },
          }),
        ).toBe("/workspace");
        expect(inputs[0]?.modelSelection).toEqual({ instanceId: id, model: "showcase" });
        const message = {
          projectId,
          threadId: shell.id,
          commandId: "image-message",
          messageId: "image-message",
          title: "Images",
          prompt: "Review",
          images: ["docs/mockup.png"],
          workspace: { type: "root" as const },
        };
        yield* runtime.launch(message);
        expect(sent[0]?.attachments).toMatchObject([
          { type: "image", name: "mockup.png", mimeType: "image/png", sizeBytes: bytes.length },
        ]);
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const stored = sent[0]!.attachments[0]!;
        expect(attachmentIsPendingUpload(stored)).toBe(false);
        const storedPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: stored,
        });
        expect([...(yield* fs.readFile(storedPath!))]).toEqual([...bytes]);
        yield* runtime.send({ ...message, commandId: "image-message:message" });
        expect(sent[1]?.attachments).toEqual(sent[0]?.attachments);
        yield* runtime.send({ ...message, commandId: "continued", messageId: "continued" });
        expect(sent[2]?.attachments[0]?.id).not.toBe(stored.id);
        const files = yield* fs.readDirectory(config.attachmentsDir, { recursive: true });
        const error = yield* runtime
          .send({ ...message, messageId: "missing", images: ["docs/mockup.png", "missing.png"] })
          .pipe(Effect.flip);
        expect(error.message).toContain('"missing.png"');
        expect(sent).toHaveLength(3);
        expect(yield* fs.readDirectory(config.attachmentsDir, { recursive: true })).toEqual(files);
      }).pipe(
        Effect.provide(
          Runtime.layer.pipe(
            Layer.provide(
              Layer.mock(Definitions.FlowDefinitions)({
                readImage: (root, path) => {
                  expect(root).toBe("/workspace");
                  return path === "missing.png"
                    ? Effect.fail(
                        new Definitions.FlowDefinitionError({
                          operation: "read image",
                          path,
                          reason: "missing",
                        }),
                      )
                    : Effect.succeed({ bytes, mimeType: "image/png" });
                },
              }),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-flow-runtime-" }),
            ),
            Layer.provide(
              Layer.mock(DocumentText.DocumentText)({ ensure: (path) => Effect.succeed(path) }),
            ),
            Layer.provideMerge(NodeServices.layer),
            Layer.provide(
              Layer.mergeAll(
                Outbox.layer,
                Layer.mock(Settings.ServerSettingsService)({
                  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                }),
                Layer.mock(Projects.ProjectService)({
                  getById: (id) =>
                    Effect.succeedSome({
                      id,
                      title: "Test",
                      workspaceRoot: "/workspace",
                      repositoryIdentity: null,
                      workspaceFile: null,
                      defaultModelSelection: null,
                      defaultThreadEnvMode: null,
                      autoPull: false,
                      faviconPath: null,
                      projectIcon: null,
                      scripts: [],
                      createdAt: "2026-10-31T00:00:00Z",
                      updatedAt: "2026-10-31T00:00:00Z",
                      deletedAt: null,
                    }),
                }),
                Layer.mock(Registry.ProviderInstanceRegistry)({
                  listInstances: Effect.succeed([instance]),
                }),
                Layer.mock(Launch.ThreadLaunchService)({
                  launch: (input) => {
                    inputs.push(input);
                    return Effect.succeed({
                      projection: idleThreadProjection(shell),
                      threadId: shell.id,
                      projectId,
                      resumed: false,
                      workspacePath: "/workspace",
                    });
                  },
                }),
                Layer.mock(Threads.ThreadManagementService)({
                  getThreadRecords: () =>
                    Effect.succeed({
                      ...idleThreadProjection(shell),
                      messages: sent.map((input) => ({ id: input.messageId })),
                    } as never),
                  sendToThread: (input) =>
                    Effect.sync(() => {
                      sent.push(input);
                      return { message: { attachments: input.attachments } } as never;
                    }),
                }),
                Layer.mock(Sink.EventSinkV2)({
                  latestSequence: () => Effect.succeed(0),
                  stream: () => Stream.empty,
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);
