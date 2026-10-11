import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as IdAllocator from "../IdAllocator.ts";
import type * as ProviderAdapter from "../ProviderAdapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import {
  cursorWorkspaceTurnEvents,
  cursorWorkspaceTurnInput,
  makeCursorWorkspaceFixture,
} from "./CursorWorkspaceFolders.testkit.ts";

const liveLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  CursorAgentSdk.cursorAgentSdkRunnerLiveLayer.pipe(
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  ),
);
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));

// This bypasses admission only to collect the evidence needed before Cursor
// can be declared supported. All files and server state are temporary.
describe.runIf(process.env.T3_CURSOR_LIVE_WORKSPACE_FOLDERS === "1")(
  "Cursor workspace folders live access",
  () => {
    it.live(
      "reads and edits extra folders after start, resume and portable fork",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fixture = yield* makeCursorWorkspaceFixture(
            yield* CursorAgentSdk.CursorAgentSdkRunner,
          );
          const { adapter, runtimePolicy, modelSelection } = fixture;
          const files = fixture.additionalDirectories.map((directory) =>
            path.join(directory, "probe.txt"),
          );
          const original = NodeCrypto.randomUUID();
          yield* Effect.forEach(files, (file) => fileSystem.writeFileString(file, original));
          const threadId = ThreadId.make("cursor-live-workspace-source");
          const exercise = Effect.fnUntraced(function* (
            runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
            providerThread: ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"],
            ordinal: number,
            phase: string,
            expected: string,
          ) {
            yield* runtime.startTurn(
              yield* cursorWorkspaceTurnInput({
                providerThread,
                runtimePolicy,
                modelSelection,
                ordinal,
                text: `Read both files ${files.map((file) => quote(file)).join(" and ")}. Append exactly ${quote(`\n${phase}`)} to each file, preserving its current contents. Reply with the original first line you read from each file. Do not edit other files.`,
              }),
            );
            const events = yield* cursorWorkspaceTurnEvents(runtime);
            const terminal = events.find((event) => event.type === "turn.terminal");
            assert.equal(terminal?.status, "completed");
            const reply = events
              .flatMap((event) =>
                event.type === "message.updated" && event.message.role === "assistant"
                  ? [event.message.text]
                  : [],
              )
              .join("\n");
            assert.include(reply, original);
            for (const file of files)
              assert.equal(yield* fileSystem.readFileString(file), expected);
            assert.deepEqual(
              runtime.providerSession.additionalDirectories,
              fixture.additionalDirectories,
            );
          });
          const source = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* adapter.openSession({
                threadId,
                modelSelection,
                runtimePolicy,
                providerSessionId: ProviderSessionId.make("cursor-live-workspace-start"),
              });
              const providerThread = yield* runtime.ensureThread({
                threadId,
                modelSelection,
                runtimePolicy,
              });
              yield* exercise(runtime, providerThread, 1, "start", `${original}\nstart`);
              return providerThread;
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* adapter.openSession({
                threadId,
                modelSelection,
                runtimePolicy,
                providerSessionId: ProviderSessionId.make("cursor-live-workspace-resume"),
              });
              const providerThread = yield* runtime.resumeThread({ providerThread: source });
              yield* exercise(runtime, providerThread, 2, "resume", `${original}\nstart\nresume`);
            }),
          );
          const forkId = ThreadId.make("cursor-live-workspace-fork");
          const fork = yield* adapter.openSession({
            threadId: forkId,
            modelSelection,
            runtimePolicy,
            providerSessionId: ProviderSessionId.make("cursor-live-workspace-fork"),
          });
          // Cursor uses a new agent plus portable context for forks.
          const forkThread = yield* fork.ensureThread({
            threadId: forkId,
            modelSelection,
            runtimePolicy,
          });
          assert.notEqual(forkThread.nativeThreadRef?.nativeId, source.nativeThreadRef?.nativeId);
          yield* exercise(fork, forkThread, 1, "fork", `${original}\nstart\nresume\nfork`);
        }).pipe(Effect.scoped, Effect.provide(liveLayer)),
      360_000,
    );
  },
);
