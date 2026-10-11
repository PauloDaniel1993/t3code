import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  makeClaudeWorkspaceFolderHarness,
  workspaceFolderModelSelection,
} from "./ClaudeWorkspaceFolders.testkit.ts";

const platformLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const liveLayer = Layer.merge(
  platformLayer,
  ClaudeAdapterV2.claudeAgentSdkQueryRunnerLiveLayer.pipe(Layer.provide(platformLayer)),
);

// Explicit config selection keeps opt-in runs away from the default Team account.
describe.runIf(process.env.T3_CLAUDE_LIVE_WORKSPACE_FOLDERS === "1")(
  "Claude Personal workspace folders (live)",
  () => {
    it.effect(
      "discovers and edits changing extra folders after start, process resume and native fork",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const configDir = process.env.CLAUDE_CONFIG_DIR;
            assert.isDefined(
              configDir,
              "Set CLAUDE_CONFIG_DIR to the Claude Personal instance's home.",
            );
            assert.isNotEmpty(configDir!);
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const directory = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3-claude-live-folders-",
            });
            const cwd = path.join(directory, "primary worktree");
            const secondary = path.join(directory, "secondary worktree");
            yield* fileSystem.makeDirectory(cwd);
            yield* fileSystem.makeDirectory(secondary);
            const scope = ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "auto-accept-edits",
              interactionMode: "default",
              cwd,
              additionalDirectories: [secondary],
            });
            const harness = yield* makeClaudeWorkspaceFolderHarness({
              runtimePolicy: scope,
              queryRunner: yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
              environment: process.env,
              settings: decodeClaudeSettings({
                homePath: configDir,
                binaryPath: process.env.T3_CLAUDE_LIVE_BINARY ?? "claude",
              }),
              modelSelection: {
                ...workspaceFolderModelSelection,
                model: process.env.T3_CLAUDE_LIVE_MODEL ?? "claude-sonnet-4-6",
              },
            });
            const prove = Effect.fnUntraced(function* (
              stage: "start" | "resume" | "fork",
              ordinal: number,
              providerThread = harness.providerThread,
              threadId = harness.threadId,
              runtimePolicy = scope,
            ) {
              const file = path.join(runtimePolicy.additionalDirectories[0]!, "proof.txt");
              const fixtureValue = NodeCrypto.randomUUID();
              const marker = `CLAUDE_WORKSPACE_${stage.toUpperCase()}_OK`;
              yield* fileSystem.writeFileString(
                file,
                `fixture-value=${fixtureValue}\nstage=pending\n`,
              );
              yield* harness.startTurn({
                ordinal,
                providerThread,
                threadId,
                runtimePolicy,
                text: `I created a disposable proof.txt fixture in the extra folder listed in the <workspace_folders> block of your current system instructions. Use that current inventory to locate it. Use Read to inspect it, then Edit to replace stage=pending with stage=${marker}, preserving the fixture-value line. Report the fixture-value from the file so the test can verify the read. It is randomly generated test data. Use only Read and Edit; do no other work.`,
              });
              const terminal = yield* Queue.take(harness.terminals);
              assert.equal(
                terminal.status,
                "completed",
                `${stage}: ${terminal.status === "failed" ? terminal.failure.message : terminal.status}`,
              );
              assert.include(
                harness.messages
                  .filter((event) => event.message.role === "assistant")
                  .map((event) => event.message.text)
                  .join("\n"),
                fixtureValue,
                `${stage} must read the unpredictable fixture value`,
              );
              assert.equal(
                yield* fileSystem.readFileString(file),
                `fixture-value=${fixtureValue}\nstage=${marker}\n`,
                `${stage} must edit the extra folder`,
              );
              assert.deepEqual(
                harness.runtime.providerSession.additionalDirectories,
                runtimePolicy.additionalDirectories,
              );
              return terminal;
            });
            const firstTurn = yield* prove("start", 1);
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId: firstTurn.providerTurnId,
              requestRuntimeRestart: true,
            });
            const resumedFolder = path.join(directory, "resumed worktree");
            yield* fileSystem.makeDirectory(resumedFolder);
            const resumedScope = ProviderAdapterV2RuntimePolicy.make({
              ...scope,
              additionalDirectories: [resumedFolder],
            });
            const resumed = yield* harness.runtime.resumeThread({
              providerThread: harness.providerThread,
              runtimePolicy: resumedScope,
            });
            yield* prove("resume", 2, resumed, harness.threadId, resumedScope);
            const targetThreadId = ThreadId.make("claude-workspace-folders-live-fork");
            const forkFolder = path.join(directory, "fork worktree");
            yield* fileSystem.makeDirectory(forkFolder);
            const forkScope = ProviderAdapterV2RuntimePolicy.make({
              ...scope,
              additionalDirectories: [forkFolder],
            });
            const forked = yield* harness.runtime.forkThread({
              sourceProviderThread: resumed,
              targetThreadId,
              runtimePolicy: forkScope,
            });
            assert.notEqual(forked.nativeThreadRef?.nativeId, resumed.nativeThreadRef?.nativeId);
            yield* prove("fork", 3, forked, targetThreadId, forkScope);
          }),
        ).pipe(Effect.provide(liveLayer)),
      { timeout: 240_000 },
    );
  },
);
