import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy, type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

export const workspaceFolderModelSelection = {
  instanceId: ProviderInstanceId.make("claude-personal"),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

export const makeClaudeWorkspaceFolderHarness = Effect.fnUntraced(function* (input: {
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly queryRunner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape;
  readonly settings?: ClaudeSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly modelSelection?: ModelSelection;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-claude-folders-attachments-",
  });
  const modelSelection = input.modelSelection ?? workspaceFolderModelSelection;
  const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: modelSelection.instanceId,
    settings: input.settings ?? decodeClaudeSettings({ binaryPath: process.execPath }),
    environment: input.environment ?? {},
    attachmentsDir,
    fileSystem,
    path: yield* Path.Path,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    queryRunner: input.queryRunner,
    continuationRequests: { offer: () => Effect.void },
  });
  const threadId = ThreadId.make("claude-workspace-folders");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("claude-workspace-folders-session"),
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  });
  const terminals =
    yield* Queue.unbounded<Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>>();
  const sessions =
    yield* Queue.unbounded<Extract<ProviderAdapterV2Event, { type: "provider_session.updated" }>>();
  const messages: Array<Extract<ProviderAdapterV2Event, { type: "message.updated" }>> = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      event.type === "turn.terminal"
        ? Queue.offer(terminals, event)
        : event.type === "provider_session.updated"
          ? Queue.offer(sessions, event)
          : event.type === "message.updated"
            ? Effect.sync(() => {
                messages.push(event);
              })
            : Effect.void,
    ),
    Effect.forkScoped,
  );
  const startTurn = Effect.fnUntraced(function* (turn: {
    readonly ordinal: number;
    readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
    readonly providerThread?: OrchestrationV2ProviderThread;
    readonly threadId?: ThreadId;
    readonly text?: string;
  }) {
    const targetThreadId = turn.threadId ?? threadId;
    const targetProviderThread = turn.providerThread ?? providerThread;
    const now = yield* DateTime.now;
    yield* runtime.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: targetThreadId,
        projectId: ProjectId.make("claude-workspace-folders-project"),
        title: "Claude workspace folders",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: turn.runtimePolicy.runtimeMode,
        interactionMode: turn.runtimePolicy.interactionMode,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: targetProviderThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: targetThreadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId: targetThreadId,
      runId: RunId.make(`claude-folders-run-${turn.ordinal}`),
      runOrdinal: turn.ordinal,
      providerTurnOrdinal: turn.ordinal,
      attemptId: RunAttemptId.make(`claude-folders-attempt-${turn.ordinal}`),
      rootNodeId: NodeId.make(`claude-folders-node-${turn.ordinal}`),
      providerThread: targetProviderThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`claude-folders-message-${turn.ordinal}`),
        text: turn.text ?? "Read the other folder.",
        attachments: [],
      },
      modelSelection,
      runtimePolicy: turn.runtimePolicy,
    });
  });
  return {
    runtime,
    providerThread,
    threadId,
    attachmentsDir,
    startTurn,
    terminals,
    sessions,
    messages,
  };
});
