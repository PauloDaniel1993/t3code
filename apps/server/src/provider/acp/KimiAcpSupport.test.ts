// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  applyKimiAcpModelSelection,
  buildKimiAcpSpawnInput,
  isKimiAuthenticationRequired,
  probeKimiAcpAuthentication,
} from "./KimiAcpSupport.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeEnvironmentLog = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      home: Schema.String,
      noAutoUpdate: Schema.String,
    }),
  ),
);

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "kimi-k2.5",
    options: [
      { value: "kimi-k2.5", name: "Kimi K2.5" },
      { value: "kimi-k2-thinking", name: "Kimi K2 Thinking" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
      { value: "yolo", name: "YOLO" },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("buildKimiAcpSpawnInput", () => {
  it("launches the configured executable with only the documented acp argument", () => {
    expect(
      buildKimiAcpSpawnInput({ binaryPath: "/usr/local/bin/kimi" }, "/workspace", {
        KIMI_CODE_HOME: "/accounts/work",
        KIMI_CODE_NO_AUTO_UPDATE: "1",
      }),
    ).toEqual({
      command: "/usr/local/bin/kimi",
      args: ["acp"],
      cwd: "/workspace",
      env: {
        KIMI_CODE_HOME: "/accounts/work",
        KIMI_CODE_NO_AUTO_UPDATE: "1",
      },
    });
  });
});

describe("Kimi ACP authentication", () => {
  it("recognizes only the ACP authentication-required code", () => {
    expect(isKimiAuthenticationRequired(EffectAcpErrors.AcpRequestError.authRequired())).toBe(true);
    expect(
      isKimiAuthenticationRequired(EffectAcpErrors.AcpRequestError.internalError("failed")),
    ).toBe(false);
  });
});

it.layer(NodeServices.layer)("probeKimiAcpAuthentication", (it) => {
  it.effect("initializes and authenticates without creating a native session", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-probe-")),
      );
      const hostPlatform = yield* HostProcessPlatform;
      const requestLogPath = NodePath.join(tempDir, "requests.jsonl");
      const environmentLogPath = NodePath.join(tempDir, "environment.json");
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const homePath = NodePath.join(tempDir, "kimi-home");
      const loader = [
        `const fs = require("node:fs");`,
        `fs.writeFileSync(${encodeUnknownJson(environmentLogPath)}, JSON.stringify({ home: process.env.KIMI_CODE_HOME, noAutoUpdate: process.env.KIMI_CODE_NO_AUTO_UPDATE }));`,
        `import(${encodeUnknownJson(NodeURL.pathToFileURL(mockAgentPath).href)});`,
        "",
      ].join("\n");
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(tempDir, "acp"), loader, "utf8"));

      const result = yield* probeKimiAcpAuthentication(
        { binaryPath: process.execPath },
        {
          ...process.env,
          KIMI_CODE_HOME: homePath,
          KIMI_CODE_NO_AUTO_UPDATE: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        },
        tempDir,
      );

      expect(result.initializeResult.protocolVersion).toBe(1);
      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      expect(requestLog).toContain('"method":"initialize"');
      expect(requestLog).toContain('"method":"authenticate"');
      expect(requestLog).toContain('"methodId":"login"');
      expect(requestLog).not.toContain('"method":"session/new"');
      expect(requestLog).not.toContain('"method":"session/prompt"');
      expect(
        decodeEnvironmentLog(
          yield* Effect.promise(() => NodeFSP.readFile(environmentLogPath, "utf8")),
        ),
      ).toEqual({ home: homePath, noAutoUpdate: "1" });

      if (hostPlatform !== "win32") {
        const exitLog = yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, "utf8"));
        expect(exitLog).toMatch(/SIGTERM|exit:/);
      }
    }),
  );
});

describe("applyKimiAcpModelSelection", () => {
  const makeRuntime = () => {
    const calls: Array<readonly [string, string | boolean]> = [];
    return {
      calls,
      runtime: {
        getConfigOptions: Effect.succeed(configOptions),
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push([id, value]);
            return {};
          }),
      },
    };
  };

  it.effect("treats kimi-default as no model override and applies concrete options", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeRuntime();
      yield* applyKimiAcpModelSelection({
        runtime,
        model: "kimi-default",
        selections: [{ id: "thinking", value: "high" }],
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([["thinking", "high"]]);
    }),
  );

  it.effect("applies a provider-reported model before other options", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeRuntime();
      yield* applyKimiAcpModelSelection({
        runtime,
        model: "kimi-k2-thinking",
        selections: [{ id: "thinking", value: "high" }],
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([
        ["model", "kimi-k2-thinking"],
        ["thinking", "high"],
      ]);
    }),
  );

  it.effect("ignores a mode selection so model options cannot relax approvals", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeRuntime();
      yield* applyKimiAcpModelSelection({
        runtime,
        model: "kimi-default",
        selections: [
          { id: "mode", value: "yolo" },
          { id: "thinking", value: "high" },
        ],
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([["thinking", "high"]]);
    }),
  );

  it.effect("rejects unavailable concrete selections without fallback", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeRuntime();
      const error = yield* Effect.flip(
        applyKimiAcpModelSelection({
          runtime,
          model: "unavailable-model",
          selections: [],
          mapError: ({ cause }) => cause,
        }),
      );
      expect(error._tag).toBe("AcpRequestError");
      expect(calls).toEqual([]);
    }),
  );
});
