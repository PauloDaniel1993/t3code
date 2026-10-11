import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
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
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: process.env.T3_CODEX_WORKSPACE_FOLDERS_MODEL ?? "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "low" }],
} satisfies ModelSelection;
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const encodePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const liveLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  CodexAdapterV2.codexAppServerClientFactoryFromSettingsLayer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  ),
);

// Opt in with T3_CODEX_WORKSPACE_FOLDERS_LIVE=1. Only auth.json is copied from
// T3_CODEX_WORKSPACE_FOLDERS_AUTH_HOME (default ~/.codex); all writes and native
// session history stay in temporary directories, with no T3 userdata involved.
describe.runIf(process.env.T3_CODEX_WORKSPACE_FOLDERS_LIVE === "1")(
  "Codex workspace folders live",
  () => {
    it.live(
      "reads and edits an extra folder after start, process restart/resume and native fork",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-folders-live-" });
          const primary = path.join(root, "primary folder");
          const extra = path.join(root, "extra folder");
          const home = path.join(root, "codex-home");
          const temp = path.join(root, "temp");
          for (const directory of [primary, extra, home, temp]) yield* fs.makeDirectory(directory);
          const authHome =
            process.env.T3_CODEX_WORKSPACE_FOLDERS_AUTH_HOME ??
            path.join(NodeOS.homedir(), ".codex");
          yield* fs.copyFile(path.join(authHome, "auth.json"), path.join(home, "auth.json"));
          yield* fs.writeFileString(
            path.join(home, "config.toml"),
            '[windows]\nsandbox = "unelevated"\n',
          );

          const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            cwd: primary,
            additionalDirectories: [extra],
            approvalPolicy: "never",
          });
          const adapter = CodexAdapterV2.makeCodexAdapterV2({
            instanceId: modelSelection.instanceId,
            settings: decodeCodexSettings({
              homePath: home,
              binaryPath: process.env.T3_CODEX_WORKSPACE_FOLDERS_BINARY ?? "",
            }),
            environment: {
              ...process.env,
              // Codex grants the default temp root too; keep that sandbox work isolated.
              TEMP: temp,
              TMP: temp,
              TMPDIR: temp,
              T3CODE_CODEX_LAUNCH_ARGS: "",
            },
            fileSystem: fs,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            serverConfig: yield* makeReplayServerConfig("workspace-folders-live"),
            clientFactory: yield* CodexAdapterV2.CodexAppServerClientFactory,
          });
          const sourceThreadId = ThreadId.make("thread:codex-workspace-live:source");
          const open = (threadId: ThreadId, scope: Scope.Scope, suffix: string) =>
            adapter
              .openSession({
                threadId,
                providerSessionId: ProviderSessionId.make(
                  `provider-session:codex-workspace-live:${suffix}`,
                ),
                modelSelection,
                runtimePolicy,
              })
              .pipe(Effect.provideService(Scope.Scope, scope));

          const edit = Effect.fn("CodexWorkspaceFoldersLive.edit")(function* (
            runtime: ProviderAdapterV2SessionRuntime,
            thread: OrchestrationV2ProviderThread,
            threadId: ThreadId,
            ordinal: number,
            phase: string,
          ) {
            const file = path.join(extra, `${phase}.txt`);
            const marker = NodeCrypto.randomUUID();
            yield* fs.writeFileString(file, `marker=${marker}\n`);
            const now = yield* DateTime.now;
            const messages: Array<string> = [];
            const terminal =
              yield* Deferred.make<Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>>();
            yield* runtime.events.pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (
                    event.type === "turn_item.updated" &&
                    event.turnItem.type === "assistant_message"
                  )
                    messages.push(event.turnItem.text);
                }),
              ),
              Stream.filter(
                (event) => event.type === "turn.terminal" && event.providerThreadId === thread.id,
              ),
              Stream.take(1),
              Stream.runForEach((event) =>
                event.type === "turn.terminal" && event.providerThreadId === thread.id
                  ? Deferred.succeed(terminal, event)
                  : Effect.void,
              ),
              Effect.forkScoped,
            );
            const input: ProviderAdapterV2TurnInput = {
              appThread: {
                createdBy: "user",
                creationSource: "web",
                id: threadId,
                projectId: ProjectId.make("project:codex-workspace-live"),
                title: "Codex workspace folders live",
                providerInstanceId: modelSelection.instanceId,
                modelSelection,
                runtimeMode: runtimePolicy.runtimeMode,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                activeProviderThreadId: thread.id,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                lastVisitedAt: null,
                deletedAt: null,
              },
              threadId,
              runId: RunId.make(`run:codex-workspace-live:${phase}`),
              runOrdinal: ordinal,
              providerTurnOrdinal: ordinal,
              attemptId: RunAttemptId.make(`attempt:codex-workspace-live:${phase}`),
              rootNodeId: NodeId.make(`node:codex-workspace-live:${phase}`),
              providerThread: thread,
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: MessageId.make(`message:codex-workspace-live:${phase}`),
                attachments: [],
                text: `Read the existing file ${encodePath(file)} in the extra workspace folder. Extract its marker value, preserve the existing line, and append exactly one line with that marker followed by :${phase}. Use a local file tool to make the edit. Do not request more permissions or change any other file. Then reply done.`,
              },
              modelSelection,
              runtimePolicy,
            };
            yield* runtime.startTurn(input);
            const result = yield* Deferred.await(terminal);
            assert.equal(result.status, "completed", encodeUnknownJson(result));
            assert.equal(
              (yield* fs.readFileString(file)).replaceAll("\r\n", "\n"),
              `marker=${marker}\n${marker}:${phase}\n`,
              messages.join("\n"),
            );
            assert.deepEqual(runtime.providerSession.additionalDirectories, [extra]);
            yield* Console.log(`Codex workspace-folder ${phase}: read/write passed`);
          });

          const initialScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(initialScope, Exit.void));
          const initial = yield* open(sourceThreadId, initialScope, "start");
          const source = yield* initial.ensureThread({
            threadId: sourceThreadId,
            modelSelection,
            runtimePolicy,
          });
          yield* edit(initial, source, sourceThreadId, 1, "start");
          yield* Scope.close(initialScope, Exit.void);

          const resumedScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(resumedScope, Exit.void));
          const resumed = yield* open(sourceThreadId, resumedScope, "resume");
          const resumedThread = yield* resumed.resumeThread({
            providerThread: source,
            threadId: sourceThreadId,
            modelSelection,
            runtimePolicy,
          });
          yield* edit(resumed, resumedThread, sourceThreadId, 2, "resume");
          const forkThreadId = ThreadId.make("thread:codex-workspace-live:fork");
          const fork = yield* resumed.forkThread({
            sourceProviderThread: resumedThread,
            targetThreadId: forkThreadId,
            modelSelection,
            runtimePolicy,
          });
          yield* edit(resumed, fork, forkThreadId, 1, "fork");
          yield* Scope.close(resumedScope, Exit.void);
        }).pipe(Effect.scoped, Effect.provide(liveLayer)),
      360_000,
    );
  },
);
