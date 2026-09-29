import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { EDITORS } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";

// Fork-owned: concurrent editor discovery. Kept apart from externalLauncher.test.ts
// so upstream's test file merges without edits.

function makeMockDetachedHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it.effect("discovers editors concurrently with at most eight probes and stable ordering", () => {
  let activeChecks = 0;
  let peakActiveChecks = 0;
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              activeChecks += 1;
              peakActiveChecks = Math.max(peakActiveChecks, activeChecks);
              yield* Effect.yieldNow;
              activeChecks -= 1;
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const editors = yield* launcher.resolveAvailableEditors();
    assert.deepEqual(
      editors,
      EDITORS.map((editor) => editor.id),
    );
    assert.isAbove(peakActiveChecks, 1);
    assert.isAtMost(peakActiveChecks, 8);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\t3-editor-concurrent-test", PATHEXT: ".CMD" },
          }),
        ),
      ),
    ),
  );
});

it.effect("shares a discovery scan across simultaneous connects and expired cache misses", () => {
  let statCalls = 0;
  const fileInfo = { type: "File" } as FileSystem.File.Info;
  const launcherLayer = ExternalLauncher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Effect.gen(function* () {
              statCalls += 1;
              yield* Effect.yieldNow;
              return fileInfo;
            }),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.sync(() => makeMockDetachedHandle())),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    const first = yield* launcher.resolveAvailableEditors();
    const singleScanCalls = statCalls;
    assert.isAbove(singleScanCalls, 0);

    for (const _ of [0, 1]) {
      yield* TestClock.adjust("61 seconds");
      statCalls = 0;
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => launcher.resolveAvailableEditors()),
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        results,
        Array.from({ length: 8 }, () => first),
      );
      assert.equal(statCalls, singleScanCalls);
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        launcherLayer,
        Layer.succeed(HostProcessPlatform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\t3-editor-shared-scan-test", PATHEXT: ".CMD" },
          }),
        ),
        TestClock.layer(),
      ),
    ),
  );
});
