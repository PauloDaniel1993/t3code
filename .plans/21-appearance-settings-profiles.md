# Appearance Settings Themes

## Goal

Add a dedicated Appearance settings area where users can choose readable defaults, enlarge text, tune density, and create local custom themes without losing the current T3 Code visual baseline.

## Product Decisions

- Add `/settings/appearance` after General in the settings sidebar.
- Move Theme mode and terminal typography out of General.
- Use immutable built-in themes: `Default`, `Readable`, `Compact`, and `Terminal`.
- Persist only client-local appearance state. Built-ins remain runtime constants.
- Keep `Default` as the exact T3 Code baseline and clear core color overrides when it is active.
- Custom themes are created by copying a built-in or another custom theme.
- Global mode is separate from themes and remains `system | light | dark`.
- Keep `localStorage["t3code:theme"]` as the synchronous no-flash bootstrap mirror.
- Bundle Atkinson Hyperlegible for the readable theme.
- V1 supports full light/dark variant colors for accent, background, foreground, surface, muted, contrast, and translucent sidebar.
- Status colors (`success`, `warning`, `destructive`, `info`) stay controlled by T3 defaults.
- Syntax theme selection and full desktop preview annotation token sync are separate follow-up OpenSpec changes.

## Data Model

`packages/contracts` remains schema-only. Runtime helpers live under `apps/web/src/appearance`.

```ts
appearance: {
  colorScheme: "system" | "light" | "dark";
  activeThemeId: string;
  customThemeOrder: string[];
  customThemes: Record<string, AppearanceTheme>;
}

AppearanceTheme: {
  id: string;
  name: string;
  uiFontFamily: string;
  monoFontFamily: string;
  terminalFontFamily: string;
  uiFontSizePx: number;
  chatFontSizePx: number;
  codeFontSizePx: number;
  terminalFontSizePx: number;
  density: "compact" | "default" | "comfortable";
  diffMarkerStyle: "color" | "color-and-markers";
  variants: {
    light: AppearanceThemeVariant;
    dark: AppearanceThemeVariant;
  };
}

AppearanceThemeVariant: {
  accent: "#RRGGBB";
  background: "#RRGGBB";
  foreground: "#RRGGBB";
  surface: "#RRGGBB";
  muted: "#RRGGBB";
  contrast: number;
  translucentSidebar: boolean;
}
```

## Validation

- Decode missing appearance settings to a complete default state.
- Invalid active theme ids resolve to built-in `Default`.
- Invalid custom theme ids, built-in id collisions, bad colors, bad font sizes, bad density, or bad variants are discarded during decode.
- Strict colors use `#RRGGBB`.
- Font size ranges:
  - UI: 12-20 px
  - Chat: 13-24 px
  - Code: 11-22 px
  - Terminal: 11-22 px
- Foreground/background and accent/derived-foreground contrast must meet at least 4.5:1 before custom theme persistence.

## Migration

- Existing `t3code:theme` migrates into `appearance.colorScheme`.
- Existing `terminalFontFamily` remains decodable for backward compatibility.
- If legacy terminal font differs from the default stack, migration creates a custom `Migrated` theme and preserves built-in `Default`.
- If legacy values match defaults, no custom theme is created.
- `useTheme()` keeps returning `theme`, `resolvedTheme`, and `setTheme`.
- `setTheme()` continues writing `localStorage["t3code:theme"]` and syncing Electron chrome.

## Runtime Application

- Apply active theme variables on `document.documentElement`.
- Do not change global `html { font-size }`.
- Apply app variables for UI, mono, terminal fonts, font sizes, density, and terminal size.
- Apply core semantic variables for non-default themes: background, foreground, card, popover, primary, primary foreground, secondary, muted, neutral hover accent, border, input, and ring.
- Map the theme accent color to primary actions and focus rings; keep the shared `--accent` token neutral so settings buttons, dropdowns, text fields, and menu rows keep the same white/black hover behavior as the rest of Settings.
- Clear managed core semantic variables for built-in `Default` so current T3 CSS remains the source of truth.
- Body, markdown, inline code, code blocks, diff surfaces, and terminal surfaces use appearance variables.
- Density variables are consumed by settings page spacing, settings row/control gaps, and chat markdown block spacing so Compact and Comfortable produce visible layout changes.
- Diff marker style maps to existing `@pierre/diffs` indicators: color-only uses bars, color-plus-markers uses classic indicators.

## Settings UI

- `/settings/appearance` owns theme selection, mode, typography, density, colors, and preview.
- Built-ins are selectable and read-only; each exposes an editable-copy action.
- Custom themes can be renamed, deleted, edited, and reset field-by-field to `Default`.
- Font size controls use a slider plus visible numeric pixel value. The control previews CSS variables live and debounces settings persistence.
- Color controls use swatches plus strict hex inputs with inline errors.
- Restore defaults appears on General and Appearance. Appearance restore resets mode and active theme to defaults while preserving custom themes.

## Verification Expectations

- Contract tests cover decode defaults, bounds, invalid custom discard, active fallback, custom round-trip, and legacy terminal compatibility.
- Domain tests cover duplicate, rename, delete, built-in mutation rejection, per-field reset, invalid color, and contrast blocking.
- Hook/migration tests cover legacy migration, bootstrap mirror writes, storage failure handling, and desktop sync.
- Settings UI tests should cover Appearance nav, built-in read-only state, custom duplicate/edit flow, slider numeric value, invalid color errors, and restore defaults.
- Required gates before completion: `vp check` and `vp run typecheck`.

## Interim Notes

- Appearance patches are strict whole-object replacements. Full settings decode still normalizes persisted data, but malformed `appearance` patches reject instead of falling back to defaults.
- Tailwind `--font-sans` and `--font-mono` alias the runtime appearance font variables. The literal default stacks live on `--app-*` fallbacks and are bound to `BUILT_IN_APPEARANCE_THEMES.default` by test.
- Appearance settings panel helpers and debounced commit behavior live in `AppearanceSettings.logic.ts`; sliders flush pending commits on unmount, while color picker commits cancel on unmount.
