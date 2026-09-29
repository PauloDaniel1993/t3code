import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { makeKimiModelCatalog } from "./KimiModelCatalog.ts";
import { buildKimiModels } from "./KimiModels.ts";

const options = [
  {
    id: "llm",
    name: "Models",
    type: "select" as const,
    currentValue: "kimi-live",
    options: [{ value: "kimi-live", name: "Live model" }],
  },
  { id: "thinking", name: "Thinking", type: "boolean" as const, currentValue: true },
];

it.layer(NodeServices.layer)("Kimi catalog persistence", (it) => {
  it.effect("retains models when a resume or update omits them and restores them on restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-catalog-" });
      const input = {
        cacheDir,
        instanceId: ProviderInstanceId.make("kimi"),
        binaryPath: "kimi",
        environment: [],
        processEnvironment: {},
      };
      const first = yield* makeKimiModelCatalog(input);
      yield* first.publish(options);
      yield* first.publish([]);
      yield* first.publish([
        { id: "thinking", name: "Thinking", type: "boolean", currentValue: false },
      ]);
      const restarted = yield* makeKimiModelCatalog(input);
      expect(yield* SubscriptionRef.get(restarted.catalog)).toEqual(
        yield* SubscriptionRef.get(first.catalog),
      );
      const models = buildKimiModels([], yield* SubscriptionRef.get(restarted.catalog));
      expect(models.map((model) => model.slug)).toEqual(["kimi-default", "kimi-live"]);
      expect(models[1]?.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual([
        "thinking",
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("isolates instances, homes, executables and environment overrides", () =>
    Effect.gen(function* () {
      const cacheDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3-kimi-catalog-",
      });
      const input = {
        cacheDir,
        instanceId: ProviderInstanceId.make("kimi"),
        binaryPath: "kimi",
        environment: [],
        processEnvironment: {},
      };
      yield* (yield* makeKimiModelCatalog(input)).publish(options);
      for (const other of [
        { ...input, instanceId: ProviderInstanceId.make("kimi-two") },
        { ...input, binaryPath: "other-kimi" },
        { ...input, processEnvironment: { KIMI_CODE_HOME: "another-home" } },
        { ...input, environment: [{ name: "ACCOUNT", value: "two", sensitive: false }] },
      ]) {
        expect(yield* SubscriptionRef.get((yield* makeKimiModelCatalog(other)).catalog)).toEqual(
          [],
        );
      }
    }).pipe(Effect.scoped),
  );
  it.effect("ignores corrupt, oversized and model-free saved catalogs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-catalog-" });
      const input = {
        cacheDir,
        instanceId: ProviderInstanceId.make("kimi"),
        binaryPath: "kimi",
        environment: [],
        processEnvironment: {},
      };
      yield* (yield* makeKimiModelCatalog(input)).publish(options);
      const file = (yield* fs.readDirectory(cacheDir)).find((name) => name.endsWith(".json"));
      if (!file) return yield* Effect.die("Expected persisted discovery");
      for (const contents of ["broken", " ".repeat(1024 * 1024 + 1), "[]"]) {
        yield* fs.writeFileString(path.join(cacheDir, file), contents);
        expect(yield* SubscriptionRef.get((yield* makeKimiModelCatalog(input)).catalog)).toEqual(
          [],
        );
      }
    }).pipe(Effect.scoped),
  );
});
