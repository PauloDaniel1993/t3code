import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { capFlowCommandOutput } from "@t3tools/shared/flow";
import { resolveCommandPath } from "@t3tools/shared/shell";
import type { FlowCommandOutput } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import { createTerminalSpawnEnv } from "../terminal/Manager.ts";

export class FlowCommandError extends Schema.TaggedError<FlowCommandError>()("FlowCommandError", {
  reason: Schema.Literals(["spawn", "unsafe_cwd", "shell_unavailable"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return "Could not run the flow command.";
  }
}

export class FlowCommandRunner extends Context.Service<
  FlowCommandRunner,
  {
    readonly run: (input: {
      readonly command: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly workspace: string;
      readonly cwd?: string;
      readonly timeoutMs?: number;
    }) => Effect.Effect<typeof FlowCommandOutput.Type, FlowCommandError>;
  }
>()("t3/flows/FlowCommandRunner") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return FlowCommandRunner.of({
    run: Effect.fn("FlowCommandRunner.run")(function* (input) {
      const root = yield* fs
        .realPath(input.workspace)
        .pipe(Effect.mapError((cause) => new FlowCommandError({ reason: "spawn", cause })));
      if (input.cwd && (path.isAbsolute(input.cwd) || /^[a-z]:/i.test(input.cwd)))
        return yield* new FlowCommandError({ reason: "unsafe_cwd" });
      const cwd = yield* fs
        .realPath(path.resolve(root, input.cwd ?? "."))
        .pipe(Effect.mapError((cause) => new FlowCommandError({ reason: "spawn", cause })));
      const relative = path.relative(root, cwd);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return yield* new FlowCommandError({ reason: "unsafe_cwd" });
      let shell = environment.SHELL || "bash";
      if (platform === "win32") {
        let resolved: string | null = null;
        for (const candidate of ["pwsh", "powershell.exe"]) {
          resolved = yield* resolveCommandPath(candidate, { env: environment }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HostProcess.Platform, platform),
          );
          if (resolved) break;
        }
        if (!resolved) return yield* new FlowCommandError({ reason: "shell_unavailable" });
        shell = resolved;
      }
      const wrapper = [
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        "$global:LASTEXITCODE = $null",
        "try {",
        input.command,
        "$ok = $?",
        "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
        "if (-not $ok) { exit 1 }",
        "exit 0",
        "} catch { [Console]::Error.WriteLine($_); exit 1 }",
      ].join("\n");
      const args =
        platform === "win32"
          ? ["-NoProfile", "-NonInteractive", "-Command", wrapper]
          : ["-lc", input.command];
      const env = createTerminalSpawnEnv(
        environment,
        input.env ? { ...input.env } : undefined,
        platform,
        environment.HOME ?? environment.USERPROFILE ?? "",
      );
      let tail = "";
      const lines: string[] = [];
      let line = "";
      let nonEmpty = false;
      let lineCount = 0;
      const finishLine = () => {
        if (nonEmpty) {
          lineCount++;
          lines.push(line.replace(/\r$/, ""));
          if (lines.length > 200) lines.shift();
        }
        line = "";
        nonEmpty = false;
      };
      const stdout = (text: string) => {
        const parts = text.split("\n");
        for (const [index, part] of parts.entries()) {
          if (index > 0) finishLine();
          nonEmpty ||= part.trim().length > 0;
          if (line.length < 4096) line += part.slice(0, 4096 - line.length);
        }
      };
      const outDecoder = new TextDecoder();
      const errDecoder = new TextDecoder();
      const append = (text: string) => {
        tail = capFlowCommandOutput(tail + text, "").text;
      };
      const result = yield* runner
        .run({
          command: shell,
          args,
          cwd,
          env,
          extendEnv: false,
          stdin: "",
          timeout: input.timeoutMs ?? 600_000,
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
          maxOutputBytes: 16_384,
          onStdoutChunk: (chunk) => {
            const text = outDecoder.decode(chunk, { stream: true });
            append(text);
            stdout(text);
          },
          onStderrChunk: (chunk) => append(errDecoder.decode(chunk, { stream: true })),
        })
        .pipe(Effect.mapError((cause) => new FlowCommandError({ reason: "spawn", cause })));
      const remaining = outDecoder.decode();
      append(remaining);
      stdout(remaining);
      finishLine();
      append(errDecoder.decode());
      return {
        kind: "command",
        exitCode: result.code,
        timedOut: result.timedOut,
        ...capFlowCommandOutput(tail, lines.join("\n")),
        lineCount,
      };
    }),
  });
});

export const layer = Layer.effect(FlowCommandRunner, make);
