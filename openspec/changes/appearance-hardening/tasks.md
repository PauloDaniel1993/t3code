# Tasks — appearance-hardening

## 1. Contracts: Wire-struct decode + strict patch

- [ ] 1.1 In `packages/contracts/src/settings.ts` (~L190-288): define `AppearanceThemeWire`/`AppearanceSettingsWire` `Schema.Struct`s with `Schema.optionalKey` fields mirroring the persisted shape (copy the `SidebarOrganizationWire` pattern in the same file, ~L307-379).
- [ ] 1.2 Replace the current `Schema.Unknown`-input transform: new transform takes the Wire struct, applies existing rules — drop invalid custom themes (bad colors/sizes/density/variants), drop built-in id collisions, dedupe `customThemeOrder`, fall back `activeThemeId` → `"default"` when unknown. Delete `isRecord` and the three `try/catch` + `decodeUnknownSync` wrappers (~L190-216).
- [ ] 1.3 Drop the `/i` flag from the `AppearanceThemeId` regex (~L66-69) so ids are lowercase-only; keep the collision filter as-is (now consistent).
- [ ] 1.4 In `ClientSettingsPatch` (~L949): change `appearance: Schema.optionalKey(AppearanceSettings)` to use the strict Wire struct (or `AppearanceSettings` with the normalizing transform bypassed) so malformed patches REJECT. Add a clarifying comment (precedent: the `providerInstances` whole-replace comment, ~L528-531).
- [ ] 1.5 Tests in `packages/contracts/src/settings.test.ts`: (a) malformed `appearance` patch fails decode and (integration-style) custom themes survive; (b) full-settings decode still discards invalid customs and falls back activeThemeId; (c) custom theme id `"Default"` is discarded; (d) round-trip encode no longer produces `unknown` (type-level: assert the Encoded type is structural).

## 2. Font-token unification

- [ ] 2.1 In `apps/web/src/index.css`: set `--font-mono: var(--app-mono-font-family)` and `--font-sans: var(--app-ui-font-family)` at the token definition site; delete the now-duplicated literal font stacks (keep the literals only as the `--app-*` `:root` fallbacks).
- [ ] 2.2 Revert `DiffPanel`'s CSS to whichever single token chain remains canonical (it currently reads the new var directly — fine if kept consistent).
- [ ] 2.3 Manual check (or snapshot test): with a custom theme mono font active, an element with class `font-mono` computes the theme font.

## 3. Settings panel logic extraction

- [ ] 3.1 Create `apps/web/src/components/settings/AppearanceSettings.logic.ts`: move `clampInt` (AppearanceSettings.tsx ~L153), `fontOptionLabel` (~L160), `getFontSizeDefaults` (~L167), option constants, and a `createDebouncedCommit(commit, delayMs)` helper with `set/flush/cancel` (wrap `Debouncer` from `@tanstack/react-pacer` — see usage in `apps/web/src/lib/storage.ts` — preserving flush-on-unmount).
- [ ] 3.2 Replace the two hand-rolled debounce implementations in `FontSizeControl` (~L204-244, 180ms) and `ColorField` (~L317-383, 250ms) with a `useDebouncedCommit` hook built on 3.1; keep the live CSS-var preview path (direct `documentElement.style.setProperty`) unchanged.
- [ ] 3.3 Create `AppearanceSettings.logic.test.ts` covering: clamp bounds, font default resolution per plan ranges (UI 12-20, chat 13-24, code 11-22, terminal 11-22), debounce set→flush ordering, cancel-on-unmount, invalid hex rejection message (move `validateHexColor` usage seam here if needed).

## 4. Correctness fixes

- [ ] 4.1 `apps/web/src/appearance/appearanceThemes.ts` (~L325-359): `duplicateAppearanceTheme` calls `validateAppearanceThemeOrThrow` on the copy before persisting; test duplicating an invalid-contrast theme throws.
- [ ] 4.2 Same file: replace the local `HEX_COLOR_PATTERN` (~L65) with `Schema.is(HexColor)` from contracts; replace the hardcoded `"default"` in `deleteCustomAppearanceTheme` (~L399) with `DEFAULT_APPEARANCE_ACTIVE_THEME_ID`.
- [ ] 4.3 `apps/web/src/hooks/useTheme.ts` (~L279-286): on `storage` events for the mirror key, also reconcile `appearance.colorScheme` into the client-settings store (update snapshot without re-persisting/echoing). Test in `useTheme.test.ts`: simulated storage event updates both DOM class and `useTheme().theme`.
- [ ] 4.4 Dedupe legacy parsing: export `THEME_STORAGE_KEY` and `readThemePreference` from `useTheme.ts` (or a small `apps/web/src/appearance/legacyTheme.ts`); `appearanceMigration.ts` (~L12-23) imports them instead of its own copy. `index.html`'s inline bootstrap stays (cannot import).
- [ ] 4.5 `index.css`: resolve the `body { font-size: var(--app-ui-font-size) }` baseline break per design (scope it or make Default compute to the pre-feature baseline); comment why, referencing plan 21 "Default = exact baseline".
- [ ] 4.6 Add the defaults-binding test (e.g. `apps/web/src/appearance/appearanceCss.test.ts`): parse `index.css` `:root` `--app-*` declarations and assert equality with `BUILT_IN_APPEARANCE_THEMES.default` fonts/sizes/density.

## 5. Plan + gates

- [ ] 5.1 Update `.plans/21-appearance-settings-profiles.md` (Interim Notes) with: strict patch semantics, token aliasing, logic extraction — per AGENTS.md's same-change plan-update rule.
- [ ] 5.2 `vp check` and `vp run typecheck` pass; run web tests (`vp test run` in `apps/web`); server-suite Windows limitation (`spawn EFTYPE`) → WSL/CI if server files touched (they should not be).
