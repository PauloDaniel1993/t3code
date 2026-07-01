import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL, ProviderOptionSelections } from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;

export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"JetBrainsMono NFM", "JetBrainsMono NF", "CaskaydiaCove NFM", "CaskaydiaCove NF", "CaskaydiaCove Nerd Font Mono", "CaskaydiaCove Nerd Font", "CaskaydiaMono Nerd Font Mono", "CaskaydiaMono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font Mono", "FiraCode Nerd Font", "Hack Nerd Font Mono", "Hack Nerd Font", "Cascadia Code PL", "Cascadia Mono PL", "Cascadia Code", "Cascadia Mono", "SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace';

export const TerminalFontFamily = TrimmedString.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value || DEFAULT_TERMINAL_FONT_FAMILY),
      encode: (value) => Effect.succeed(value || DEFAULT_TERMINAL_FONT_FAMILY),
    }),
  ),
  Schema.check(Schema.isMaxLength(1024)),
);
export type TerminalFontFamily = typeof TerminalFontFamily.Type;

export const APPEARANCE_BUILT_IN_THEME_IDS = [
  "default",
  "readable",
  "compact",
  "terminal",
] as const;
export const AppearanceBuiltInThemeId = Schema.Literals(APPEARANCE_BUILT_IN_THEME_IDS);
export type AppearanceBuiltInThemeId = typeof AppearanceBuiltInThemeId.Type;

export const AppearanceThemeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z][a-z0-9_-]*$/i),
);
export type AppearanceThemeId = typeof AppearanceThemeId.Type;

export const AppearanceColorScheme = Schema.Literals(["system", "light", "dark"]);
export type AppearanceColorScheme = typeof AppearanceColorScheme.Type;
export const DEFAULT_APPEARANCE_COLOR_SCHEME: AppearanceColorScheme = "system";
export const DEFAULT_APPEARANCE_ACTIVE_THEME_ID: AppearanceBuiltInThemeId = "default";

export const AppearanceDensity = Schema.Literals(["compact", "default", "comfortable"]);
export type AppearanceDensity = typeof AppearanceDensity.Type;
export const DEFAULT_APPEARANCE_DENSITY: AppearanceDensity = "default";

export const AppearanceDiffMarkerStyle = Schema.Literals(["color", "color-and-markers"]);
export type AppearanceDiffMarkerStyle = typeof AppearanceDiffMarkerStyle.Type;
export const DEFAULT_APPEARANCE_DIFF_MARKER_STYLE: AppearanceDiffMarkerStyle = "color";

export const MIN_APPEARANCE_UI_FONT_SIZE_PX = 12;
export const MAX_APPEARANCE_UI_FONT_SIZE_PX = 20;
export const DEFAULT_APPEARANCE_UI_FONT_SIZE_PX = 14;
export const AppearanceUiFontSizePx = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_APPEARANCE_UI_FONT_SIZE_PX,
    maximum: MAX_APPEARANCE_UI_FONT_SIZE_PX,
  }),
);
export type AppearanceUiFontSizePx = typeof AppearanceUiFontSizePx.Type;

export const MIN_APPEARANCE_CHAT_FONT_SIZE_PX = 13;
export const MAX_APPEARANCE_CHAT_FONT_SIZE_PX = 24;
export const DEFAULT_APPEARANCE_CHAT_FONT_SIZE_PX = 14;
export const AppearanceChatFontSizePx = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_APPEARANCE_CHAT_FONT_SIZE_PX,
    maximum: MAX_APPEARANCE_CHAT_FONT_SIZE_PX,
  }),
);
export type AppearanceChatFontSizePx = typeof AppearanceChatFontSizePx.Type;

export const MIN_APPEARANCE_CODE_FONT_SIZE_PX = 11;
export const MAX_APPEARANCE_CODE_FONT_SIZE_PX = 22;
export const DEFAULT_APPEARANCE_CODE_FONT_SIZE_PX = 12;
export const AppearanceCodeFontSizePx = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_APPEARANCE_CODE_FONT_SIZE_PX,
    maximum: MAX_APPEARANCE_CODE_FONT_SIZE_PX,
  }),
);
export type AppearanceCodeFontSizePx = typeof AppearanceCodeFontSizePx.Type;

export const MIN_APPEARANCE_TERMINAL_FONT_SIZE_PX = 11;
export const MAX_APPEARANCE_TERMINAL_FONT_SIZE_PX = 22;
export const DEFAULT_APPEARANCE_TERMINAL_FONT_SIZE_PX = 12;
export const AppearanceTerminalFontSizePx = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_APPEARANCE_TERMINAL_FONT_SIZE_PX,
    maximum: MAX_APPEARANCE_TERMINAL_FONT_SIZE_PX,
  }),
);
export type AppearanceTerminalFontSizePx = typeof AppearanceTerminalFontSizePx.Type;

export const DEFAULT_APPEARANCE_UI_FONT_FAMILY = "var(--font-sans)";
export const DEFAULT_APPEARANCE_MONO_FONT_FAMILY = "var(--font-mono)";
export const READABLE_APPEARANCE_UI_FONT_FAMILY =
  '"Atkinson Hyperlegible", "Atkinson Hyperlegible Next", var(--font-sans)';

export const HexColor = TrimmedString.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
export type HexColor = typeof HexColor.Type;

export const AppearanceThemeName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type AppearanceThemeName = typeof AppearanceThemeName.Type;

export const AppearanceFontFamily = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
export type AppearanceFontFamily = typeof AppearanceFontFamily.Type;

export const AppearanceContrast = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
export type AppearanceContrast = typeof AppearanceContrast.Type;

export const AppearanceThemeVariant = Schema.Struct({
  accent: HexColor,
  background: HexColor,
  foreground: HexColor,
  surface: HexColor,
  muted: HexColor,
  contrast: AppearanceContrast,
  translucentSidebar: Schema.Boolean,
});
export type AppearanceThemeVariant = typeof AppearanceThemeVariant.Type;

export const AppearanceTheme = Schema.Struct({
  id: AppearanceThemeId,
  name: AppearanceThemeName,
  uiFontFamily: AppearanceFontFamily,
  monoFontFamily: AppearanceFontFamily,
  terminalFontFamily: TerminalFontFamily,
  uiFontSizePx: AppearanceUiFontSizePx,
  chatFontSizePx: AppearanceChatFontSizePx,
  codeFontSizePx: AppearanceCodeFontSizePx,
  terminalFontSizePx: AppearanceTerminalFontSizePx,
  density: AppearanceDensity,
  diffMarkerStyle: AppearanceDiffMarkerStyle,
  variants: Schema.Struct({
    light: AppearanceThemeVariant,
    dark: AppearanceThemeVariant,
  }),
});
export type AppearanceTheme = typeof AppearanceTheme.Type;

const AppearanceSettingsValue = Schema.Struct({
  colorScheme: AppearanceColorScheme,
  activeThemeId: AppearanceThemeId,
  customThemeOrder: Schema.Array(AppearanceThemeId),
  customThemes: Schema.Record(AppearanceThemeId, AppearanceTheme),
});

type AppearanceSettingsOutput = typeof AppearanceSettingsValue.Type;

const decodeAppearanceColorScheme = Schema.decodeUnknownSync(AppearanceColorScheme);
const decodeAppearanceThemeId = Schema.decodeUnknownSync(AppearanceThemeId);
const decodeAppearanceTheme = Schema.decodeUnknownSync(AppearanceTheme);
const APPEARANCE_BUILT_IN_THEME_ID_SET = new Set<string>(APPEARANCE_BUILT_IN_THEME_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeOptionalColorScheme(value: unknown): AppearanceColorScheme | null {
  try {
    return decodeAppearanceColorScheme(value);
  } catch {
    return null;
  }
}

function decodeOptionalThemeId(value: unknown): AppearanceThemeId | null {
  try {
    return decodeAppearanceThemeId(value);
  } catch {
    return null;
  }
}

function decodeOptionalAppearanceTheme(value: unknown): AppearanceTheme | null {
  try {
    return decodeAppearanceTheme(value);
  } catch {
    return null;
  }
}

function normalizeAppearanceSettings(value: unknown): AppearanceSettingsOutput {
  const input = isRecord(value) ? value : {};
  const customThemesInput = isRecord(input.customThemes) ? input.customThemes : {};
  const customThemes: Record<string, AppearanceTheme> = {};

  for (const [rawId, rawTheme] of Object.entries(customThemesInput)) {
    const id = decodeOptionalThemeId(rawId);
    if (!id || APPEARANCE_BUILT_IN_THEME_ID_SET.has(id)) {
      continue;
    }

    const theme = decodeOptionalAppearanceTheme(rawTheme);
    if (!theme || theme.id !== id || APPEARANCE_BUILT_IN_THEME_ID_SET.has(theme.id)) {
      continue;
    }

    customThemes[id] = theme;
  }

  const orderedThemeIds: AppearanceThemeId[] = [];
  const seenThemeIds = new Set<string>();
  const customThemeOrderInput = Array.isArray(input.customThemeOrder) ? input.customThemeOrder : [];
  for (const rawId of customThemeOrderInput) {
    const id = decodeOptionalThemeId(rawId);
    if (!id || seenThemeIds.has(id) || customThemes[id] === undefined) {
      continue;
    }
    orderedThemeIds.push(id);
    seenThemeIds.add(id);
  }
  for (const id of Object.keys(customThemes)) {
    if (!seenThemeIds.has(id)) {
      orderedThemeIds.push(id);
      seenThemeIds.add(id);
    }
  }

  const activeThemeId = decodeOptionalThemeId(input.activeThemeId);
  const resolvedActiveThemeId =
    activeThemeId &&
    (APPEARANCE_BUILT_IN_THEME_ID_SET.has(activeThemeId) ||
      customThemes[activeThemeId] !== undefined)
      ? activeThemeId
      : DEFAULT_APPEARANCE_ACTIVE_THEME_ID;

  return {
    colorScheme: decodeOptionalColorScheme(input.colorScheme) ?? DEFAULT_APPEARANCE_COLOR_SCHEME,
    activeThemeId: resolvedActiveThemeId,
    customThemeOrder: orderedThemeIds,
    customThemes,
  };
}

function encodeAppearanceSettings(value: AppearanceSettingsOutput): unknown {
  return {
    colorScheme: value.colorScheme,
    activeThemeId: value.activeThemeId,
    customThemeOrder: value.customThemeOrder,
    customThemes: value.customThemes,
  };
}

export const AppearanceSettings = Schema.Unknown.pipe(
  Schema.decodeTo(
    AppearanceSettingsValue,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(normalizeAppearanceSettings(value)),
      encode: (value) => Effect.succeed(encodeAppearanceSettings(value)),
    }),
  ),
);
export type AppearanceSettings = typeof AppearanceSettings.Type;
export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = Schema.decodeSync(
  AppearanceSettings,
)({});

export const SidebarCategory = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type SidebarCategory = typeof SidebarCategory.Type;

export const SidebarCategoryAssignment = Schema.Struct({
  categoryId: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type SidebarCategoryAssignment = typeof SidebarCategoryAssignment.Type;

const SidebarOrganizationWire = Schema.Struct({
  categoryOrder: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  categories: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, SidebarCategory)),
  projectCategoryAssignments: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarCategoryAssignment),
  ),
});

const SidebarOrganizationValue = Schema.Struct({
  categoryOrder: Schema.Array(TrimmedNonEmptyString),
  categories: Schema.Record(TrimmedNonEmptyString, SidebarCategory),
  projectCategoryAssignments: Schema.Record(TrimmedNonEmptyString, SidebarCategoryAssignment),
});

type SidebarOrganizationInput = typeof SidebarOrganizationWire.Type;
type SidebarOrganizationOutput = typeof SidebarOrganizationValue.Type;

function normalizeSidebarOrganization(value: SidebarOrganizationInput): SidebarOrganizationOutput {
  const categories: Record<string, SidebarCategory> = {};
  for (const category of Object.values(value.categories ?? {})) {
    categories[category.id] = {
      id: category.id,
      name: category.name,
      archivedAt: category.archivedAt,
    };
  }
  const validCategoryIds = new Set(Object.keys(categories));
  const categoryOrder = [
    ...new Set((value.categoryOrder ?? []).filter((id) => validCategoryIds.has(id))),
  ];
  const projectCategoryAssignments: Record<string, SidebarCategoryAssignment> = {};
  for (const [projectKey, assignment] of Object.entries(value.projectCategoryAssignments ?? {})) {
    if (!validCategoryIds.has(assignment.categoryId)) {
      continue;
    }
    projectCategoryAssignments[projectKey] = {
      categoryId: assignment.categoryId,
      updatedAt: assignment.updatedAt,
    };
  }

  return {
    categoryOrder,
    categories,
    projectCategoryAssignments,
  };
}

function encodeSidebarOrganization(value: SidebarOrganizationOutput): SidebarOrganizationInput {
  const categories: Record<string, SidebarCategory> = {};
  for (const [id, category] of Object.entries(value.categories)) {
    categories[id] = {
      id: category.id,
      name: category.name,
      archivedAt: category.archivedAt,
    };
  }
  const projectCategoryAssignments: Record<string, SidebarCategoryAssignment> = {};
  for (const [projectKey, assignment] of Object.entries(value.projectCategoryAssignments)) {
    projectCategoryAssignments[projectKey] = {
      categoryId: assignment.categoryId,
      updatedAt: assignment.updatedAt,
    };
  }

  return {
    categoryOrder: value.categoryOrder,
    categories,
    projectCategoryAssignments,
  };
}

export const SidebarOrganization = SidebarOrganizationWire.pipe(
  Schema.decodeTo(
    SidebarOrganizationValue,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(normalizeSidebarOrganization(value)),
      encode: (value) => Effect.succeed(encodeSidebarOrganization(value)),
    }),
  ),
);
export type SidebarOrganization = typeof SidebarOrganization.Type;
export const DEFAULT_SIDEBAR_ORGANIZATION: SidebarOrganization = Schema.decodeSync(
  SidebarOrganization,
)({});

export const ClientSettingsSchema = Schema.Struct({
  appearance: AppearanceSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_APPEARANCE_SETTINGS)),
  ),
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarOrganization: SidebarOrganization.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_ORGANIZATION)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  terminalFontFamily: TerminalFontFamily.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_FAMILY)),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Claude HOME path",
        description:
          "Custom HOME used when running this Claude instance. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Cursor agent binary.",
        providerSettingsForm: { placeholder: "agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Override the Cursor API endpoint for this instance.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const GrokSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Grok CLI binary.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type GrokSettings = typeof GrokSettings.Type;

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let T3 Code spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const DeepSeekSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    baseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Base URL",
        description: "DeepSeek-compatible Chat Completions base URL.",
        providerSettingsForm: {
          placeholder: "https://api.deepseek.com",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    contextLimit: Schema.Int.pipe(
      Schema.withDecodingDefault(Effect.succeed(128_000)),
      Schema.annotateKey({
        title: "Context limit",
        description: "Approximate maximum characters kept in the DeepSeek chat request.",
        providerSettingsForm: {
          placeholder: "128000",
          clearWhenEmpty: "persist",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["baseUrl", "contextLimit"],
  },
);
export type DeepSeekSettings = typeof DeepSeekSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),
  handoffCompressionModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    deepseek: DeepSeekSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "read-file",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  apiEndpoint: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  serverUrl: Schema.optionalKey(TrimmedString),
  serverPassword: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const DeepSeekSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  baseUrl: Schema.optionalKey(TrimmedString),
  contextLimit: Schema.optionalKey(Schema.Int),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  handoffCompressionModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelectionPatch)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
      deepseek: Schema.optionalKey(DeepSeekSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  appearance: Schema.optionalKey(AppearanceSettings),
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarOrganization: Schema.optionalKey(SidebarOrganization),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  wordWrap: Schema.optionalKey(Schema.Boolean),
  terminalFontFamily: Schema.optionalKey(TerminalFontFamily),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
