// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ClaudeExecutableFileCheck } from "../../provider/Drivers/ClaudeExecutable.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  CLAUDE_DEFAULT_INSTANCE_ID,
  makeClaudeAdapterV2,
  type ClaudeAgentSdkQueryOptions,
} from "./ClaudeAdapterV2.ts";

const defaultSettings = Schema.decodeSync(ClaudeSettings)({});

const makeFixture = Effect.fnUntraced(function* (input: {
  readonly entry: "exe" | "js" | "missing";
  readonly explicitPath?: boolean;
  readonly missingCommand?: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-executable-" });
  const shim = path.join(directory, "claude.cmd");
  const entry = path.join(
    directory,
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    ...(input.entry === "js" ? ["cli.js"] : ["bin", "claude.exe"]),
  );
  yield* fileSystem.writeFileString(shim, "@echo off\r\n");
  if (input.entry !== "missing") {
    yield* fileSystem.makeDirectory(path.dirname(entry), { recursive: true });
    yield* fileSystem.writeFileString(entry, "fixture executable");
  }
  const environment = { PATH: directory, PATHEXT: ".EXE;.CMD" };
  const binaryPath = input.explicitPath
    ? entry
    : input.missingCommand
      ? "claude-not-installed"
      : defaultSettings.binaryPath;
  const opened: Array<ClaudeAgentSdkQueryOptions> = [];
  const adapter = makeClaudeAdapterV2({
    instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
    settings: { ...defaultSettings, binaryPath },
    environment,
    attachmentsDir: directory,
    fileSystem,
    path,
    idAllocator: yield* IdAllocatorV2,
    queryRunner: {
      allocateSessionId: Effect.succeed("native-executable-test"),
      open: (query) =>
        Effect.sync(() => {
          opened.push(query.options);
          return {
            messages: Stream.never,
            offer: () => Effect.void,
            setModel: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          };
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const modelSelection = {
    instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
    model: "claude-sonnet-4-6",
    options: [],
  };
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: directory,
  });
  const threadId = ThreadId.make("thread-executable-test");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-executable-test"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  let resolutionCount = 0;
  const start = runtime
    .startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-executable-test"),
        title: "Executable test",
        providerInstanceId: CLAUDE_DEFAULT_INSTANCE_ID,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
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
      threadId,
      runId: RunId.make("run-executable-test"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("attempt-executable-test"),
      rootNodeId: NodeId.make("node-executable-test"),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("message-executable-test"),
        text: "hello",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    })
    .pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(ClaudeExecutableFileCheck, (filePath) => {
        try {
          return NodeFS.statSync(filePath.replaceAll("\\", NodePath.sep)).isFile();
        } catch {
          return false;
        }
      }),
    );
  // Exercise real PATH/PATHEXT lookup on Windows; simulate only that lookup
  // on other hosts so the adapter regressions remain portable.
  const resolveExecutable = yield* SpawnExecutableResolution;
  const result = yield* start.pipe(
    Effect.provideService(SpawnExecutableResolution, (command, platform, env) => {
      resolutionCount += 1;
      assert.equal(env.PATH, directory);
      assert.equal(platform, "win32");
      if (hostPlatform === "win32") return resolveExecutable(command, platform, env);
      return input.missingCommand ? undefined : input.explicitPath ? entry : shim;
    }),
    Effect.result,
  );
  return { result, opened, binaryPath, shim, entry, resolutionCount };
});

describe("fork(claude-executable) V2 turn startup", () => {
  it.effect("resolves default claude on Windows npm shim PATH to bin/claude.exe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ entry: "exe" });
        assert.equal(defaultSettings.binaryPath, "claude");
        assert.equal(fixture.result._tag, "Success");
        assert.equal(
          fixture.opened[0]?.pathToClaudeCodeExecutable,
          NodePath.win32.normalize(fixture.entry),
        );
        assert.equal(fixture.resolutionCount, 1);
      }),
    ).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
  );

  it.effect("passes an explicit exe path through to the SDK", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ entry: "exe", explicitPath: true });
        assert.equal(fixture.result._tag, "Success");
        assert.equal(fixture.opened[0]?.pathToClaudeCodeExecutable, fixture.entry);
      }),
    ).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
  );

  it.effect("resolves older npm packages to cli.js", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ entry: "js" });
        assert.equal(fixture.result._tag, "Success");
        assert.equal(
          fixture.opened[0]?.pathToClaudeCodeExecutable,
          NodePath.win32.normalize(fixture.entry),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
  );

  it.effect("fails an unresolved name with the setting and attempted path visible to clients", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ entry: "missing", missingCommand: true });
        assert.equal(fixture.result._tag, "Failure");
        if (fixture.result._tag !== "Failure") return;
        assert.equal(fixture.result.failure._tag, "ProviderAdapterTurnStartError");
        const failure = makeProviderFailure({ cause: Cause.fail(fixture.result.failure) });
        assert.include(failure.message, 'binaryPath setting "claude-not-installed"');
        assert.include(failure.message, 'Tried "claude-not-installed"');
        assert.include(failure.message, "PATH");
        assert.lengthOf(fixture.opened, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
  );

  it.effect("reports the resolved shim path when its npm package entry is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ entry: "missing" });
        assert.equal(fixture.result._tag, "Failure");
        if (fixture.result._tag !== "Failure") return;
        const failure = makeProviderFailure({ cause: fixture.result.failure });
        assert.include(failure.message, 'binaryPath setting "claude"');
        assert.include(failure.message.toLowerCase(), fixture.shim.toLowerCase());
        assert.lengthOf(fixture.opened, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
  );
});
