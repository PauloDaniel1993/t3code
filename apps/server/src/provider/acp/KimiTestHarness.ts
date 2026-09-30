import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeKimiAcpRuntime, type KimiAcpRuntimeInput } from "./KimiAcpSupport.ts";
import { makeKimiEnvironment } from "../Drivers/KimiHome.ts";

const Request = Schema.Struct({
  method: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeRequest = Schema.decodeSync(Schema.fromJsonString(Request));

/** Redirect only fixture Kimi invocations, retaining the real ACP transport and child lifecycle. */
export const makeKimiTestHarness = Effect.fn("makeKimiTestHarness")(function* (
  fixtureEnvironment: NodeJS.ProcessEnv = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-fixture-" });
  const home = path.join(root, "kimi-home");
  const log = path.join(root, "requests.jsonl");
  const mockAgent = yield* path.fromFileUrl(
    new URL("./fixtures/kimi-mock-agent.mjs", import.meta.url),
  );
  const environment = yield* makeKimiEnvironment(
    { homePath: home },
    { ...process.env, ...fixtureEnvironment, T3_KIMI_REQUEST_LOG: log },
  );
  const childProcessSpawner = ChildProcessSpawner.make((command) => {
    if (
      command._tag === "StandardCommand" &&
      command.command === process.execPath &&
      (command.args[0] === "acp" || command.args[0] === "--version")
    ) {
      return nativeSpawner.spawn(
        ChildProcess.make(process.execPath, [mockAgent, ...command.args], command.options),
      );
    }
    return nativeSpawner.spawn(command);
  });
  const makeRuntime = (
    input: Omit<KimiAcpRuntimeInput, "kimiSettings" | "environment" | "childProcessSpawner">,
  ) =>
    makeKimiAcpRuntime({
      ...input,
      kimiSettings: { binaryPath: process.execPath },
      environment,
      childProcessSpawner,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
    );
  return {
    root,
    home,
    log,
    environment,
    childProcessSpawner,
    makeRuntime,
    requests: fs.readFileString(log).pipe(
      Effect.map((text) =>
        text
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => decodeRequest(line)),
      ),
    ),
  };
});
