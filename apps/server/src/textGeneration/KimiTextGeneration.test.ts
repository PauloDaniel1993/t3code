import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeKimiTestHarness } from "../provider/acp/KimiTestHarness.ts";
import { makeKimiTextGeneration } from "./KimiTextGeneration.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const selection = {
  instanceId: ProviderInstanceId.make("kimi"),
  model: "kimi-saved",
  options: [
    { id: "mode", value: "yolo" },
    { id: "llm", value: "kimi-live" },
    { id: "_t3/session-mode", value: "auto" },
  ],
};
const makeHelper = Effect.fn("KimiTextTest.makeHelper")(function* (
  environment: NodeJS.ProcessEnv = {},
) {
  const h = yield* makeKimiTestHarness({
    T3_KIMI_OUTPUT:
      '{"title":"Fix Kimi","subject":"Fix Kimi.","body":" Keep Kimi sessions. ","branch":"Fix Kimi"}',
    ...environment,
  });
  const textGeneration = yield* makeKimiTextGeneration({
    makeRuntime: (cwd) =>
      h.makeRuntime({
        cwd,
        supervisionGuidance: false,
        clientInfo: { name: "kimi-text-test", version: "0.0.0" },
        mcpServers: [],
        acpMcpServers: [],
        clientCapabilities: { terminal: false, fs: { readTextFile: false, writeTextFile: false } },
      }),
  });
  return { ...h, textGeneration, common: { cwd: h.root, modelSelection: selection } };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("Kimi auxiliary generation", (it) => {
  it.effect("generates all helper types in fresh read-only workspaces", () =>
    Effect.gen(function* () {
      const h = yield* makeHelper();
      expect(
        yield* h.textGeneration.generateCommitMessage({
          ...h.common,
          branch: "main",
          stagedSummary: "M kimi.ts",
          stagedPatch: "+Kimi",
        }),
      ).toEqual({ subject: "Fix Kimi", body: "Keep Kimi sessions." });
      expect(
        yield* h.textGeneration.generatePrContent({
          ...h.common,
          baseBranch: "main",
          headBranch: "feature/kimi",
          commitSummary: "Fix Kimi",
          diffSummary: "M kimi.ts",
          diffPatch: "+Kimi",
        }),
      ).toEqual({ title: "Fix Kimi", body: "Keep Kimi sessions." });
      expect(
        yield* h.textGeneration.generateBranchName({ ...h.common, message: "Fix Kimi" }),
      ).toEqual({ branch: "fix-kimi" });
      expect(
        yield* h.textGeneration.generateThreadTitle({ ...h.common, message: "Fix Kimi" }),
      ).toEqual({ title: "Fix Kimi" });
      const requests = yield* h.requests;
      const setups = requests.filter((request) => request.method === "session/new");
      expect(new Set(setups.map((request) => request.params.cwd)).size).toBe(4);
      const fs = yield* FileSystem.FileSystem;
      for (const setup of setups) {
        expect(setup.params.cwd).not.toBe(h.root);
        expect(yield* fs.exists(String(setup.params.cwd))).toBe(false);
        expect(setup.params.mcpServers).toEqual([]);
      }
      expect(
        requests
          .filter((request) => request.method === "session/prompt")
          .map((request) => request.params.modeAtPrompt),
      ).toEqual(["plan", "plan", "plan", "plan"]);
      expect(
        requests
          .filter((request) => request.method === "session/prompt")
          .map((request) => request.params.modelAtPrompt),
      ).toEqual(Array(4).fill("kimi-saved"));
      expect(
        requests
          .filter((request) => request.method === "session/prompt")
          .every(
            (request) => !encodeJson(request.params.prompt).includes("t3-subagent-supervision"),
          ),
      ).toBe(true);
      expect((yield* fs.readDirectory(h.root)).sort()).toEqual(["kimi-home", "requests.jsonl"]);
      expect(
        yield* fs.exists((yield* Path.Path).join(h.home, "sessions", "mock-kimi-session")),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  for (const environment of [
    { T3_KIMI_PERMISSION: "1" },
    { T3_KIMI_QUESTION: "1" },
    { T3_KIMI_NO_MODE: "1" },
    { T3_KIMI_OUTPUT: "not JSON" },
    { T3_KIMI_OUTPUT: "" },
    { T3_KIMI_OUTPUT_SIZE: "128001" },
    { T3_KIMI_WRITE_FILE: "1" },
    { T3_KIMI_TOOL_UPDATE: "1" },
  ]) {
    it.effect(
      `rejects unsupported helper behavior ${Object.keys(environment).join(",")}:${Object.values(environment).join(",")}`,
      () =>
        Effect.gen(function* () {
          const h = yield* makeHelper(environment);
          const error = yield* h.textGeneration
            .generateThreadTitle({ ...h.common, message: "Fix Kimi" })
            .pipe(Effect.flip);
          expect(error._tag).toBe("TextGenerationError");
          if (environment.T3_KIMI_OUTPUT_SIZE) expect(error.detail).toContain("output limit");
          if (environment.T3_KIMI_WRITE_FILE) expect(error.detail).toContain("wrote files");
          if (environment.T3_KIMI_TOOL_UPDATE) expect(error.detail).toContain("tool work");
          if (environment.T3_KIMI_NO_MODE)
            expect((yield* h.requests).some((request) => request.method === "session/prompt")).toBe(
              false,
            );
        }).pipe(Effect.scoped),
    );
  }
});
