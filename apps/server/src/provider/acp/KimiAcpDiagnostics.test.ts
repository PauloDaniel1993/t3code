import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  captureKimiAcpLogCheckpoint,
  readKimiAcpFailureSince,
  parseKimiAcpFailureLine,
} from "./KimiAcpDiagnostics.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const failure =
  'acp: turn ended with failed reason error={"message":"Quota reached","code":"quota","retryable":true}\n';
it("parses nested JSON diagnostics and bounds the reported message", () => {
  expect(parseKimiAcpFailureLine(failure)).toEqual({
    message: "Quota reached",
    code: "quota",
    retryable: true,
  });
  expect(
    parseKimiAcpFailureLine(
      `acp: turn ended with failed reason error=${encodeJson(encodeJson({ message: "x".repeat(5000) }))}`,
    )?.message.length,
  ).toBe(4000);
  expect(parseKimiAcpFailureLine("unrelated")).toBeUndefined();
});
it.layer(NodeServices.layer)("Kimi log checkpoints", (it) => {
  it.effect("ignores old failures, reads appended bytes, and handles log rotation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-logs-" });
      const directory = path.join(home, "sessions", "s");
      yield* fs.makeDirectory(path.join(directory, "logs"), { recursive: true });
      const log = path.join(directory, "logs", "kimi-code.log");
      yield* fs.writeFileString(
        path.join(home, "session_index.jsonl"),
        `${encodeJson({ sessionId: "s", sessionDir: directory })}\n{broken`,
      );
      yield* fs.writeFileString(log, `unicode: ç😀\n${failure}`);
      const checkpoint = yield* captureKimiAcpLogCheckpoint({
        sessionId: "s",
        environment: { KIMI_CODE_HOME: home },
      });
      expect(yield* readKimiAcpFailureSince(checkpoint)).toBeUndefined();
      yield* fs.writeFileString(log, `unicode: ç😀\n${failure}${failure}`);
      expect((yield* readKimiAcpFailureSince(checkpoint))?.code).toBe("quota");
      yield* fs.writeFileString(log, failure);
      expect((yield* readKimiAcpFailureSince(checkpoint))?.message).toBe("Quota reached");
    }).pipe(Effect.scoped),
  );
  it.effect("rejects index entries outside the Kimi sessions directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-index-" });
      yield* fs.writeFileString(
        path.join(home, "session_index.jsonl"),
        encodeJson({ sessionId: "s", sessionDir: home }),
      );
      expect(
        yield* captureKimiAcpLogCheckpoint({
          sessionId: "s",
          environment: { KIMI_CODE_HOME: home },
        }),
      ).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
