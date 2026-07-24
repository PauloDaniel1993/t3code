import {
  KIMI_DEFAULT_MODEL,
  KIMI_DEFAULT_MODEL_NAME,
  type ModelCapabilities,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  providerModelsFromSettings,
} from "./providerSnapshot.ts";

export const KIMI_DEFAULT_MODEL_ID = KIMI_DEFAULT_MODEL;

export interface KimiConfigOptionChoice {
  readonly value: string;
  readonly label: string;
}

export interface KimiModelStateSnapshot {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}

export interface KimiModelStateShape {
  readonly getSnapshot: Effect.Effect<KimiModelStateSnapshot>;
  readonly publishConfigOptions: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  ) => Effect.Effect<void>;
  readonly streamChanges: Stream.Stream<KimiModelStateSnapshot>;
}

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

function normalizedOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

export function getKimiConfigOptionChoices(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<KimiConfigOptionChoice> {
  if (!option || option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), label: entry.name.trim() || entry.value.trim() }]
      : entry.options.map((nested) => ({
          value: nested.value.trim(),
          label: nested.name.trim() || nested.value.trim(),
        })),
  );
}

export function isKimiModelConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = normalizedOptionToken(option.id);
  const name = normalizedOptionToken(option.name);
  const category = normalizedOptionToken(option.category);
  return category === "model" || id === "model" || name === "model" || name === "models";
}

export function findKimiModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find(
    (option) => option.type === "select" && isKimiModelConfigOption(option),
  );
}

function buildKimiOptionCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ModelCapabilities {
  const optionDescriptors: Array<ProviderOptionDescriptor> = [];
  for (const option of configOptions) {
    if (isKimiModelConfigOption(option)) {
      continue;
    }
    if (option.type === "boolean") {
      optionDescriptors.push(
        buildBooleanOptionDescriptor({
          id: option.id,
          label: option.name.trim() || option.id,
          currentValue: option.currentValue,
          ...(option.description?.trim() ? { description: option.description.trim() } : {}),
        }),
      );
      continue;
    }
    const choices = getKimiConfigOptionChoices(option).filter((choice) => choice.value.length > 0);
    if (choices.length === 0) {
      continue;
    }
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: option.id,
        label: option.name.trim() || option.id,
        options: choices.map((choice) => ({
          value: choice.value,
          label: choice.label,
          ...(option.currentValue === choice.value ? { isDefault: true } : {}),
        })),
        ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      }),
    );
  }
  return createModelCapabilities({ optionDescriptors });
}

export function buildKimiModels(
  customModels: ReadonlyArray<string>,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [],
): ReadonlyArray<ServerProviderModel> {
  const capabilities = buildKimiOptionCapabilities(configOptions);
  const modelOption = findKimiModelConfigOption(configOptions);
  const seenModels = new Set([KIMI_DEFAULT_MODEL_ID]);
  const discoveredModels = getKimiConfigOptionChoices(modelOption).flatMap((choice) => {
    if (!choice.value || seenModels.has(choice.value)) {
      return [];
    }
    seenModels.add(choice.value);
    return [
      {
        slug: choice.value,
        name: choice.label,
        isCustom: false,
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });

  return providerModelsFromSettings(
    [
      {
        slug: KIMI_DEFAULT_MODEL_ID,
        name: KIMI_DEFAULT_MODEL_NAME,
        isCustom: false,
        capabilities,
      },
      ...discoveredModels,
    ],
    customModels,
    capabilities.optionDescriptors?.length ? capabilities : EMPTY_CAPABILITIES,
  );
}

export function normalizeKimiModelState(
  customModels: ReadonlyArray<string>,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): KimiModelStateSnapshot {
  const resolvedConfigOptions = [...(configOptions ?? [])];
  return {
    models: buildKimiModels(customModels, resolvedConfigOptions),
    configOptions: resolvedConfigOptions,
  };
}

export const makeKimiModelState = Effect.fn("makeKimiModelState")(function* (
  customModels: ReadonlyArray<string>,
): Effect.fn.Return<KimiModelStateShape, never, Scope.Scope> {
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<KimiModelStateSnapshot>(),
    PubSub.shutdown,
  );
  const snapshotRef = yield* Ref.make(normalizeKimiModelState(customModels, []));

  return {
    getSnapshot: Ref.get(snapshotRef),
    publishConfigOptions: (configOptions) =>
      Effect.gen(function* () {
        const next = normalizeKimiModelState(customModels, configOptions);
        yield* Ref.set(snapshotRef, next);
        yield* PubSub.publish(changes, next);
      }),
    get streamChanges() {
      return Stream.fromPubSub(changes);
    },
  } satisfies KimiModelStateShape;
});
