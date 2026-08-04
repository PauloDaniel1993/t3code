// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { KimiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { makeKimiTextGeneration } from "./KimiTextGeneration.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("KimiTextGeneration", (it) => {
  it.effect("uses an isolated authenticated ACP session and releases the child process", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-text-generation-")),
      );
      const hostPlatform = yield* HostProcessPlatform;
      const requestLogPath = NodePath.join(tempDir, "requests.jsonl");
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(tempDir, "acp"),
          `import(${encodeUnknownJson(NodeURL.pathToFileURL(mockAgentPath).href)});\n`,
          "utf8",
        ),
      );

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeKimiTextGeneration(
            decodeKimiSettings({ enabled: true, binaryPath: process.execPath }),
            {
              ...process.env,
              T3_ACP_REQUEST_LOG_PATH: requestLogPath,
              T3_ACP_EXIT_LOG_PATH: exitLogPath,
              T3_ACP_PROMPT_RESPONSE_TEXT: '{"branch":"Kimi Subscription"}',
            },
          );
          return yield* service.generateBranchName({
            cwd: tempDir,
            message: "Add Kimi subscription",
            modelSelection: {
              instanceId: ProviderInstanceId.make("kimi"),
              model: "kimi-default",
            },
          });
        }),
      );

      expect(result).toEqual({ branch: "kimi-subscription" });
      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      expect(requestLog).toContain('"method":"initialize"');
      expect(requestLog).toContain('"method":"authenticate"');
      expect(requestLog).toContain('"methodId":"login"');
      expect(requestLog).toContain('"method":"session/new"');
      expect(requestLog).toContain('"method":"session/prompt"');
      // Windows terminates the process tree without delivering a POSIX signal
      // to the fixture; POSIX hosts can additionally assert the child finalizer.
      if (hostPlatform !== "win32") {
        const exitLog = yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, "utf8"));
        expect(exitLog).toMatch(/SIGTERM|exit:/);
      }
    }),
  );

  it.effect("maps lost CLI authentication without creating a native session", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-text-auth-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(tempDir, "acp"),
          `import(${encodeUnknownJson(NodeURL.pathToFileURL(mockAgentPath).href)});\n`,
          "utf8",
        ),
      );

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeKimiTextGeneration(
            decodeKimiSettings({ enabled: true, binaryPath: process.execPath }),
            {
              ...process.env,
              T3_ACP_FAIL_AUTHENTICATE: "1",
              T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
          );
          return yield* service
            .generateThreadTitle({
              cwd: tempDir,
              message: "Title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("kimi"),
                model: "kimi-default",
              },
            })
            .pipe(Effect.flip);
        }),
      );

      expect(error.detail).toContain("Kimi ACP request failed");
      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      expect(requestLog).toContain('"method":"authenticate"');
      expect(requestLog).not.toContain('"method":"session/new"');
    }),
  );

  it.effect("times out, interrupts, and releases isolated prompt attempts", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-text-timeout-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(tempDir, "acp"),
          `import(${encodeUnknownJson(NodeURL.pathToFileURL(mockAgentPath).href)});\n`,
          "utf8",
        ),
      );

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeKimiTextGeneration(
            decodeKimiSettings({ enabled: true, binaryPath: process.execPath }),
            {
              ...process.env,
              T3_ACP_PROMPT_DELAY_MS: "5000",
              T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
            { timeoutMs: 2000 },
          );
          return yield* service
            .generateBranchName({
              cwd: tempDir,
              message: "Timeout",
              modelSelection: {
                instanceId: ProviderInstanceId.make("kimi"),
                model: "kimi-default",
              },
            })
            .pipe(Effect.flip);
        }),
      );

      expect(error.detail).toContain("timed out");
      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      expect(requestLog.match(/"method":"session\/prompt"/g)?.length).toBe(2);
    }).pipe(TestClock.withLive),
  );
});
