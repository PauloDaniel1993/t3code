import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      externalBytes: Schema.Number,
      heapBytes: Schema.Number,
      output: Schema.String,
    }),
  ),
);

it.effect.each(["payload", "stage"])(
  "%s retains an owned 64 KiB preview without its 64 MiB source allocation",
  (mode) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const result = decodeResult(
        yield* spawner.string(
          ChildProcess.make(process.execPath, [
            "--expose-gc",
            NodeURL.fileURLToPath(
              new URL("./ProviderEventFlowRetention.fixture.mjs", import.meta.url),
            ),
            mode,
          ]),
        ),
      );
      expect(result.externalBytes).toBeLessThan(1_048_576);
      expect(result.heapBytes).toBeLessThan(1_048_576);
      expect(result.output).toBe(`${"a".repeat(65_531)}…`);
    }).pipe(Effect.provide(NodeServices.layer)),
);
