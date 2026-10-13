import { CursorSettings } from "@t3tools/provider-cursor/settings";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeCursorAdapterV2 } from "@t3tools/provider-cursor/testing";
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

export const makeCursorWorkspaceFixture = Effect.fnUntraced(function* (
  runner: CursorAgentSdk.CursorAgentSdkRunner["Service"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-workspace-" });
  const cwd = path.join(directory, "primary");
  const additionalDirectories = [
    path.join(directory, "extra-one"),
    path.join(directory, "extra-two"),
  ] as const;
  yield* Effect.forEach([cwd, ...additionalDirectories], (folder) =>
    fileSystem.makeDirectory(folder),
  );
  const instanceId = ProviderInstanceId.make("cursor");
  const modelSelection = { instanceId, model: "composer-2.5" };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    cwd,
    additionalDirectories,
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  const serverConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(directory, { prefix: "cursor-workspace-config-" })),
  );
  const host = yield* ProviderHost.ProviderHost.pipe(
    Effect.provide(TestProviderHost.layer({ cwd })),
  );
  const adapter = yield* makeCursorAdapterV2({
    instanceId,
    settings: yield* decodeCursorSettings({}),
    environment: process.env,
  }).pipe(
    Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, runner),
    Effect.provideService(ProviderHost.ProviderHost, {
      ...host,
      paths: { ...host.paths, attachmentsDir: serverConfig.attachmentsDir },
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    }),
  );
  return { adapter, cwd, additionalDirectories, runtimePolicy, modelSelection };
});

export const cursorWorkspaceTurnInput = Effect.fnUntraced(function* (input: {
  readonly providerThread: ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"];
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"];
  readonly ordinal: number;
  readonly text?: string;
  readonly attachments?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
}): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2TurnInput> {
  const threadId = input.providerThread.appThreadId;
  if (threadId === null) return yield* Effect.die("Workspace fixture needs an app thread.");
  const now = yield* DateTime.now;
  const key = `${threadId}:${input.ordinal}`;
  return {
    threadId,
    providerThread: input.providerThread,
    modelSelection: input.modelSelection,
    runtimePolicy: input.runtimePolicy,
    runId: RunId.make(`run:${key}`),
    runOrdinal: input.ordinal,
    providerTurnOrdinal: input.ordinal,
    attemptId: RunAttemptId.make(`attempt:${key}`),
    rootNodeId: NodeId.make(`node:${key}`),
    appThread: {
      id: threadId,
      projectId: ProjectId.make("project:cursor-workspace"),
      createdBy: "user",
      creationSource: "web",
      title: "Cursor workspace folders",
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimePolicy.runtimeMode,
      interactionMode: input.runtimePolicy.interactionMode,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    message: {
      messageId: MessageId.make(`message:${key}`),
      createdBy: "user",
      creationSource: "web",
      text: input.text ?? "Work in the listed folders.",
      attachments: input.attachments ?? [],
    },
  };
});

export const cursorWorkspaceTurnEvents = (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
) =>
  runtime.events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
  );
