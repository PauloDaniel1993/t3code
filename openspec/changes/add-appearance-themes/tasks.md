## 1. Contracts And Defaults

- [ ] 1.1 Add Appearance schemas, default constants, built-in id types, font size bounds, strict hex colors, and deprecated `terminalFontFamily` compatibility to `packages/contracts/src/settings.ts`
- [ ] 1.2 Add contract tests for default decode, bounds, invalid custom theme discard, active fallback, custom round-trip, and legacy terminal font compatibility
- [ ] 1.3 Add Atkinson Hyperlegible dependency/import for the web app

## 2. Appearance Domain

- [ ] 2.1 Add `apps/web/src/appearance` domain modules for built-in themes, active theme resolution, theme operations, validation, contrast helpers, and safe runtime values
- [ ] 2.2 Add unit tests for duplicate built-in/custom, rename custom, reject built-in mutation, delete custom, active fallback, per-field reset, invalid color rejection, and contrast blocking

## 3. Theme Migration And Hook Compatibility

- [ ] 3.1 Update client settings hydration to migrate legacy `t3code:theme` and `terminalFontFamily` into Appearance without mutating built-in `Default`
- [ ] 3.2 Preserve `useTheme()` API while backing `theme` with `appearance.colorScheme`
- [ ] 3.3 Keep writing `localStorage["t3code:theme"]` as the startup bootstrap mirror and keep Electron `desktopBridge.setTheme` sync
- [ ] 3.4 Add focused tests for legacy migration, bootstrap mirror writes, storage failure handling, and desktop sync behavior

## 4. Runtime CSS Application

- [ ] 4.1 Add Appearance CSS variable application helper and root runtime integration
- [ ] 4.2 Update `apps/web/src/index.css` so body, chat markdown, code/pre, diff surfaces, settings rows where practical, and terminal surfaces use Appearance variables
- [ ] 4.3 Update `ThreadTerminalDrawer` to apply terminal font family and terminal font size from the active theme
- [ ] 4.4 Wire diff marker style/color-plus-marker behavior where supported by the current diff renderer

## 5. Appearance Settings UI

- [ ] 5.1 Add `/settings/appearance` route and Settings sidebar nav item after General
- [ ] 5.2 Move Theme and Terminal font controls out of General
- [ ] 5.3 Build Appearance page sections for theme lifecycle, mode preview cards, typography, density, colors, and preview
- [ ] 5.4 Add T3 slider-plus-number control for font sizes with live update and debounced persistence
- [ ] 5.5 Add custom theme color controls with swatches, strict hex input, inline validation, and contrast blocking
- [ ] 5.6 Add duplicate/copy, rename, delete, custom per-field reset, and built-in read-only states

## 6. Restore Defaults And Plan Updates

- [ ] 6.1 Update `useSettingsRestore` and settings header behavior so Restore defaults appears on General and Appearance, with Appearance reset preserving custom themes
- [ ] 6.2 Update `.plans/21-appearance-settings-profiles.md` to match the final theme customization scope, schema, migration behavior, and verification expectations
- [ ] 6.3 Add proposal-level follow-up OpenSpec changes for syntax theme picker and full preview annotation theme sync

## 7. Verification

- [ ] 7.1 Add settings UI tests for Appearance nav, built-in read-only controls, custom duplicate/edit flow, slider numeric value, invalid color errors, and restore defaults
- [ ] 7.2 Run focused contract/domain/hook/settings tests
- [ ] 7.3 Run `vp check`
- [ ] 7.4 Run `vp run typecheck`
- [ ] 7.5 Manually verify `/settings/appearance` in a running app, including desktop/browser mode behavior when practical
