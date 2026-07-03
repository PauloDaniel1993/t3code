# Design — appearance-hardening

## Context

The appearance feature (commits `dd3e56dc`, `84d43396`, `5a4fe4dd`) correctly splits schema (contracts) from runtime (`apps/web/src/appearance/`) and preserves `useTheme()`/mirror compatibility. The hardening targets are precision fixes identified by audit, anchored to existing repo patterns.

## Goals / Non-Goals

**Goals:**

- Contracts decode follows the file's own precedents; bad patches can never wipe user themes.
- One font-token system; theme fonts apply everywhere.
- Settings-panel logic extracted and tested per the `.logic.ts` convention.
- Close the small correctness holes.

**Non-Goals:**

- Redesigning the theme model, adding syntax themes (separate OpenSpec change exists), or altering plan 21's product decisions.
- Refactoring `useClientSettings`'s whole-snapshot subscription (pre-existing design).

## Decisions

- **Wire-struct transform over `Schema.Unknown`**: model `AppearanceSettingsWire` as a `Schema.Struct` with `optionalKey` fields (pattern: `SidebarOrganization`, `packages/contracts/src/settings.ts` ~L307-379), then a transform that applies the discard/fallback rules (invalid customs dropped, unknown `activeThemeId` → `default`, order dedupe). This removes the untyped input, the three `try/catch` blocks (which swallow defects), and fixes the Encoded-side `unknown` that degrades the desktop JSON codec typing. **Patch schema**: `ClientSettingsPatch.appearance` uses the Wire struct directly (strict decode, no normalize-to-default) so malformed input rejects — normalization is a full-settings decode concern, not a patch concern.
- **Token aliasing direction**: set `--font-mono: var(--app-mono-font-family)` and `--font-sans: var(--app-ui-font-family)` in `index.css`'s `@theme`/`:root`, deleting the duplicated literal stacks. Alternative (rewriting 17 files off `font-mono` utilities) rejected — churn without benefit.
- **Logic extraction**: `AppearanceSettings.logic.ts` gets `clampInt`, `fontOptionLabel`, `getFontSizeDefaults`, option constants, and a `createDebouncedCommit` state machine consumed by a thin `useDebouncedCommit` hook; both `FontSizeControl` and `ColorField` use it. Prefer wrapping `Debouncer` from `@tanstack/react-pacer` (already used in `apps/web/src/lib/storage.ts`) with the flush-on-unmount semantics the controls need.
- **Case rule**: drop the `/i` flag from the `AppearanceThemeId` pattern (~settings.ts L66-69). UI-generated slugs are already lowercase (`appearanceThemes.ts:276-283`); decode discards any legacy uppercase ids (acceptable: such ids could only exist via hand-edited storage).
- **Cross-tab**: in the `storage` handler (`useTheme.ts:279-286`), also patch the client-settings snapshot's `appearance.colorScheme` via the store (no persistence echo — guard against writing back what was just read).
- **body font-size**: keep `--app-ui-font-size` but stop applying it to bare `body`; apply where the baseline had explicit sizes (or set the `:root` default so computed baseline is exactly pre-feature 16px inheritance). Decide in-code with a comment referencing plan 21's "Default = exact baseline" rule; add/adjust a CSS-behavior test if feasible, else the defaults-binding test (next) covers the variable values.
- **Defaults binding test**: a node test parses `index.css` for the `:root` `--app-*` declarations and compares against `BUILT_IN_APPEARANCE_THEMES.default` — cheap drift alarm, no runtime coupling.

## Risks / Trade-offs

- [Patch strictness could break an unknown caller] → repo-wide search shows only the settings UI dispatches appearance patches; regression test added.
- [Token aliasing changes fonts of `font-mono` elements when non-default theme active] → that is the intended fix; Default theme values are identical to the old literals so no visual change on Default.
- [Dropping uppercase theme ids on decode] → only reachable via manual storage edits; documented in the delta spec.

## Migration Plan

No stored-data migration: the Wire transform accepts the same persisted JSON. Land contracts + web changes together in one PR (types flow across packages).
