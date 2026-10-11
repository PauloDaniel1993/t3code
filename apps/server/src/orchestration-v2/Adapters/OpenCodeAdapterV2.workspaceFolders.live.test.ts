import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  OpenCodeSettings,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as OpenCodeServerLedger from "../../provider/OpenCodeServerLedger.ts";
import * as OpenCodeRuntime from "../../provider/opencodeRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { randomUuidV4 } from "../RandomUuid.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import { makeOpenCodeAdapterV2 } from "./OpenCodeAdapterV2.ts";

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeSettings = Schema.decodeEffect(OpenCodeSettings);

// Run with a credentialed OpenCode 1 binary and T3_OPENCODE_LIVE_MODEL=provider/model.
// This bypasses the public eligibility guard to gather evidence; it does not
// change the provider's unverified capability.
describe.runIf(process.env.T3_OPENCODE_LIVE_WORKSPACE_FOLDERS === "1")(
  "OpenCode 1 workspace-folder access",
  () => {
    it.live(
      "reads and edits an extra folder after start, resume and native fork",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-folders-live-" });
          const primary = path.join(root, "primary");
          const extra = path.join(root, "extra folder");
          yield* fs.makeDirectory(primary);
          yield* fs.makeDirectory(extra);
          const file = path.join(extra, "access.txt");
          const initial = `OPENCODE_EXTRA_${yield* randomUuidV4}`;
          yield* fs.writeFileString(file, initial);
          const model = process.env.T3_OPENCODE_LIVE_MODEL;
          assert.isDefined(model, "Set T3_OPENCODE_LIVE_MODEL to a credentialed provider/model.");
          const modelSelection = {
            instanceId: ProviderInstanceId.make("opencode-live"),
            model: model!,
          };
          const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            cwd: primary,
            additionalDirectories: [extra],
          });
          const config = yield* ServerConfig.ServerConfig.pipe(
            Effect.provide(
              ServerConfig.layerTest(primary, { prefix: "t3-opencode-folders-config-" }),
            ),
          );
          const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
          const settings = yield* decodeSettings(
            process.env.T3_OPENCODE_LIVE_BINARY
              ? { binaryPath: process.env.T3_OPENCODE_LIVE_BINARY }
              : {},
          );
          const adapter = makeOpenCodeAdapterV2({
            instanceId: modelSelection.instanceId,
            settings,
            environment: {},
            runtime,
            idAllocator,
            serverConfig: config,
          });
          const sourceId = ThreadId.make("thread:opencode-folders-live:source");
          const targetId = ThreadId.make("thread:opencode-folders-live:fork");
          const now = yield* DateTime.now;
          const appThread = (
            id: ThreadId,
            providerThread: OrchestrationV2ProviderThread,
          ): OrchestrationV2AppThread => ({
            id,
            projectId: ProjectId.make("project:opencode-folders-live"),
            title: "OpenCode workspace folders live",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: runtimePolicy.runtimeMode,
            interactionMode: runtimePolicy.interactionMode,
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          });
          let ordinal = 0;
          const run = Effect.fnUntraced(function* (
            session: ProviderAdapterV2SessionRuntime,
            providerThread: OrchestrationV2ProviderThread,
            suffix: string,
          ) {
            ordinal += 1;
            const terminal = yield* session.events.pipe(
              Stream.filter((event) => event.type === "turn.terminal"),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            );
            const id = providerThread.appThreadId!;
            yield* session.startTurn({
              appThread: appThread(id, providerThread),
              threadId: id,
              runId: RunId.make(`run:opencode-folders-live:${ordinal}`),
              runOrdinal: ordinal,
              providerTurnOrdinal: ordinal,
              attemptId: RunAttemptId.make(`attempt:opencode-folders-live:${ordinal}`),
              rootNodeId: NodeId.make(`node:opencode-folders-live:${ordinal}`),
              providerThread,
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: MessageId.make(`message:opencode-folders-live:${ordinal}`),
                text: `Use the read tool to read ${quote(file)}. Then use edit to append ${quote(suffix)} to its exact existing contents. Preserve those contents, do not add a newline, and do not use shell commands, tasks or other files.`,
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            });
            const events = yield* Fiber.join(terminal);
            assert.equal(events[0]?.status, "completed");
          });
          const openSession = (scope: Scope.Scope, stage: string) =>
            adapter
              .openSession({
                threadId: sourceId,
                providerSessionId: ProviderSessionId.make(`session:opencode-folders-live:${stage}`),
                modelSelection,
                runtimePolicy,
              })
              .pipe(Effect.provideService(Scope.Scope, scope));
          const firstScope = yield* Scope.fork(yield* Effect.scope);
          const first = yield* openSession(firstScope, "start");
          const source = yield* first.ensureThread({
            threadId: sourceId,
            modelSelection,
            runtimePolicy,
          });
          yield* run(first, source, "_START");
          assert.equal(yield* fs.readFileString(file), `${initial}_START`);
          yield* Scope.close(firstScope, Exit.void);
          const resumed = yield* adapter.openSession({
            threadId: sourceId,
            providerSessionId: ProviderSessionId.make("session:opencode-folders-live:resume"),
            modelSelection,
            runtimePolicy,
          });
          const resumedThread = yield* resumed.resumeThread({
            providerThread: source,
            runtimePolicy,
          });
          yield* run(resumed, resumedThread, "_RESUME");
          assert.equal(yield* fs.readFileString(file), `${initial}_START_RESUME`);
          const forked = yield* resumed.forkThread({
            sourceProviderThread: resumedThread,
            targetThreadId: targetId,
            runtimePolicy,
          });
          yield* run(resumed, forked, "_FORK");
          assert.equal(yield* fs.readFileString(file), `${initial}_START_RESUME_FORK`);
        }).pipe(
          Effect.scoped,
          Effect.provide(IdAllocator.layer),
          Effect.provide(
            OpenCodeRuntime.OpenCodeRuntimeLive.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ),
          Effect.provide(NodeServices.layer),
        ),
      { timeout: 300_000 },
    );
  },
);
