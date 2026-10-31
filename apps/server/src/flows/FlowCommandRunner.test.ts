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
it.live("preserves native exit codes, quoting, UTF-8 and closed stdin in the platform shell", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-shell-" });
    const runner = yield* FlowCommandRunner.FlowCommandRunner;
    const platform = yield* HostProcess.Platform;
    const cases =
      platform === "win32"
        ? [
            { command: "& $env:ComSpec /c 'exit 5'", code: 5, lines: [] },
            {
              command: "Write-Output 'a b'; Write-Output 'a\"b'; Write-Output 'ol\u00e1'",
              code: 0,
              lines: ["a b", 'a"b', "ol\u00e1"],
            },
            { command: "throw 'failure'", code: 1, lines: [] },
            {
              command: 'node -e "process.stdout.write(process.argv[1])" "a b"',
              code: 0,
              lines: ["a b"],
            },
            {
              command: "[Console]::Out.WriteLine('EOF:' + [Console]::In.ReadToEnd())",
              code: 0,
              lines: ["EOF:"],
            },
          ]
        : [
            { command: "exit 5", code: 5, lines: [] },
            {
              command: "printf '%s\\n' 'a b' 'a\"b' 'ol\u00e1'",
              code: 0,
              lines: ["a b", 'a"b', "ol\u00e1"],
            },
            { command: "printf 'EOF:'; cat; printf '\\n'", code: 0, lines: ["EOF:"] },
          ];
    for (const row of cases) {
      const result = yield* runner.run({ workspace: root, command: row.command });
      expect(result.exitCode).toBe(row.code);
      expect(result.lines).toEqual(row.lines);
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("strips server environment and merges step values case insensitively on Windows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-env-" });
    yield* Effect.gen(function* () {
      const runner = yield* FlowCommandRunner.FlowCommandRunner;
      const result = yield* runner.run({
        workspace: root,
        env: { FLOW_VALUE: 'literal " $(hello)', Flow_Override: "new" },
        command:
          platform === "win32"
            ? "Write-Output ($env:PORT + '|' + $env:T3CODE_HOME + '|' + $env:VITE_HTTP_URL + '|' + $env:ELECTRON_RUN_AS_NODE); Write-Output $env:FLOW_VALUE; Write-Output $env:FLOW_OVERRIDE"
            : 'printf "%s|%s|%s|%s\\n" "$PORT" "$T3CODE_HOME" "$VITE_HTTP_URL" "$ELECTRON_RUN_AS_NODE"; printf "%s\\n" "$FLOW_VALUE" "$Flow_Override"',
      });
      expect(result.lines).toEqual(["|||", 'literal " $(hello)', "new"]);
    }).pipe(
      Effect.provide(
        FlowCommandRunner.layer.pipe(
          Layer.provide(
            Layer.succeed(HostProcess.Environment, {
              ...environment,
              PORT: "1234",
              T3CODE_HOME: "private",
              VITE_HTTP_URL: "private",
              ELECTRON_RUN_AS_NODE: "1",
              FLOW_OVERRIDE: "old",
            }),
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
    expect(result).toMatchObject({ kind: "command", lineCount: 1 });
    const value = "$(echo unexpected); & | literal";
    const environment = yield* runner.run({
      workspace: root,
      env: { FLOW_VALUE: value },
      command:
        platform === "win32"
          ? "[Console]::Out.WriteLine($env:FLOW_VALUE)"
          : 'printf "%s\\n" "$FLOW_VALUE"',
    });
    expect(environment.lines).toEqual([value]);
    const manyLines = yield* runner.run({
      workspace: root,
      command:
        platform === "win32"
          ? "1..250 | ForEach-Object { [Console]::Out.WriteLine($_) }"
          : "for i in $(seq 1 250); do printf '%s\\n' \"$i\"; done",
    });
    expect(manyLines.lines).toHaveLength(200);
    expect(manyLines.lines[0]).toBe("51");
    expect(manyLines.lines.at(-1)).toBe("250");
    expect(manyLines.lineCount).toBe(250);
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

it.effect("timeout retains streamed output without relying on subprocess startup speed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-flow-timeout-" });
    const fake = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          input.onStdoutChunk?.(new TextEncoder().encode("before\n"));
          return {
            stdout: "",
            stderr: "",
            code: null,
            timedOut: true,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    yield* Effect.gen(function* () {
      const runner = yield* FlowCommandRunner.FlowCommandRunner;
      const result = yield* runner.run({ workspace: root, command: "unused", timeoutMs: 2000 });
      expect(result).toMatchObject({ timedOut: true, exitCode: null, text: "before\n" });
    }).pipe(
      Effect.provide(
        FlowCommandRunner.layer.pipe(
          Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, fake)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
