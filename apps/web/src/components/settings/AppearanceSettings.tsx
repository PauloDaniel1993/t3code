import {
  APPEARANCE_FONT_SIZE_BOUNDS,
  type AppearanceColorScheme,
  type AppearanceSettings as AppearanceSettingsState,
  type AppearanceThemeVariant,
} from "@t3tools/contracts";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { chooseContrastingForeground } from "../../appearance/appearanceDerived";
import {
  defaultAppearanceThemeIdGenerator,
  duplicateAppearanceTheme,
  deleteAppearanceTheme,
  renameAppearanceTheme,
  resetAppearance,
  setActiveTheme,
  updateAppearanceTheme,
  type AppearanceThemeUpdate,
} from "../../appearance/appearanceOperations";
import { isBuiltInThemeId, resolveActiveAppearanceTheme } from "../../appearance/appearanceThemes";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useClientSettings, useUpdateAppearance } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import {
  APPEARANCE_MONO_FONT_OPTIONS,
  APPEARANCE_UI_FONT_OPTIONS,
  buildThemeListModel,
  clampFontSize,
  createDebouncedCommit,
  validateHexInput,
  type AppearanceFontSizeKind,
  type DebouncedCommit,
} from "./AppearanceSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const COLOR_TOKENS = ["accent", "background", "foreground", "surface", "muted"] as const;
const COLOR_TOKEN_DESCRIPTIONS = {
  accent: "Actions, links, focus rings, and selected items.",
  background: "The main canvas behind every screen.",
  foreground: "Primary text and high-emphasis icons.",
  surface: "Cards, panels, menus, and raised controls.",
  muted: "Subtle fills for secondary and inactive areas.",
} as const satisfies Record<(typeof COLOR_TOKENS)[number], string>;
const FONT_SIZE_ROWS = [
  {
    key: "uiFontSizePx",
    label: "UI font size",
    description: "Used for settings, navigation, and general interface text.",
  },
  {
    key: "chatFontSizePx",
    label: "Chat font size",
    description: "Used for conversation messages and assistant responses.",
  },
  {
    key: "codeFontSizePx",
    label: "Code font size",
    description: "Used for inline code and code blocks.",
  },
  {
    key: "terminalFontSizePx",
    label: "Terminal font size",
    description: "Used by terminal sessions.",
  },
] as const satisfies ReadonlyArray<{
  readonly key: AppearanceFontSizeKind;
  readonly label: string;
  readonly description: string;
}>;
const COLOR_SCHEME_OPTIONS = ["system", "light", "dark"] as const;
const CUSTOM_MONO_FONT_OPTION_VALUE = "__custom__";

type ColorToken = (typeof COLOR_TOKENS)[number];
type ColorVariantName = "light" | "dark";
type ColorDrafts = Partial<Record<`${ColorVariantName}-${ColorToken}`, string>>;
type ColorErrors = Partial<Record<`${ColorVariantName}-${ColorToken}`, string>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to update this appearance setting.";
}

function isMissingAppearanceThemeError(error: unknown): boolean {
  return error instanceof Error && /^Unknown (?:custom )?appearance theme "/.test(error.message);
}

function applyReplaySafeThemeOperation(
  appearance: AppearanceSettingsState,
  operation: (appearance: AppearanceSettingsState) => AppearanceSettingsState,
  onMissingTheme: (error: unknown) => void,
): AppearanceSettingsState {
  try {
    return operation(appearance);
  } catch (error) {
    if (isMissingAppearanceThemeError(error)) {
      onMissingTheme(error);
      return appearance;
    }
    throw error;
  }
}

function colorDraftKey(
  variant: ColorVariantName,
  token: ColorToken,
): `${ColorVariantName}-${ColorToken}` {
  return `${variant}-${token}`;
}

function appearanceSelectClassName(disabled: boolean): string {
  return [
    "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 sm:h-7",
    disabled ? "cursor-not-allowed opacity-64" : "cursor-pointer",
  ].join(" ");
}

function ColorSchemePreview({ scheme }: { readonly scheme: AppearanceColorScheme }) {
  const isLight = scheme === "light";
  const isDark = scheme === "dark";
  const splitBackground =
    "bg-[linear-gradient(to_right,#a3a3a3_0%,#a3a3a3_50%,#52525b_50%,#52525b_100%)]";
  const splitSurface =
    "bg-[linear-gradient(to_right,#fafafa_0%,#fafafa_50%,#27272a_50%,#27272a_100%)]";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block aspect-[1.55/1] w-full overflow-hidden rounded-[10px] border shadow-sm",
        isLight && "border-zinc-300 bg-zinc-100",
        isDark && "border-zinc-600 bg-zinc-700",
        scheme === "system" && `border-zinc-400 ${splitBackground}`,
      )}
      data-testid={`color-scheme-preview-${scheme}`}
    >
      <span
        className={cn(
          "absolute top-[21%] left-1/2 h-1 w-[34%] -translate-x-1/2 rounded-full",
          isLight && "bg-zinc-300",
          isDark && "bg-zinc-400",
          scheme === "system" && "bg-zinc-400",
        )}
      />
      <span
        className={cn(
          "absolute inset-x-[7%] top-[38%] bottom-0 rounded-t-md",
          isLight && "bg-white",
          isDark && "bg-zinc-800",
          scheme === "system" && splitSurface,
        )}
      >
        {[30, 48, 38].map((width, index) => (
          <span
            key={width}
            className={cn(
              "absolute left-[8%] h-1 rounded-full",
              isLight && "bg-zinc-200",
              isDark && "bg-zinc-600",
              scheme === "system" && "bg-zinc-400/70",
            )}
            style={{ top: `${18 + index * 25}%`, width: `${width}%` }}
          />
        ))}
      </span>
    </span>
  );
}

function AppearancePreview({
  theme,
  resolvedTheme,
  fontSizeDrafts,
}: {
  readonly theme: ReturnType<typeof resolveActiveAppearanceTheme>;
  readonly resolvedTheme: "light" | "dark";
  readonly fontSizeDrafts: Partial<Record<AppearanceFontSizeKind, number>>;
}) {
  const variant = theme.variants[resolvedTheme];
  const previewStyle = {
    "--background": variant.background,
    "--foreground": variant.foreground,
    "--card": variant.surface,
    "--card-foreground": variant.foreground,
    "--muted": variant.muted,
    "--primary": variant.accent,
    "--primary-foreground": chooseContrastingForeground(variant.accent),
    "--app-ui-font-family": theme.uiFontFamily,
    "--app-mono-font-family": theme.monoFontFamily,
    "--app-terminal-font-family": theme.terminalFontFamily,
    "--app-ui-font-size": `${fontSizeDrafts.uiFontSizePx ?? theme.uiFontSizePx}px`,
    "--app-chat-font-size": `${fontSizeDrafts.chatFontSizePx ?? theme.chatFontSizePx}px`,
    "--app-code-font-size": `${fontSizeDrafts.codeFontSizePx ?? theme.codeFontSizePx}px`,
    "--app-terminal-font-size": `${fontSizeDrafts.terminalFontSizePx ?? theme.terminalFontSizePx}px`,
  } as CSSProperties;

  return (
    <SettingsSection title="Appearance preview">
      <div
        className="space-y-4 rounded-2xl bg-(--card) p-4 text-(--foreground) sm:p-5"
        style={previewStyle}
      >
        <p
          data-testid="appearance-preview-settings"
          className="text-[length:var(--app-ui-font-size)] font-medium"
          style={{ fontFamily: "var(--app-ui-font-family)" }}
        >
          Settings-style text uses your interface font.
        </p>
        <p
          data-testid="appearance-preview-chat"
          className="text-[length:var(--app-chat-font-size)]"
          style={{ fontFamily: "var(--app-ui-font-family)" }}
        >
          Chat-style text keeps conversations comfortable to read.{" "}
          <code className="rounded bg-(--muted) px-1 py-0.5 font-mono text-[length:var(--app-code-font-size)]">
            inline code
          </code>
        </p>
        <pre
          data-testid="appearance-preview-code"
          className="overflow-x-auto rounded-lg bg-(--muted) p-3 font-mono text-[length:var(--app-code-font-size)]"
          style={{ fontFamily: "var(--app-mono-font-family)" }}
        >
          <code>{'const theme = "custom";'}</code>
        </pre>
        <div
          aria-label="Diff sample"
          data-testid="appearance-preview-diff"
          className="space-y-0.5 rounded-lg border border-black/10 bg-(--background) p-3 font-mono text-[length:var(--app-code-font-size)] dark:border-white/10"
          style={{ fontFamily: "var(--app-mono-font-family)" }}
        >
          <div className="text-destructive">- const mode = "system";</div>
          <div className="text-success">+ const mode = "dark";</div>
        </div>
        <div
          aria-label="Terminal sample"
          data-testid="appearance-preview-terminal"
          className="rounded-lg bg-neutral-950 p-3 font-mono text-neutral-100 text-[length:var(--app-terminal-font-size)]"
          style={{ fontFamily: "var(--app-terminal-font-family)" }}
        >
          <span className="text-emerald-400">$</span> t3code --theme preview
        </div>
        <Button
          size="sm"
          className="bg-(--primary) text-(--primary-foreground) hover:bg-(--primary)/90"
        >
          Primary action
        </Button>
      </div>
    </SettingsSection>
  );
}

function ColorVariantControls({
  variantName,
  variant,
  initiallyOpen,
  disabled,
  colorDrafts,
  colorErrors,
  onColorChange,
  onContrastChange,
}: {
  readonly variantName: ColorVariantName;
  readonly variant: AppearanceThemeVariant;
  readonly initiallyOpen: boolean;
  readonly disabled: boolean;
  readonly colorDrafts: ColorDrafts;
  readonly colorErrors: ColorErrors;
  readonly onColorChange: (variant: ColorVariantName, token: ColorToken, value: string) => void;
  readonly onContrastChange: (variant: ColorVariantName, value: number) => void;
}) {
  const title = variantName === "light" ? "Light colors" : "Dark colors";
  const [isOpen, setIsOpen] = useState(initiallyOpen);

  useEffect(() => {
    setIsOpen(initiallyOpen);
  }, [initiallyOpen]);

  return (
    <details
      className="border-t border-border/60 first:border-t-0"
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      open={isOpen}
    >
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-foreground sm:px-5">
        {title}
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
        {COLOR_TOKENS.map((token) => {
          const draftKey = colorDraftKey(variantName, token);
          const inputId = `appearance-${variantName}-${token}`;
          const descriptionId = `${inputId}-description`;
          const errorId = `${inputId}-error`;
          const error = colorErrors[draftKey];
          const value = colorDrafts[draftKey] ?? variant[token];
          const label = `${title} ${token}`;

          return (
            <div
              key={token}
              className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
            >
              <div className="min-w-0">
                <label htmlFor={inputId} className="text-xs font-medium capitalize text-foreground">
                  {token}
                </label>
                <p id={descriptionId} className="text-[11px] leading-relaxed text-muted-foreground">
                  {COLOR_TOKEN_DESCRIPTIONS[token]}
                </p>
              </div>
              <input
                aria-describedby={descriptionId}
                aria-label={`${label} color swatch`}
                className="size-8 cursor-pointer rounded-md border border-input bg-popover p-0.5 shadow-xs/5 outline-none transition-[background-color,border-color,box-shadow] hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-64 sm:size-7"
                disabled={disabled}
                onChange={(event) => onColorChange(variantName, token, event.target.value)}
                type="color"
                value={validateHexInput(value).ok ? value : variant[token]}
              />
              <div className="w-full sm:w-36">
                <Input
                  aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
                  aria-invalid={error ? true : undefined}
                  disabled={disabled}
                  id={inputId}
                  onChange={(event) => onColorChange(variantName, token, event.target.value)}
                  spellCheck={false}
                  value={value}
                />
              </div>
              {error ? (
                <p id={errorId} className="sm:col-span-3 text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
        <div className="flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <label
              htmlFor={`appearance-${variantName}-contrast`}
              className="text-xs font-medium text-foreground"
            >
              Contrast
            </label>
            <p
              id={`appearance-${variantName}-contrast-description`}
              className="text-[11px] leading-relaxed text-muted-foreground"
            >
              Controls the tonal separation between surfaces and text.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <NumberField
              disabled={disabled}
              id={`appearance-${variantName}-contrast`}
              max={2}
              min={0.5}
              onValueChange={(value) => {
                if (value !== null) onContrastChange(variantName, value);
              }}
              size="sm"
              step={0.1}
              value={variant.contrast}
              className="w-28"
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label={`Decrease ${title.toLowerCase()} contrast`} />
                <NumberFieldInput
                  aria-describedby={`appearance-${variantName}-contrast-description`}
                  aria-label={`${title} contrast`}
                />
                <NumberFieldIncrement aria-label={`Increase ${title.toLowerCase()} contrast`} />
              </NumberFieldGroup>
            </NumberField>
          </div>
        </div>
      </div>
    </details>
  );
}

type AppearanceRestoreOptions = {
  readonly appearance: AppearanceSettingsState;
  readonly colorScheme: AppearanceColorScheme;
  readonly setTheme: (colorScheme: AppearanceColorScheme) => void;
  readonly updateAppearance: (
    updater: (appearance: AppearanceSettingsState) => AppearanceSettingsState,
  ) => void;
  readonly onRestored?: (() => void) | undefined;
};

/**
 * Restores the selected built-in theme while delegating the color-scheme reset
 * to useTheme so its bootstrap mirror and desktop bridge remain synchronized.
 */
export function restoreAppearanceDefaults({
  appearance,
  colorScheme,
  setTheme,
  updateAppearance,
  onRestored,
}: AppearanceRestoreOptions): void {
  const shouldRestoreColorScheme = colorScheme !== "system";
  const shouldRestoreActiveTheme = appearance.activeThemeId !== "default";
  if (!shouldRestoreColorScheme && !shouldRestoreActiveTheme) return;

  if (shouldRestoreColorScheme) {
    setTheme("system");
  }
  if (shouldRestoreActiveTheme) {
    updateAppearance((current) => {
      const reset = resetAppearance(current);
      return { ...current, activeThemeId: reset.activeThemeId };
    });
  }
  onRestored?.();
}

export function useAppearanceSettingsRestore(onRestored?: () => void) {
  const appearance = useClientSettings((settings) => settings.appearance);
  const updateAppearance = useUpdateAppearance();
  const { theme, setTheme } = useTheme();
  const changedSettingLabels = useMemo(
    () => [
      ...(appearance.activeThemeId !== "default" ? ["Theme"] : []),
      ...(theme !== "system" ? ["Color scheme"] : []),
    ],
    [appearance.activeThemeId, theme],
  );

  const restore = useCallback(() => {
    restoreAppearanceDefaults({
      appearance,
      colorScheme: theme,
      setTheme,
      updateAppearance,
      onRestored,
    });
  }, [appearance, onRestored, setTheme, theme, updateAppearance]);

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      [
        "Restore Appearance defaults?",
        `This will reset: ${changedSettingLabels.join(", ")}. Custom themes will be preserved.`,
      ].join("\n"),
    );
    if (!confirmed) return;

    restore();
  }, [changedSettingLabels, restore]);

  return { changedSettingLabels, restore, restoreDefaults };
}

export function AppearanceSettings() {
  const appearance = useClientSettings((settings) => settings.appearance);
  const updateAppearance = useUpdateAppearance();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const activeTheme = resolveActiveAppearanceTheme(appearance);
  const isReadOnly = isBuiltInThemeId(appearance.activeThemeId);
  const isCustomMonoFont = !APPEARANCE_MONO_FONT_OPTIONS.some(
    (option) => option.value === activeTheme.monoFontFamily,
  );
  const themeList = useMemo(() => buildThemeListModel(appearance), [appearance]);
  const [renameDraft, setRenameDraft] = useState(activeTheme.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [monoFontDraft, setMonoFontDraft] = useState(activeTheme.monoFontFamily);
  const [monoFontError, setMonoFontError] = useState<string | null>(null);
  const [terminalFontDraft, setTerminalFontDraft] = useState(activeTheme.terminalFontFamily);
  const [terminalFontError, setTerminalFontError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [colorDrafts, setColorDrafts] = useState<ColorDrafts>({});
  const [colorErrors, setColorErrors] = useState<ColorErrors>({});
  const [fontSizeDrafts, setFontSizeDrafts] = useState<
    Partial<Record<AppearanceFontSizeKind, number>>
  >({});
  const activeThemeIdRef = useRef(appearance.activeThemeId);
  const debouncedFontCommits = useRef(new Map<string, DebouncedCommit<number>>());

  useEffect(() => {
    if (activeThemeIdRef.current === appearance.activeThemeId) return;
    activeThemeIdRef.current = appearance.activeThemeId;
    setRenameDraft(activeTheme.name);
    setRenameError(null);
    setMonoFontDraft(activeTheme.monoFontFamily);
    setMonoFontError(null);
    setTerminalFontDraft(activeTheme.terminalFontFamily);
    setTerminalFontError(null);
    setOperationError(null);
    setColorDrafts({});
    setColorErrors({});
    setFontSizeDrafts({});
  }, [
    activeTheme.monoFontFamily,
    activeTheme.name,
    activeTheme.terminalFontFamily,
    appearance.activeThemeId,
  ]);

  useEffect(() => {
    return () => {
      for (const debouncedCommit of debouncedFontCommits.current.values()) {
        debouncedCommit.flushOnUnmount();
      }
    };
  }, []);

  const commitThemeUpdate = useCallback(
    (partial: AppearanceThemeUpdate): string | null => {
      const themeId = appearance.activeThemeId;
      if (isBuiltInThemeId(themeId)) return "Built-in themes are read-only.";

      try {
        // Validate first so rejected edits never reach persistence.
        updateAppearanceTheme(appearance, themeId, partial);
        updateAppearance((current) =>
          applyReplaySafeThemeOperation(
            current,
            (nextAppearance) => updateAppearanceTheme(nextAppearance, themeId, partial),
            (error) => setOperationError(errorMessage(error)),
          ),
        );
        setOperationError(null);
        return null;
      } catch (error) {
        const message = errorMessage(error);
        setOperationError(message);
        return message;
      }
    },
    [appearance, updateAppearance],
  );

  const handleThemeSelect = useCallback(
    (id: string) => {
      for (const debouncedCommit of debouncedFontCommits.current.values()) {
        debouncedCommit.flush();
      }
      updateAppearance((current) => setActiveTheme(current, id));
    },
    [updateAppearance],
  );

  const handleDuplicate = useCallback(() => {
    const sourceId = appearance.activeThemeId;
    const duplicateId = defaultAppearanceThemeIdGenerator("theme", 0);
    const duplicateIdGenerator = (_slug: string, attempt: number) =>
      attempt === 0 ? duplicateId : `${duplicateId}-${attempt}`;

    try {
      // Validate immediately, then replay this deterministic operation against hydration.
      duplicateAppearanceTheme(appearance, sourceId, duplicateIdGenerator);
      updateAppearance((current) =>
        applyReplaySafeThemeOperation(
          current,
          (nextAppearance) =>
            duplicateAppearanceTheme(nextAppearance, sourceId, duplicateIdGenerator),
          (error) => setOperationError(errorMessage(error)),
        ),
      );
      setOperationError(null);
    } catch (error) {
      setOperationError(errorMessage(error));
    }
  }, [appearance, updateAppearance]);

  const handleRename = useCallback(() => {
    if (renameDraft.trim().length === 0) {
      setRenameError("Enter a theme name.");
      return;
    }

    const themeId = appearance.activeThemeId;
    try {
      renameAppearanceTheme(appearance, themeId, renameDraft);
      updateAppearance((current) =>
        applyReplaySafeThemeOperation(
          current,
          (nextAppearance) => renameAppearanceTheme(nextAppearance, themeId, renameDraft),
          (error) => setOperationError(errorMessage(error)),
        ),
      );
      setRenameError(null);
      setOperationError(null);
    } catch (error) {
      const message = errorMessage(error);
      setRenameError(message);
      setOperationError(message);
    }
  }, [appearance, renameDraft, updateAppearance]);

  const handleDelete = useCallback(() => {
    const themeId = appearance.activeThemeId;
    try {
      deleteAppearanceTheme(appearance, themeId);
      updateAppearance((current) =>
        applyReplaySafeThemeOperation(
          current,
          (nextAppearance) => deleteAppearanceTheme(nextAppearance, themeId),
          (error) => setOperationError(errorMessage(error)),
        ),
      );
      setOperationError(null);
    } catch (error) {
      setOperationError(errorMessage(error));
    }
  }, [appearance, updateAppearance]);

  const handleFontSizeChange = useCallback(
    (kind: AppearanceFontSizeKind, value: number | null) => {
      if (isReadOnly) return;
      const nextValue = clampFontSize(kind, value ?? activeTheme[kind]);
      const themeId = appearance.activeThemeId;
      const debounceKey = `${themeId}-${kind}`;
      setFontSizeDrafts((current) => ({ ...current, [kind]: nextValue }));

      let debouncedCommit = debouncedFontCommits.current.get(debounceKey);
      if (!debouncedCommit) {
        debouncedCommit = createDebouncedCommit((fontSize) => {
          try {
            updateAppearance((current) =>
              applyReplaySafeThemeOperation(
                current,
                (nextAppearance) =>
                  updateAppearanceTheme(nextAppearance, themeId, { [kind]: fontSize }),
                (error) => setOperationError(errorMessage(error)),
              ),
            );
            setOperationError(null);
          } catch (error) {
            setOperationError(errorMessage(error));
          }
        });
        debouncedFontCommits.current.set(debounceKey, debouncedCommit);
      }
      debouncedCommit.set(nextValue);
    },
    [activeTheme, appearance.activeThemeId, isReadOnly, updateAppearance],
  );

  const handleMonoFontChange = useCallback(
    (value: string) => {
      setMonoFontDraft(value);
      if (value.trim().length === 0) {
        setMonoFontError("Enter a mono font family.");
        return;
      }

      const error = commitThemeUpdate({ monoFontFamily: value.trim() });
      setMonoFontError(error);
    },
    [commitThemeUpdate],
  );

  const handleTerminalFontChange = useCallback(
    (value: string) => {
      setTerminalFontDraft(value);
      if (value.trim().length === 0) {
        setTerminalFontError("Enter a terminal font family.");
        return;
      }

      const error = commitThemeUpdate({ terminalFontFamily: value.trim() });
      setTerminalFontError(error);
    },
    [commitThemeUpdate],
  );

  const handleColorChange = useCallback(
    (variant: ColorVariantName, token: ColorToken, value: string) => {
      const key = colorDraftKey(variant, token);
      setColorDrafts((current) => ({ ...current, [key]: value }));
      const validation = validateHexInput(value);
      if (!validation.ok) {
        setColorErrors((current) => ({ ...current, [key]: validation.error }));
        return;
      }

      const error = commitThemeUpdate({ variants: { [variant]: { [token]: value } } });
      setColorErrors((current) => ({ ...current, [key]: error ?? undefined }));
    },
    [commitThemeUpdate],
  );

  const handleContrastChange = useCallback(
    (variant: ColorVariantName, value: number) => {
      if (!Number.isFinite(value)) return;
      commitThemeUpdate({
        variants: { [variant]: { contrast: Math.min(2, Math.max(0.5, value)) } },
      });
    },
    [commitThemeUpdate],
  );

  const handleTranslucentSidebarChange = useCallback(
    (value: boolean) => {
      commitThemeUpdate({
        variants: {
          light: { translucentSidebar: value },
          dark: { translucentSidebar: value },
        },
      });
    },
    [commitThemeUpdate],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Themes">
        <SettingsRow
          title="Active theme"
          description="Choose a built-in preset or one of your custom themes."
          control={
            <Select
              value={appearance.activeThemeId}
              onValueChange={(value) => {
                if (typeof value === "string") handleThemeSelect(value);
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Appearance theme">
                <SelectValue>{activeTheme.name}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {themeList.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      <span className="flex min-w-0 items-center justify-between gap-4">
                        <span className="truncate">{item.name}</span>
                        {item.isBuiltIn ? (
                          <span className="text-xs text-muted-foreground">Built-in</span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Manage theme"
          description={
            isReadOnly
              ? "Built-in themes are read-only. Duplicate this theme to customize it."
              : "Custom themes can be renamed, duplicated, or deleted."
          }
          control={
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={handleDuplicate} size="xs" variant="outline">
                Duplicate
              </Button>
              <Button
                disabled={isReadOnly}
                onClick={handleDelete}
                size="xs"
                variant="destructive-outline"
              >
                Delete
              </Button>
              <Button
                onClick={() => {
                  restoreAppearanceDefaults({
                    appearance,
                    colorScheme: theme,
                    setTheme,
                    updateAppearance,
                  });
                  setOperationError(null);
                }}
                size="xs"
                variant="ghost"
              >
                Restore appearance defaults
              </Button>
            </div>
          }
        >
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <label
              htmlFor="appearance-theme-name"
              className="grid min-w-0 flex-1 gap-1.5 text-xs font-medium text-foreground"
            >
              Theme name
              <Input
                aria-describedby={renameError ? "appearance-theme-name-error" : undefined}
                aria-invalid={renameError ? true : undefined}
                disabled={isReadOnly}
                id="appearance-theme-name"
                onChange={(event) => {
                  setRenameDraft(event.target.value);
                  if (renameError) setRenameError(null);
                }}
                value={renameDraft}
              />
            </label>
            <Button disabled={isReadOnly} onClick={handleRename} size="sm" variant="outline">
              Rename
            </Button>
          </div>
          {renameError ? (
            <p
              id="appearance-theme-name-error"
              className="mt-2 text-xs text-destructive"
              role="alert"
            >
              {renameError}
            </p>
          ) : null}
          {operationError ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {operationError}
            </p>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="appearance-mode" title="Mode">
        <div
          className="grid grid-cols-3 gap-2 p-3 sm:gap-3 sm:p-4"
          role="radiogroup"
          aria-label="Color scheme mode"
        >
          {COLOR_SCHEME_OPTIONS.map((option) => {
            const selected = theme === option;
            return (
              <button
                key={option}
                aria-checked={selected}
                className={cn(
                  "group flex min-w-0 flex-col gap-2 rounded-xl p-1.5 text-center text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-2 sm:text-sm",
                  selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
                )}
                onClick={() => setTheme(option)}
                role="radio"
                type="button"
              >
                <span
                  className={cn(
                    "rounded-[11px] border-2 p-0.5 transition-colors",
                    selected ? "border-primary" : "border-transparent group-hover:border-border",
                  )}
                >
                  <ColorSchemePreview scheme={option} />
                </span>
                <span>{option}</span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Text sizes">
        {FONT_SIZE_ROWS.map((row) => {
          const bounds = APPEARANCE_FONT_SIZE_BOUNDS[row.key];
          const value = fontSizeDrafts[row.key] ?? activeTheme[row.key];

          return (
            <SettingsRow
              key={row.key}
              title={row.label}
              description={`${row.description} Choose ${bounds.min}–${bounds.max} px.`}
              control={
                <div className="flex shrink-0 items-center gap-2">
                  <NumberField
                    disabled={isReadOnly}
                    id={`appearance-${row.key}`}
                    max={bounds.max}
                    min={bounds.min}
                    onValueChange={(nextValue) => {
                      if (nextValue !== null) handleFontSizeChange(row.key, nextValue);
                    }}
                    size="sm"
                    step={1}
                    value={value}
                    className="w-28"
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement aria-label={`Decrease ${row.label.toLowerCase()}`} />
                      <NumberFieldInput aria-label={`${row.label} in pixels`} />
                      <NumberFieldIncrement aria-label={`Increase ${row.label.toLowerCase()}`} />
                    </NumberFieldGroup>
                  </NumberField>
                  <span className="text-xs text-muted-foreground">px</span>
                </div>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="Fonts & layout">
        <SettingsRow title="UI font" description="Choose from the curated interface font options.">
          <div className="mt-3 grid gap-1.5">
            <label htmlFor="appearance-ui-font" className="text-xs font-medium text-foreground">
              UI font family
            </label>
            <select
              className={appearanceSelectClassName(isReadOnly)}
              disabled={isReadOnly}
              id="appearance-ui-font"
              onChange={(event) => commitThemeUpdate({ uiFontFamily: event.target.value })}
              value={activeTheme.uiFontFamily}
            >
              {APPEARANCE_UI_FONT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </SettingsRow>
        <SettingsRow title="Mono font" description="Used by code and terminal-style content.">
          <div className="mt-3 grid gap-1.5">
            <label htmlFor="appearance-mono-font" className="text-xs font-medium text-foreground">
              Mono font family
            </label>
            <select
              className={appearanceSelectClassName(isReadOnly)}
              disabled={isReadOnly}
              id="appearance-mono-font"
              onChange={(event) => {
                if (event.target.value !== CUSTOM_MONO_FONT_OPTION_VALUE) {
                  handleMonoFontChange(event.target.value);
                }
              }}
              value={isCustomMonoFont ? CUSTOM_MONO_FONT_OPTION_VALUE : activeTheme.monoFontFamily}
            >
              {APPEARANCE_MONO_FONT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              {isCustomMonoFont ? (
                <option value={CUSTOM_MONO_FONT_OPTION_VALUE}>Custom</option>
              ) : null}
            </select>
            <label
              htmlFor="appearance-mono-font-custom"
              className="text-xs font-medium text-foreground"
            >
              Custom mono font family
            </label>
            <Input
              aria-describedby={monoFontError ? "appearance-mono-font-custom-error" : undefined}
              aria-invalid={monoFontError ? true : undefined}
              disabled={isReadOnly}
              id="appearance-mono-font-custom"
              onChange={(event) => handleMonoFontChange(event.target.value)}
              spellCheck={false}
              value={monoFontDraft}
            />
            {monoFontError ? (
              <p
                id="appearance-mono-font-custom-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {monoFontError}
              </p>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Terminal font"
          description="Enter a CSS font-family fallback list for terminals."
        >
          <div className="mt-3 grid gap-1.5">
            <label
              htmlFor="appearance-terminal-font"
              className="text-xs font-medium text-foreground"
            >
              Terminal font family
            </label>
            <Input
              aria-describedby={terminalFontError ? "appearance-terminal-font-error" : undefined}
              aria-invalid={terminalFontError ? true : undefined}
              disabled={isReadOnly}
              id="appearance-terminal-font"
              onChange={(event) => handleTerminalFontChange(event.target.value)}
              spellCheck={false}
              value={terminalFontDraft}
            />
            {terminalFontError ? (
              <p
                id="appearance-terminal-font-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {terminalFontError}
              </p>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow title="Density" description="Adjust spacing throughout the interface.">
          <div className="mt-3 grid gap-1.5">
            <label htmlFor="appearance-density" className="text-xs font-medium text-foreground">
              Interface density
            </label>
            <select
              className={appearanceSelectClassName(isReadOnly)}
              disabled={isReadOnly}
              id="appearance-density"
              onChange={(event) => {
                const density = event.target.value;
                if (density === "compact" || density === "default" || density === "comfortable") {
                  commitThemeUpdate({ density });
                }
              }}
              value={activeTheme.density}
            >
              <option value="compact">Compact</option>
              <option value="default">Default</option>
              <option value="comfortable">Comfortable</option>
            </select>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Colors">
        <ColorVariantControls
          colorDrafts={colorDrafts}
          colorErrors={colorErrors}
          disabled={isReadOnly}
          initiallyOpen={resolvedTheme === "light"}
          onColorChange={handleColorChange}
          onContrastChange={handleContrastChange}
          variant={activeTheme.variants.light}
          variantName="light"
        />
        <ColorVariantControls
          colorDrafts={colorDrafts}
          colorErrors={colorErrors}
          disabled={isReadOnly}
          initiallyOpen={resolvedTheme === "dark"}
          onColorChange={handleColorChange}
          onContrastChange={handleContrastChange}
          variant={activeTheme.variants.dark}
          variantName="dark"
        />
        <SettingsRow
          control={
            <Switch
              aria-describedby="appearance-translucent-sidebar-description"
              aria-label="Translucent sidebar in light and dark modes"
              checked={
                activeTheme.variants.light.translucentSidebar &&
                activeTheme.variants.dark.translucentSidebar
              }
              disabled={isReadOnly}
              id="appearance-translucent-sidebar"
              onCheckedChange={(checked) => handleTranslucentSidebarChange(Boolean(checked))}
            />
          }
          description="Lets supported desktop window materials show through the sidebar in both light and dark modes."
          descriptionId="appearance-translucent-sidebar-description"
          title="Translucent sidebar"
        />
      </SettingsSection>

      <AppearancePreview
        fontSizeDrafts={fontSizeDrafts}
        resolvedTheme={resolvedTheme}
        theme={activeTheme}
      />
    </SettingsPageContainer>
  );
}
