import {
  KIMI_DEFAULT_MODEL,
  KIMI_DEFAULT_MODEL_NAME,
  type CustomModelSetting,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type * as AcpSchema from "effect-acp/compat";

import { acpProviderOptionDescriptors } from "./acp/AcpSessionConfig.ts";
import { providerModelsFromSettings } from "./providerSnapshot.ts";

const token = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";

export function isKimiModeConfigOption(option: AcpSchema.SessionConfigOption): boolean {
  return [option.id, option.name, option.category].some((value) => token(value) === "mode");
}

export function isKimiModelConfigOption(option: AcpSchema.SessionConfigOption): boolean {
  return (
    [option.id, option.name, option.category].some((value) => token(value) === "model") ||
    token(option.name) === "models"
  );
}

export function normalizeKimiConfigOptions(options: ReadonlyArray<AcpSchema.SessionConfigOption>) {
  return options.map((option) =>
    isKimiModeConfigOption(option)
      ? { ...option, category: "mode" }
      : isKimiModelConfigOption(option)
        ? { ...option, category: "model" }
        : option,
  );
}

export function kimiConfigChoices(option: AcpSchema.SessionConfigOption | undefined) {
  return option?.type === "select"
    ? option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    : [];
}

/** Reuse V2's bounded descriptors, while keeping Kimi's permission mode out of model options. */
export function buildKimiModels(
  customModels: ReadonlyArray<CustomModelSetting>,
  configOptions: ReadonlyArray<AcpSchema.SessionConfigOption> = [],
): ReadonlyArray<ServerProviderModel> {
  const normalized = normalizeKimiConfigOptions(configOptions);
  const capabilities = createModelCapabilities({
    optionDescriptors: acpProviderOptionDescriptors({
      configOptions: normalized.filter((option) => !isKimiModeConfigOption(option)),
      modeState: undefined,
    }),
  });
  const seen = new Set([KIMI_DEFAULT_MODEL]);
  const discovered = kimiConfigChoices(normalized.find(isKimiModelConfigOption)).flatMap(
    (choice): ServerProviderModel[] => {
      if (
        !choice.value.trim() ||
        choice.value !== choice.value.trim() ||
        choice.value.length > 256 ||
        seen.has(choice.value) ||
        seen.size > 64
      )
        return [];
      seen.add(choice.value);
      return [
        {
          slug: choice.value,
          name: choice.name.trim().slice(0, 256) || choice.value,
          isCustom: false,
          capabilities,
        },
      ];
    },
  );
  const models = providerModelsFromSettings(
    [
      {
        slug: KIMI_DEFAULT_MODEL,
        name: KIMI_DEFAULT_MODEL_NAME,
        isCustom: false,
        isDefault: true,
        capabilities,
      },
      ...discovered,
    ],
    customModels,
    capabilities,
  );
  const reservedIds = new Set([
    "mode",
    "_t3/session-mode",
    ...normalized
      .filter((option) => isKimiModeConfigOption(option) || isKimiModelConfigOption(option))
      .map((option) => option.id),
  ]);
  // Saved custom capabilities must not expose a second mode or model picker.
  return models.map((model) => ({
    ...model,
    capabilities: createModelCapabilities({
      optionDescriptors: (model.capabilities?.optionDescriptors ?? []).filter(
        (descriptor) => !reservedIds.has(descriptor.id) && token(descriptor.label) !== "mode",
      ),
    }),
  }));
}
