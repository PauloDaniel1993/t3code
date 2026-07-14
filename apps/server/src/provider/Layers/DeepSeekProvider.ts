import {
  DEFAULT_DEEPSEEK_HANDOFF_COMPRESSION_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  type DeepSeekSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("deepseek");
const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_DEEPSEEK_MODEL,
    name: "DeepSeek V4 Pro",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: DEFAULT_DEEPSEEK_HANDOFF_COMPRESSION_MODEL,
    name: "DeepSeek V4 Flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function readDeepSeekApiKey(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.DEEPSEEK_API_KEY?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function readDeepSeekBaseUrl(
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const value = (environment.DEEPSEEK_BASE_URL ?? settings.baseUrl).trim();
  return value.length > 0 ? value : undefined;
}

export function deepseekModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export const buildDeepSeekProviderSnapshot = (input: {
  readonly settings: DeepSeekSettings;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = deepseekModelsFromSettings(input.settings.customModels);
    const apiKey = readDeepSeekApiKey(input.environment);
    const baseUrl = readDeepSeekBaseUrl(input.settings, input.environment);
    const contextLimitReady =
      Number.isInteger(input.settings.contextLimit) && input.settings.contextLimit > 0;

    if (!input.settings.enabled) {
      return buildServerProvider({
        presentation: DEEPSEEK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "DeepSeek is disabled in T3 Code settings.",
        },
      });
    }

    const missing: string[] = [];
    if (!apiKey) missing.push("DEEPSEEK_API_KEY");
    if (!baseUrl) missing.push("base URL");
    if (!contextLimitReady) missing.push("context limit");
    if (models.length === 0) missing.push("model");

    if (missing.length > 0) {
      return buildServerProvider({
        presentation: DEEPSEEK_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: apiKey ? "authenticated" : "unauthenticated", type: "apiKey" },
          message: `DeepSeek is missing ${missing.join(", ")} configuration.`,
        },
      });
    }

    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated", type: "apiKey" },
      },
    });
  });

export const enrichDeepSeekSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<void> => input.publishSnapshot(input.snapshot);
