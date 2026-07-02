## Context

The current web app has:

- `localStorage["t3code:theme"]` and `useTheme.ts` for System/Light/Dark.
- `terminalFontFamily` as a flat client setting.
- hard-coded terminal font size `12` in `ThreadTerminalDrawer.tsx`.
- semantic CSS tokens in `index.css` such as `--background`, `--foreground`, `--card`, `--primary`, `--ring`, and `--accent`.
- settings pages built from `SettingsSection`, `SettingsRow`, and existing UI primitives.

Appearance settings must remain local-only, preserve the exact current T3 Code visual baseline, and keep startup predictable. Desktop reads client settings through async IPC, so the pre-React bootstrap path can only rely on synchronous localStorage.

## Goals / Non-Goals

**Goals:**

- Add a first-class Appearance page for web/desktop.
- Store a complete client-local appearance state with global mode, immutable built-ins, and editable custom themes.
- Preserve `useTheme()` compatibility and Electron chrome synchronization.
- Keep `t3code:theme` as a bootstrap mirror for no-flash light/dark startup.
- Add live/debounced theme editing with guarded validation.
- Use existing semantic CSS variables instead of creating a parallel styling system.
- Bundle Atkinson Hyperlegible for readable UI/chat text.
- Preserve Powerline/Nerd Font terminal support.

**Non-Goals:**

- No mobile implementation in v1.
- No theme import/export in v1.
- No syntax theme picker in v1.
- No full desktop preview annotation token mapping in v1.
- No editing `success`, `warning`, `destructive`, or `info` semantic colors in v1.
- No server-synced appearance settings.

## Decisions

### 1. Built-ins are runtime constants

`Default`, `Readable`, `Compact`, and `Terminal` are runtime constants, not persisted user records. Only custom themes are persisted.

Alternatives considered:

- Persist built-ins with settings: rejected because `Default` must always represent the current exact T3 baseline and be safe to reset to.
- Let users edit built-ins directly: rejected because it removes reliable baselines.

### 2. Mode is global, not per theme

`appearance.colorScheme` stores `system | light | dark` globally. A theme stores both light and dark variants, and System mode resolves to the relevant variant.

Alternatives considered:

- Store mode inside each theme: rejected because read-only built-ins make a mode switch feel like editing a built-in.

### 3. Keep `t3code:theme` as a bootstrap mirror

Appearance settings are the source of truth after hydration, but `setTheme` also writes the old key. `index.html` uses that key for pre-React light/dark class and chrome color only.

Alternatives considered:

- Delete the old key after migration: rejected because the user wants ongoing fallback and desktop needs a simple no-flash path.
- Mirror full appearance to localStorage: rejected for v1 because duplicate token storage creates sync complexity.

### 4. Custom colors are core tokens plus derived tokens

Custom variants store editable core colors: accent, background, foreground, surface, muted, contrast, and translucent sidebar. Runtime derives borders, input, ring, primary foreground, accent foreground, muted foreground, card/popover, and app chrome colors.

Alternatives considered:

- Accent-only v1: rejected because the user explicitly wants theme customization like the screenshot.
- Expose every CSS token: rejected because it risks unusable combinations and makes validation too broad.

### 5. Sliders plus editable numeric values for font sizes

Font sizes use a T3-owned range slider paired with a `NumberField` showing the current pixel value. Sliders update live and persist after a debounce.

Alternatives considered:

- Number fields only: rejected because the user specifically asked for sliders that show the size number.

### 6. Migration preserves `Default`

If legacy settings differ from the built-in default, migration creates and activates a custom `Migrated` theme. Built-in `Default` remains exact T3.

Alternatives considered:

- Mutate Default during migration: rejected because it breaks Default as a known reset point.

### 7. Future theme work is separate OpenSpec work

Syntax theme selection and deeper desktop preview annotation token sync are separate follow-up changes. V1 includes only basic existing annotation sync and no syntax picker.

## Risks / Trade-offs

- [Large theme scope touches many surfaces] -> Implement in slices: contracts, domain helpers, runtime application, route/UI, then focused surfaces.
- [Invalid colors can make UI unreadable] -> Strict hex validation and contrast blocking for core foreground/background and primary foreground combinations.
- [Startup flash for custom colors] -> Accept v1 limitation; pre-React bootstrap applies only mode and chrome color.
- [Desktop async settings cannot prehydrate full appearance] -> Keep legacy mode key mirror for desktop no-flash behavior.
- [Diff marker support may depend on `@pierre/diffs` options] -> Wire known options where available and keep fallback styling safe.

## Migration Plan

1. Decode missing `appearance` to default appearance state.
2. During client settings hydration, inspect legacy `terminalFontFamily` and `t3code:theme`.
3. If either differs from defaults and no appearance settings exist, create an editable `Migrated` custom theme and activate it.
4. Keep writing `t3code:theme` whenever `appearance.colorScheme` changes.
5. Leave deprecated `terminalFontFamily` decodable until a later cleanup change.

Rollback strategy:

- Since settings are client-local and additive, rollback can ignore `appearance` and continue using `t3code:theme` plus `terminalFontFamily`.
- Built-in `Default` remains available as a safe user reset path.

## Open Questions

No blocking v1 questions remain. Follow-up changes will refine syntax theme selection and full preview annotation token sync.
