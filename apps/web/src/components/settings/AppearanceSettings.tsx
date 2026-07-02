import { CopyIcon, PaletteIcon, PenLineIcon, Trash2Icon, TypeIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  type AppearanceColorScheme,
  type AppearanceDensity,
  type AppearanceDiffMarkerStyle,
  type AppearanceSettings,
  type AppearanceTheme,
  type AppearanceThemeId,
  type AppearanceThemeVariant,
} from "@t3tools/contracts/settings";
import {
  BUILT_IN_APPEARANCE_THEMES,
  deleteCustomAppearanceTheme,
  duplicateAppearanceTheme,
  listAppearanceThemes,
  renameCustomAppearanceTheme,
  resetCustomAppearanceThemeField,
  resolveAppearanceTheme,
  setCustomAppearanceThemeVariantColor,
  updateCustomAppearanceTheme,
  type AppearanceThemeTopLevelField,
  type AppearanceThemeVariantField,
  type AppearanceVariantKey,
} from "~/appearance/appearanceThemes";
import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { ensureLocalApi, readLocalApi } from "~/localApi";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  COLOR_FIELDS,
  COLOR_SWATCHES,
  DENSITY_OPTIONS,
  DIFF_MARKER_OPTIONS,
  FONT_SIZE_CSS_VARIABLES,
  FONT_SIZE_ROWS,
  MONO_FONT_OPTIONS,
  THEME_MODE_OPTIONS,
  UI_FONT_OPTIONS,
  clampInt,
  createDebouncedCommit,
  fontOptionLabel,
  getFontSizeDefaults,
  normalizeHexColorInput,
  validateHexColorInput,
  type DebouncedCommit,
  type FontSizeField,
} from "./AppearanceSettings.logic";

const MODE_PREVIEW_LINES = {
  system: {
    panel: "linear-gradient(90deg, #f7f7f5 0%, #f7f7f5 50%, #171717 50%, #171717 100%)",
    lineA: "linear-gradient(90deg, #d4d4d0 0%, #d4d4d0 50%, #4a4a4a 50%, #4a4a4a 100%)",
    lineB: "linear-gradient(90deg, #b8b8b2 0%, #b8b8b2 50%, #6a6a6a 50%, #6a6a6a 100%)",
    chip: "linear-gradient(90deg, #6366f1 0%, #6366f1 50%, #818cf8 50%, #818cf8 100%)",
  },
  light: {
    panel: "#f7f7f5",
    lineA: "#d4d4d0",
    lineB: "#b8b8b2",
    chip: "#6366f1",
  },
  dark: {
    panel: "#171717",
    lineA: "#4a4a4a",
    lineB: "#6a6a6a",
    chip: "#818cf8",
  },
} as const satisfies Record<
  AppearanceColorScheme,
  {
    readonly panel: string;
    readonly lineA: string;
    readonly lineB: string;
    readonly chip: string;
  }
>;

interface FontSizeControlProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly unit?: string;
  readonly disabled: boolean;
  readonly onPreview?: (next: number) => void;
  readonly onChange: (next: number) => void;
}

function useDebouncedCommit<T>(
  commit: (value: T) => void,
  delayMs: number,
  cleanup: "flush" | "cancel",
): DebouncedCommit<T> {
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const debouncedRef = useRef<DebouncedCommit<T> | null>(null);
  if (debouncedRef.current === null) {
    debouncedRef.current = createDebouncedCommit((value) => commitRef.current(value), delayMs);
  }
  const debounced = debouncedRef.current;

  useEffect(
    () => () => {
      if (cleanup === "flush") {
        debounced.flush();
      } else {
        debounced.cancel();
      }
    },
    [cleanup, debounced],
  );

  return debounced;
}

function FontSizeControl({
  label,
  value,
  min,
  max,
  unit = "px",
  disabled,
  onPreview,
  onChange,
}: FontSizeControlProps) {
  const [draftValue, setDraftValue] = useState(value);
  const debouncedChange = useDebouncedCommit(onChange, 180, "flush");

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  const update = (next: number | null) => {
    const normalized = clampInt(next, min, max);
    setDraftValue(normalized);
    onPreview?.(normalized);
    debouncedChange.set(normalized);
  };

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(7rem,1fr)_auto_3.25rem] items-center gap-x-4 sm:w-84">
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={draftValue}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => update(Number(event.currentTarget.value))}
        onBlur={debouncedChange.flush}
        className="min-w-0 accent-primary disabled:opacity-50"
      />
      <NumberField
        value={draftValue}
        min={min}
        max={max}
        step={1}
        size="sm"
        disabled={disabled}
        className="w-20"
        onValueChange={update}
        onBlur={debouncedChange.flush}
      >
        <NumberFieldGroup className="h-7 w-24 rounded-md sm:h-6.5">
          <NumberFieldDecrement
            aria-label={`Decrease ${label}`}
            className="px-2 sm:px-2 [&_svg]:size-3"
          />
          <NumberFieldInput
            aria-label={unit ? `${label} in ${unit}` : label}
            className="sr-only"
            inputMode="numeric"
          />
          <output
            aria-label={`${label} value`}
            aria-live="polite"
            className="flex min-w-8 items-center justify-center font-mono text-xs tabular-nums text-foreground"
          >
            {draftValue}
          </output>
          <NumberFieldIncrement
            aria-label={`Increase ${label}`}
            className="px-2 sm:px-2 [&_svg]:size-3"
          />
        </NumberFieldGroup>
      </NumberField>
      <span className="w-10 pl-1.5 text-left text-xs text-muted-foreground">{unit}</span>
    </div>
  );
}

function previewFontSize(field: FontSizeField, value: number): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.style.setProperty(FONT_SIZE_CSS_VARIABLES[field], `${value}px`);
}

interface ColorFieldProps {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly resetAction?: ReactNode;
  readonly onCommit: (next: string) => void;
}

function ColorField({ label, value, disabled, resetAction, onCommit }: ColorFieldProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  const commit = useCallback(
    (nextValue: string) => {
      const normalized = normalizeHexColorInput(nextValue);
      setDraft(normalized);
      const hexValidation = validateHexColorInput(normalized);
      if (!hexValidation.isValid) {
        setError(hexValidation.error);
        return;
      }
      if (normalized === value.toUpperCase()) {
        setError(null);
        return;
      }
      try {
        onCommit(normalized);
        setError(null);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Color is not usable.");
      }
    },
    [onCommit, value],
  );
  const debouncedColorCommit = useDebouncedCommit(commit, 250, "cancel");

  const scheduleColorCommit = (nextValue: string) => {
    const normalized = normalizeHexColorInput(nextValue);
    setDraft(normalized);
    const hexValidation = validateHexColorInput(normalized);
    if (!hexValidation.isValid) {
      setError(hexValidation.error);
      return;
    }
    setError(null);
    debouncedColorCommit.set(normalized);
  };
  const displayedColor = validateHexColorInput(draft).isValid
    ? normalizeHexColorInput(draft)
    : value;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="text-[11px] font-medium text-muted-foreground/80">{label}</label>
      <div className="flex min-w-0 items-center gap-2">
        <label
          className={cn(
            "relative size-6 shrink-0 overflow-hidden rounded-md border border-border",
            disabled ? "cursor-default opacity-70" : "cursor-pointer hover:opacity-90",
          )}
        >
          <span
            className="block size-full"
            style={{ backgroundColor: displayedColor }}
            aria-hidden
          />
          <input
            type="color"
            value={displayedColor}
            disabled={disabled}
            aria-label={`Pick ${label} color`}
            onChange={(event) => scheduleColorCommit(event.currentTarget.value)}
            onBlur={debouncedColorCommit.flush}
            className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
          />
        </label>
        <Input
          nativeInput
          value={draft}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-label={`${label} color`}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            if (error) {
              setError(null);
            }
          }}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit(draft);
              event.currentTarget.blur();
            }
          }}
          className="w-full font-mono text-xs sm:w-32"
        />
        {resetAction ? <span className="flex shrink-0 items-center">{resetAction}</span> : null}
      </div>
      {error ? <p className="text-[11px] text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

function VariantSwatches({
  disabled,
  onAccentChange,
}: {
  readonly disabled: boolean;
  readonly onAccentChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {COLOR_SWATCHES.map((color) => (
        <button
          key={color}
          type="button"
          disabled={disabled}
          aria-label={`Use ${color} accent`}
          className="size-7 rounded-md border border-border shadow-xs outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          style={{ backgroundColor: color }}
          onClick={() => onAccentChange(color)}
        />
      ))}
    </div>
  );
}

function PreviewPanel() {
  return (
    <div className="grid gap-3 px-4 pt-3 pb-4 sm:px-5 md:grid-cols-2">
      <div className="min-w-0 space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-foreground">Settings text</span>
          <Button size="xs" className="h-6">
            Accent
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Chat text uses the readable size, while interface labels keep the app compact.
        </p>
        <p className="text-xs">
          Inline{" "}
          <code className="rounded border border-border bg-muted px-1 py-0.5 font-mono">code</code>{" "}
          follows the code font size.
        </p>
      </div>
      <div className="min-w-0 rounded-lg border border-border/70 bg-background/70 p-3 font-mono text-[length:var(--app-code-font-size)]">
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-success" />
          <span>preview.diff</span>
        </div>
        <div className="space-y-1">
          <div className="rounded bg-success/10 px-2 py-1 text-success-foreground">
            + accessible text size
          </div>
          <div className="rounded bg-destructive/10 px-2 py-1 text-destructive-foreground">
            - cramped contrast
          </div>
        </div>
      </div>
      <div className="md:col-span-2 rounded-lg border border-border/70 bg-[#0b0f14] p-3 font-mono text-[length:var(--app-terminal-font-size)] text-[#d1d5db]">
        <span className="text-success">$</span> t3code theme preview
      </div>
    </div>
  );
}

function ModePreviewCard({
  option,
  isActive,
  onSelect,
}: {
  readonly option: (typeof THEME_MODE_OPTIONS)[number];
  readonly isActive: boolean;
  readonly onSelect: () => void;
}) {
  const preview = MODE_PREVIEW_LINES[option.value];

  return (
    <button
      type="button"
      className={cn(
        "min-h-24 rounded-lg border bg-background p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        isActive ? "border-input bg-accent" : "border-border hover:bg-accent",
      )}
      onClick={onSelect}
    >
      <span className="block text-xs font-semibold text-foreground">{option.label}</span>
      <span
        className="mt-3 block overflow-hidden rounded-md border border-border/70 p-2"
        style={{ background: preview.panel }}
        aria-hidden
      >
        <span className="mb-2 block h-1.5 w-16 rounded-full" style={{ background: preview.chip }} />
        <span className="mb-1.5 block h-2 rounded-full" style={{ background: preview.lineA }} />
        <span className="block h-2 w-2/3 rounded-full" style={{ background: preview.lineB }} />
      </span>
    </button>
  );
}

export function AppearanceSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const appearance = settings.appearance;
  const themeEntries = useMemo(() => listAppearanceThemes(appearance), [appearance]);
  const active = resolveAppearanceTheme(appearance);
  const activeTheme = active.theme;
  const activeVariantKey: AppearanceVariantKey = resolvedTheme;
  const activeVariant = activeTheme.variants[activeVariantKey];
  const isCustomTheme = !active.isBuiltIn;
  const defaultTheme = BUILT_IN_APPEARANCE_THEMES.default;

  const updateAppearance = useCallback(
    (nextAppearance: AppearanceSettings) => {
      updateSettings({ appearance: nextAppearance });
    },
    [updateSettings],
  );

  const updateActiveCustomTheme = useCallback(
    (update: (theme: AppearanceTheme) => AppearanceTheme) => {
      if (!isCustomTheme) {
        return;
      }
      updateAppearance(updateCustomAppearanceTheme(appearance, activeTheme.id, update));
    },
    [activeTheme.id, appearance, isCustomTheme, updateAppearance],
  );

  const setTopLevelField = useCallback(
    <Field extends AppearanceThemeTopLevelField>(field: Field, value: AppearanceTheme[Field]) => {
      updateActiveCustomTheme((current) => ({ ...current, [field]: value }));
    },
    [updateActiveCustomTheme],
  );

  const resetTopLevelField = useCallback(
    (field: AppearanceThemeTopLevelField) => {
      if (!isCustomTheme) return;
      updateAppearance(
        resetCustomAppearanceThemeField(appearance, activeTheme.id, {
          kind: "topLevel",
          field,
        }),
      );
    },
    [activeTheme.id, appearance, isCustomTheme, updateAppearance],
  );

  const resetVariantField = useCallback(
    (field: AppearanceThemeVariantField) => {
      if (!isCustomTheme) return;
      updateAppearance(
        resetCustomAppearanceThemeField(appearance, activeTheme.id, {
          kind: "variant",
          variant: activeVariantKey,
          field,
        }),
      );
    },
    [activeTheme.id, activeVariantKey, appearance, isCustomTheme, updateAppearance],
  );

  const setVariantValue = useCallback(
    <Field extends keyof AppearanceThemeVariant>(
      variantKey: AppearanceVariantKey,
      field: Field,
      value: AppearanceThemeVariant[Field],
    ) => {
      updateActiveCustomTheme((current) => ({
        ...current,
        variants: {
          ...current.variants,
          [variantKey]: {
            ...current.variants[variantKey],
            [field]: value,
          },
        },
      }));
    },
    [updateActiveCustomTheme],
  );

  const duplicateActiveTheme = () => {
    updateAppearance(duplicateAppearanceTheme(appearance, activeTheme.id));
  };

  const renameActiveTheme = (name: string) => {
    if (!isCustomTheme) return;
    updateAppearance(renameCustomAppearanceTheme(appearance, activeTheme.id, name));
  };

  const deleteActiveTheme = async () => {
    if (!isCustomTheme) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      `Delete "${activeTheme.name}"?\nThis cannot be undone.`,
    );
    if (confirmed) {
      updateAppearance(deleteCustomAppearanceTheme(appearance, activeTheme.id));
    }
  };

  const changeAccent = (nextColor: string) => {
    if (!isCustomTheme) return;
    updateAppearance(
      setCustomAppearanceThemeVariantColor(
        appearance,
        activeTheme.id,
        activeVariantKey,
        "accent",
        nextColor,
      ),
    );
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Theme"
        icon={<PaletteIcon className="size-3.5 text-muted-foreground/70" />}
        headerAction={
          <Button size="xs" variant="outline" className="gap-1.5" onClick={duplicateActiveTheme}>
            <CopyIcon className="size-3.5" />
            Copy theme
          </Button>
        }
      >
        <SettingsRow
          title="Active theme"
          description="Default preserves the current T3 Code look. Copy a theme to edit it."
          resetAction={
            appearance.activeThemeId !== DEFAULT_APPEARANCE_SETTINGS.activeThemeId ? (
              <SettingResetButton
                label="active appearance theme"
                onClick={() => updateAppearance({ ...appearance, activeThemeId: "default" })}
              />
            ) : null
          }
          control={
            <Select
              value={appearance.activeThemeId}
              onValueChange={(value) =>
                updateAppearance({ ...appearance, activeThemeId: value as AppearanceThemeId })
              }
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Active appearance theme">
                <SelectValue>{activeTheme.name}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {themeEntries.map((entry) => (
                  <SelectItem hideIndicator key={entry.id} value={entry.id}>
                    {entry.theme.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Theme name"
          description={
            isCustomTheme
              ? "Rename this local custom theme."
              : "Built-in themes are read-only templates."
          }
          control={
            isCustomTheme ? (
              <div className="flex w-full items-center gap-2 sm:w-72">
                <DraftInput
                  value={activeTheme.name}
                  onCommit={renameActiveTheme}
                  aria-label="Theme name"
                  className="w-full"
                />
                <Button
                  size="icon-xs"
                  variant="destructive-outline"
                  aria-label="Delete theme"
                  onClick={() => void deleteActiveTheme()}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ) : (
              <Button
                size="xs"
                variant="outline"
                className="gap-1.5"
                onClick={duplicateActiveTheme}
              >
                <PenLineIcon className="size-3.5" />
                Create editable copy
              </Button>
            )
          }
        />
        <SettingsRow
          title="Mode"
          description="System follows your OS or browser color preference."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme mode" onClick={() => setTheme("system")} />
            ) : null
          }
        >
          <div className="grid gap-3 pt-3 pb-4 sm:grid-cols-3">
            {THEME_MODE_OPTIONS.map((option) => {
              const isActive = theme === option.value;
              return (
                <ModePreviewCard
                  key={option.value}
                  option={option}
                  isActive={isActive}
                  onSelect={() => setTheme(option.value)}
                />
              );
            })}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Typography"
        icon={<TypeIcon className="size-3.5 text-muted-foreground/70" />}
      >
        <SettingsRow
          title="UI font"
          description="Choose the interface font for controls and settings."
          resetAction={
            isCustomTheme && activeTheme.uiFontFamily !== defaultTheme.uiFontFamily ? (
              <SettingResetButton
                label="UI font"
                onClick={() => resetTopLevelField("uiFontFamily")}
              />
            ) : null
          }
          control={
            <Select
              value={activeTheme.uiFontFamily}
              disabled={!isCustomTheme}
              onValueChange={(value) => {
                if (value !== null) {
                  setTopLevelField("uiFontFamily", value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="UI font">
                <SelectValue>
                  {fontOptionLabel(activeTheme.uiFontFamily, UI_FONT_OPTIONS)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {UI_FONT_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Code font"
          description="Choose the monospaced font for code, diffs, and inline snippets."
          resetAction={
            isCustomTheme && activeTheme.monoFontFamily !== defaultTheme.monoFontFamily ? (
              <SettingResetButton
                label="code font"
                onClick={() => resetTopLevelField("monoFontFamily")}
              />
            ) : null
          }
          control={
            <Select
              value={activeTheme.monoFontFamily}
              disabled={!isCustomTheme}
              onValueChange={(value) => {
                if (value !== null) {
                  setTopLevelField("monoFontFamily", value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Code font">
                <SelectValue>
                  {fontOptionLabel(activeTheme.monoFontFamily, MONO_FONT_OPTIONS)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {MONO_FONT_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Terminal font"
          description="Use an installed Nerd Font or Powerline font family list for terminal sessions."
          resetAction={
            isCustomTheme && activeTheme.terminalFontFamily !== defaultTheme.terminalFontFamily ? (
              <SettingResetButton
                label="terminal font"
                onClick={() => resetTopLevelField("terminalFontFamily")}
              />
            ) : null
          }
          control={
            <DraftInput
              value={activeTheme.terminalFontFamily}
              disabled={!isCustomTheme}
              onCommit={(next) =>
                setTopLevelField("terminalFontFamily", next.trim() || DEFAULT_TERMINAL_FONT_FAMILY)
              }
              placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
              aria-label="Terminal font family"
              className="w-full font-mono text-xs sm:w-96"
            />
          }
        />
        {FONT_SIZE_ROWS.map((row) => (
          <SettingsRow
            key={row.field}
            title={row.title}
            description={row.description}
            resetAction={
              isCustomTheme && activeTheme[row.field] !== getFontSizeDefaults(row.field) ? (
                <SettingResetButton
                  label={row.title}
                  onClick={() => resetTopLevelField(row.field)}
                />
              ) : null
            }
            control={
              <FontSizeControl
                label={row.title}
                value={activeTheme[row.field]}
                min={row.min}
                max={row.max}
                disabled={!isCustomTheme}
                onPreview={(next) => previewFontSize(row.field, next)}
                onChange={(next) => setTopLevelField(row.field, next)}
              />
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Layout">
        <SettingsRow
          title="Density"
          description="Change spacing between controls and text surfaces."
          resetAction={
            isCustomTheme && activeTheme.density !== defaultTheme.density ? (
              <SettingResetButton label="density" onClick={() => resetTopLevelField("density")} />
            ) : null
          }
          control={
            <Select
              value={activeTheme.density}
              disabled={!isCustomTheme}
              onValueChange={(value) => setTopLevelField("density", value as AppearanceDensity)}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Density">
                <SelectValue>
                  {DENSITY_OPTIONS.find((option) => option.value === activeTheme.density)?.label ??
                    "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {DENSITY_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Diff markers"
          description="Show diff changes with colors only or with +/- markers as well."
          resetAction={
            isCustomTheme && activeTheme.diffMarkerStyle !== defaultTheme.diffMarkerStyle ? (
              <SettingResetButton
                label="diff markers"
                onClick={() => resetTopLevelField("diffMarkerStyle")}
              />
            ) : null
          }
          control={
            <Select
              value={activeTheme.diffMarkerStyle}
              disabled={!isCustomTheme}
              onValueChange={(value) =>
                setTopLevelField("diffMarkerStyle", value as AppearanceDiffMarkerStyle)
              }
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Diff marker style">
                <SelectValue>
                  {DIFF_MARKER_OPTIONS.find(
                    (option) => option.value === activeTheme.diffMarkerStyle,
                  )?.label ?? "Color"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {DIFF_MARKER_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title={`${activeVariantKey === "dark" ? "Dark" : "Light"} colors`}>
        <SettingsRow
          title="Accent swatches"
          description="Choose a distinct accent color for focus rings and primary actions."
          control={<VariantSwatches disabled={!isCustomTheme} onAccentChange={changeAccent} />}
        />
        <div className="grid gap-4 border-t border-border/60 px-4 py-4 sm:grid-cols-2 sm:px-5">
          {COLOR_FIELDS.map(({ field, label }) => (
            <div key={field} className="min-w-0">
              <ColorField
                label={label}
                value={activeVariant[field]}
                disabled={!isCustomTheme}
                resetAction={
                  isCustomTheme &&
                  activeVariant[field] !== defaultTheme.variants[activeVariantKey][field] ? (
                    <SettingResetButton
                      label={`${label} color`}
                      onClick={() => resetVariantField(field)}
                    />
                  ) : null
                }
                onCommit={(next) => {
                  updateAppearance(
                    setCustomAppearanceThemeVariantColor(
                      appearance,
                      activeTheme.id,
                      activeVariantKey,
                      field,
                      next,
                    ),
                  );
                }}
              />
            </div>
          ))}
        </div>
        <SettingsRow
          title="Contrast"
          description="Stored with the theme for preview and future renderer tuning."
          resetAction={
            isCustomTheme &&
            activeVariant.contrast !== defaultTheme.variants[activeVariantKey].contrast ? (
              <SettingResetButton label="contrast" onClick={() => resetVariantField("contrast")} />
            ) : null
          }
          control={
            <FontSizeControl
              label="Contrast"
              value={activeVariant.contrast}
              min={0}
              max={100}
              unit=""
              disabled={!isCustomTheme}
              onChange={(next) => setVariantValue(activeVariantKey, "contrast", next)}
            />
          }
        />
        <SettingsRow
          title="Sidebar translucency"
          description="Uses a see-through sidebar surface when the shell supports it; browsers may show little visible change."
          resetAction={
            isCustomTheme &&
            activeVariant.translucentSidebar !==
              defaultTheme.variants[activeVariantKey].translucentSidebar ? (
              <SettingResetButton
                label="translucent sidebar"
                onClick={() => resetVariantField("translucentSidebar")}
              />
            ) : null
          }
          control={
            <Switch
              checked={activeVariant.translucentSidebar}
              disabled={!isCustomTheme}
              aria-label="Use sidebar translucency"
              onCheckedChange={(checked) =>
                setVariantValue(activeVariantKey, "translucentSidebar", Boolean(checked))
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Preview">
        <PreviewPanel />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
