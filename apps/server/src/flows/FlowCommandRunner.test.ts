import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as FlowCommandRunner from "./FlowCommandRunner.ts";

const dependencies = Layer.merge(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);
const testLayer = FlowCommandRunner.layer.pipe(Layer.provideMerge(dependencies));
it.live("uses the selected non-interactive shell", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-shell-" });
    const platform = yield* HostProcess.Platform;
    yield* Effect.gen(function* () {
      const runner = yield* FlowCommandRunner.FlowCommandRunner;
      const result = yield* runner.run({
        workspace: root,
        command: platform === "win32" ? "echo selected & exit /b 3" : "printf 'selected\n'; exit 3",
      });
      expect(result.exitCode).toBe(3);
      expect(result.lines.map((line) => line.trim())).toEqual(["selected"]);
    }).pipe(
      Effect.provide(
        FlowCommandRunner.layer.pipe(
          Layer.provide(
            Layer.succeed(
              FlowCommandRunner.FlowCommandShell,
              platform === "win32" ? "cmd.exe" : "bash",
            ),
          ),
          Layer.provide(dependencies),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancelling a command interrupts its ProcessRunner resource", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-cancel-" });
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const fake = ProcessRunner.ProcessRunner.of({
      run: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
        ),
    });
    yield* Effect.gen(function* () {
      const runner = yield* FlowCommandRunner.FlowCommandRunner;
      const running = yield* runner
        .run({ workspace: root, command: "unused" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      yield* Deferred.await(stopped);
    }).pipe(
      Effect.provide(
        FlowCommandRunner.layer.pipe(
          Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, fake)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("captures stdout lines, stderr, nonzero exit and output tail", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-command-" });
    const runner = yield* FlowCommandRunner.FlowCommandRunner;
    const platform = yield* HostProcess.Platform;
    const command =
      platform === "win32"
        ? "[Console]::Out.WriteLine('first'); [Console]::Out.WriteLine(''); [Console]::Error.WriteLine('problem'); exit 7"
        : "printf 'first\n\n'; printf 'problem\n' >&2; exit 7";
    const result = yield* runner.run({ workspace: root, command });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.lines).toEqual(["first"]);
    expect(result.text).toContain("problem");
    const large =
      platform === "win32"
        ? "[Console]::Out.Write(('x' * 20000) + 'TAIL')"
        : "printf '%020000dTAIL' 0";
    const tail = yield* runner.run({ workspace: root, command: large });
    expect(new TextEncoder().encode(tail.text).length).toBeLessThanOrEqual(16_384);
    expect(tail.text.endsWith("TAIL")).toBe(true);
    const escape = yield* runner
      .run({ workspace: root, cwd: "..", command: "exit 0" })
      .pipe(Effect.exit);
    expect(escape._tag).toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("timeout kills the command and retains output already received", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-timeout-" });
    const runner = yield* FlowCommandRunner.FlowCommandRunner;
    const platform = yield* HostProcess.Platform;
    const result = yield* runner.run({
      workspace: root,
      command:
        platform === "win32"
          ? "[Console]::Out.WriteLine('before'); Start-Sleep -Seconds 60"
          : "printf 'before\n'; sleep 60",
      timeoutMs: 2000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.text).toContain("before");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
