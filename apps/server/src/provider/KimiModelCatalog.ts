import * as NodeCrypto from "node:crypto";
import type { ProviderInstanceEnvironment, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as AcpSchema from "effect-acp/compat";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import {
  isKimiModeConfigOption,
  isKimiModelConfigOption,
  kimiConfigChoices,
  normalizeKimiConfigOptions,
} from "./KimiModels.ts";

const fields = {
  id: Schema.String,
  name: Schema.String,
  category: Schema.optionalKey(Schema.String),
};
const ConfigOption = Schema.Union([
  Schema.Struct({ ...fields, type: Schema.Literal("boolean"), currentValue: Schema.Boolean }),
  Schema.Struct({
    ...fields,
    type: Schema.Literal("select"),
    currentValue: Schema.String,
    options: Schema.Array(Schema.Struct({ value: Schema.String, name: Schema.String })),
  }),
]);
const codec = Schema.fromJsonString(Schema.Array(ConfigOption));
const decode = Schema.decodeUnknownEffect(codec);
const encode = Schema.encodeEffect(codec);
const encodeBinding = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const MAX_CACHE_BYTES = 1024 * 1024;

/** Cache discovery per account so delegation can select a model before the first session after restart. */
export const makeKimiModelCatalog = Effect.fn("makeKimiModelCatalog")(function* (input: {
  readonly cacheDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly environment: ProviderInstanceEnvironment;
  readonly processEnvironment: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const binding = yield* encodeBinding({
    instanceId: input.instanceId,
    binaryPath: input.binaryPath,
    home: input.processEnvironment.KIMI_CODE_HOME ?? null,
    userHome: input.processEnvironment.USERPROFILE ?? input.processEnvironment.HOME ?? null,
    environment: [...input.environment].toSorted((a, b) => a.name.localeCompare(b.name)),
  }).pipe(Effect.orDie);
  const key = NodeCrypto.createHash("sha256").update(binding).digest("hex");
  const filePath = path.join(input.cacheDir, `kimi-models-${key}.json`);
  const saved = yield* fs.stat(filePath).pipe(
    Effect.flatMap((stat) =>
      stat.size <= BigInt(MAX_CACHE_BYTES)
        ? fs.readFileString(filePath).pipe(Effect.flatMap(decode))
        : Effect.succeed([]),
    ),
    Effect.orElseSucceed(() => []),
  );
  const catalog = yield* SubscriptionRef.make<ReadonlyArray<AcpSchema.SessionConfigOption>>(
    saved.some(isKimiModelConfigOption) ? saved : [],
  );
  const lock = yield* Semaphore.make(1);
  const publish = (options: ReadonlyArray<AcpSchema.SessionConfigOption>) =>
    lock.withPermit(
      Effect.gen(function* () {
        // Missing resume options mean "not reported", never an empty catalog.
        if (!options.some(isKimiModelConfigOption)) return;
        const next = normalizeKimiConfigOptions(options)
          .filter((option) => !isKimiModeConfigOption(option))
          .toSorted(
            (a, b) => Number(isKimiModelConfigOption(b)) - Number(isKimiModelConfigOption(a)),
          )
          .slice(0, 64)
          .map((option) => ({
            id: option.id,
            name: option.name,
            ...(option.category ? { category: option.category } : {}),
            ...(option.type === "boolean"
              ? { type: "boolean" as const, currentValue: option.currentValue }
              : {
                  type: "select" as const,
                  currentValue: option.currentValue,
                  options: kimiConfigChoices(option)
                    .slice(0, 65)
                    .map(({ value, name }) => ({ value, name })),
                }),
          }));
        if (Equal.equals(yield* SubscriptionRef.get(catalog), next)) return;
        yield* SubscriptionRef.set(catalog, next);
        const contents = yield* encode(next).pipe(Effect.orDie);
        if (Buffer.byteLength(contents) > MAX_CACHE_BYTES) return;
        yield* writeFileStringAtomically({ filePath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.tapError(() => Effect.logWarning("Could not save Kimi model discovery.")),
          Effect.ignore,
        );
      }),
    );
  return { catalog, publish };
});
