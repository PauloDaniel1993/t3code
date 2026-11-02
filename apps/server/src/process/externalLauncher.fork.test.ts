import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import { EDITORS } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
        Layer.succeed(HostProcess.Platform, "win32"),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\t3-editor-concurrent-test", PATHEXT: ".CMD" },
          }),
        ),
      ),
    ),
  );
});

it.effect(
  "shares discovery across simultaneous connects and serves stale results during refresh",
  () =>
    Effect.gen(function* () {
      let statCalls = 0;
      let release = Deferred.makeUnsafe<void>();
      const scanFibers = yield* Queue.unbounded<Fiber.Fiber<unknown, unknown>>();
      const env = ConfigProvider.fromEnv({
        env: { PATH: "C:\\t3-editor-shared-scan-test", PATHEXT: ".CMD" },
      });
      const config = ConfigProvider.make((path) =>
        Effect.gen(function* () {
          // Configuration is read by the scan fiber, before it fans out into probe fibers.
          if (path.length === 1 && path[0] === "PATH") {
            yield* Queue.offer(scanFibers, yield* Effect.fiber);
          }
          return yield* env.load(path);
        }),
      );
      const fileInfo = { type: "File" } as FileSystem.File.Info;
      const launcherLayer = ExternalLauncher.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({
              stat: () =>
                Effect.gen(function* () {
                  statCalls += 1;
                  yield* Deferred.await(release);
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

      return yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        const readTogether = Effect.all(
          Array.from({ length: 8 }, () => launcher.resolveAvailableEditors()),
          { concurrency: "unbounded" },
        );
        const initialReaders = yield* readTogether.pipe(Effect.forkChild);
        const initialScan = yield* Queue.take(scanFibers);
        yield* Deferred.succeed(release, undefined);
        const initialResults = yield* Fiber.join(initialReaders);
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(initialScan)));
        const first = initialResults[0];
        assert.deepEqual(
          initialResults,
          Array.from({ length: 8 }, () => EDITORS.map((editor) => editor.id)),
        );
        const singleScanCalls = statCalls;
        assert.isAbove(singleScanCalls, 0);
        assert.equal(Queue.sizeUnsafe(scanFibers), 0);

        for (const _ of [0, 1]) {
          yield* TestClock.adjust("61 seconds");
          statCalls = 0;
          release = Deferred.makeUnsafe<void>();
          const results = yield* readTogether;
          assert.deepEqual(
            results,
            Array.from({ length: 8 }, () => first),
          );
          const refresh = yield* Queue.take(scanFibers);
          yield* Deferred.succeed(release, undefined);
          assert.isTrue(Exit.isSuccess(yield* Fiber.await(refresh)));
          assert.equal(statCalls, singleScanCalls);
          assert.equal(Queue.sizeUnsafe(scanFibers), 0);
          assert.deepEqual(yield* launcher.resolveAvailableEditors(), first);
          assert.equal(statCalls, singleScanCalls);
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            launcherLayer,
            Layer.succeed(HostProcess.Platform, "win32"),
            ConfigProvider.layer(config),
            TestClock.layer(),
          ),
        ),
      );
    }),
);
