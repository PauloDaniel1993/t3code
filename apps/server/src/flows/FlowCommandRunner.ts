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
import { defaultShellResolver, resolveShellCandidates } from "../terminal/Manager.ts";

export class FlowCommandError extends Schema.TaggedError<FlowCommandError>()("FlowCommandError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Could not run the flow command.";
  }
}

export class FlowCommandShell extends Context.Reference<string | undefined>(
  "t3/flows/CommandShell",
  { defaultValue: () => undefined },
) {}

export class FlowCommandRunner extends Context.Service<
  FlowCommandRunner,
  {
    readonly run: (input: {
      readonly command: string;
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
  const selectedShell = yield* FlowCommandShell;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return FlowCommandRunner.of({
    run: Effect.fn("FlowCommandRunner.run")(function* (input) {
      const root = yield* fs
        .realPath(input.workspace)
        .pipe(Effect.mapError((cause) => new FlowCommandError({ cause })));
      if (input.cwd && (path.isAbsolute(input.cwd) || /^[a-z]:/i.test(input.cwd)))
        return yield* new FlowCommandError({ cause: "Absolute cwd" });
      const cwd = yield* fs
        .realPath(path.resolve(root, input.cwd ?? "."))
        .pipe(Effect.mapError((cause) => new FlowCommandError({ cause })));
      const relative = path.relative(root, cwd);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return yield* new FlowCommandError({ cause: "cwd escapes workspace" });
      let shell = "bash";
      if (platform === "win32") {
        const candidates = resolveShellCandidates(
          () => selectedShell ?? defaultShellResolver(platform, environment),
          platform,
          environment,
        );
        let resolved: string | null = null;
        for (const candidate of candidates) {
          resolved = yield* resolveCommandPath(candidate.shell, { env: environment }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HostProcess.Platform, platform),
          );
          if (resolved) break;
        }
        if (!resolved) return yield* new FlowCommandError({ cause: "No shell available" });
        shell = resolved;
      }
      const args =
        platform !== "win32"
          ? ["-lc", input.command]
          : /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)
            ? ["/d", "/s", "/c", input.command]
            : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command];
      let tail = "";
      let stdout = "";
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
          timeout: input.timeoutMs ?? 600_000,
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
          maxOutputBytes: 16_384,
          onStdoutChunk: (chunk) => {
            const text = outDecoder.decode(chunk, { stream: true });
            append(text);
            if (stdout.split(/\r?\n/).length <= 200) stdout = (stdout + text).slice(0, 200 * 4096);
          },
          onStderrChunk: (chunk) => append(errDecoder.decode(chunk, { stream: true })),
        })
        .pipe(Effect.mapError((cause) => new FlowCommandError({ cause })));
      append(outDecoder.decode());
      append(errDecoder.decode());
      return {
        exitCode: result.code,
        timedOut: result.timedOut,
        ...capFlowCommandOutput(tail, stdout),
      };
    }),
  });
});

export const layer = Layer.effect(FlowCommandRunner, make);
