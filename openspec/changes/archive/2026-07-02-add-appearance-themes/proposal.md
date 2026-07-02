## Why

T3 Code currently exposes only a small theme preference and a terminal font field, which is not enough for users who need larger text, stronger contrast, or a customized visual theme. Appearance customization should become a first-class settings area while preserving the current T3 Code baseline as an immutable default.

## What Changes

- Add a dedicated Appearance settings page with theme selection, System/Light/Dark mode, typography, density, color variant editing, and a live preview.
- Add immutable built-in themes: `Default`, `Readable`, `Compact`, and `Terminal`.
- Add editable custom themes created by duplicating built-ins or other custom themes.
- Store appearance settings in client-local settings and keep the legacy `t3code:theme` key as a no-flash bootstrap mirror.
- Preserve the current `useTheme()` API while backing it with appearance settings.
- Move the existing Theme and Terminal font controls from General to Appearance.
- Add bundled Atkinson Hyperlegible for readable UI/chat text while preserving the existing Nerd Font-aware terminal stack.
- Add follow-up OpenSpec work for syntax theme selection and deeper desktop preview annotation theme sync.

## Capabilities

### New Capabilities

- `appearance-themes`: Client-local appearance themes covering built-in/custom theme lifecycle, global color scheme mode, light/dark variants, typography, density, diff markers, migration, runtime application, settings UI, and verification.

### Modified Capabilities

- None.

## Impact

- `packages/contracts/src/settings.ts` and tests gain appearance schemas/defaults.
- `apps/web/src/appearance` gains runtime/domain helpers for theme resolution, validation, migration, and CSS variable application.
- `apps/web/src/hooks/useSettings.ts` and `apps/web/src/hooks/useTheme.ts` migrate current theme behavior while preserving existing call sites.
- `apps/web/src/index.css`, chat markdown, diff panel, and terminal drawer adopt appearance variables.
- `apps/web/src/components/settings` and `apps/web/src/routes` gain `/settings/appearance` and remove visual controls from General.
- `apps/web/index.html` continues using `t3code:theme` for pre-React light/dark bootstrap.
- `.plans/21-appearance-settings-profiles.md` is updated to match the final scope.
