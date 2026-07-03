# Appearance Hardening

## Why

The appearance themes feature is architecturally sound but an audit found: a hand-rolled `Schema.Unknown` normalizer in `packages/contracts` that diverges from the file's established idioms and — critically — lets a malformed `appearance` patch silently reset to defaults, **wiping all custom themes**; a partial parallel font-token system where theme mono fonts miss every `font-mono`-classed element; missing logic extraction/tests for the 1,083-line settings panel; and several small correctness holes (theme-id case collision, unvalidated theme duplication, cross-tab divergence, triplicated legacy-theme parsing, a Default-baseline font-size break).

## What Changes

- Rework the `AppearanceSettings` contracts decode to the typed Wire-struct transform pattern already used by `SidebarOrganization`; malformed patches reject instead of defaulting (**BREAKING** for callers relying on silent coercion — none known).
- Unify font tokens: `--font-mono`/`--font-sans` alias the `--app-*-font-family` variables so Tailwind `font-mono` utilities honor the active theme.
- Extract `AppearanceSettings.logic.ts` + `.logic.test.ts` per settings-dir convention; one shared debounced-commit hook replaces two hand-rolled debouncers.
- Correctness: case-sensitive theme ids; `duplicateAppearanceTheme` validates before persist; cross-tab `storage` events reconcile `colorScheme` into the settings snapshot; single shared legacy `t3code:theme` parser; resolve the `body { font-size }` Default-baseline deviation; bind `:root` `--app-*` defaults to `BUILT_IN_APPEARANCE_THEMES.default` with a test.

## Capabilities

### Modified Capabilities

- `appearance-themes`: patch rejection semantics, font-token unification, duplication validation, cross-tab reconciliation. (Delta spec against `openspec/specs/appearance-themes/spec.md` — verify requirement names there before writing MODIFIED blocks; add new requirements as ADDED.)

## Impact

- `packages/contracts/src/settings.ts` + `settings.test.ts` (normalizer, patch, id regex).
- `apps/web/src/appearance/appearanceThemes.ts` + tests (duplicate validation, hex dedup).
- `apps/web/src/index.css` (token aliasing, body font-size, `:root` defaults).
- `apps/web/src/components/settings/AppearanceSettings.tsx` → new `.logic.ts`/`.logic.test.ts`.
- `apps/web/src/hooks/useTheme.ts` + tests (cross-tab, shared legacy parser), `apps/web/src/appearance/appearanceMigration.ts` (reuse parser).
