# appearance-themes Specification (delta)

## ADDED Requirements

### Requirement: Malformed appearance patches are rejected

Decoding a `ClientSettingsPatch` whose `appearance` value is structurally invalid SHALL fail with a decode error. It MUST NOT coerce to defaults. Custom themes SHALL never be lost as a side effect of a bad patch.

#### Scenario: Garbage patch rejected

- **WHEN** a patch is applied with `appearance` set to a non-conforming value (e.g. `{"customThemes": 42}`)
- **THEN** the patch decode fails and previously persisted custom themes remain intact

#### Scenario: Valid partial state still normalizes

- **WHEN** persisted full settings contain individually invalid custom themes or an unknown `activeThemeId`
- **THEN** full-settings decode (not patch) discards the invalid entries and falls back to the built-in `default` theme, as before

### Requirement: Theme fonts apply to utility-classed elements

The Tailwind font tokens SHALL derive from the appearance variables (`--font-mono` from `--app-mono-font-family`, `--font-sans` from `--app-ui-font-family`) so elements using `font-mono`/`font-sans` utilities render with the active theme's fonts.

#### Scenario: Custom mono font reaches font-mono elements

- **WHEN** a custom theme sets a distinct `monoFontFamily` and is activated
- **THEN** an element with class `font-mono` computes that font family

### Requirement: Theme ids are case-collision-safe

Custom theme ids SHALL NOT collide with built-in ids under case-insensitive comparison. The id schema and the collision filter MUST use the same case rules.

#### Scenario: Uppercase built-in shadow discarded

- **WHEN** persisted settings contain a custom theme with id `Default`
- **THEN** decode discards it as a built-in collision

### Requirement: Theme duplication validates before persist

`duplicateAppearanceTheme` SHALL run the same validation as theme updates (including the 4.5:1 contrast requirement) before persisting the copy.

#### Scenario: Duplicating an invalid theme is blocked

- **WHEN** a stored custom theme with failing contrast is duplicated
- **THEN** the operation throws the validation error and persists nothing

### Requirement: Cross-tab color scheme reconciliation

When another tab changes the color scheme, the receiving tab SHALL update both the applied DOM class and its client-settings snapshot so `useTheme().theme` matches what is displayed.

#### Scenario: Second tab stays consistent

- **WHEN** tab A calls `setTheme("dark")` and tab B receives the `storage` event
- **THEN** tab B applies the dark class and `useTheme().theme` in tab B reports `dark`

### Requirement: Single legacy theme-preference parser

Exactly one exported function SHALL parse the legacy `t3code:theme` localStorage value; `useTheme` and `appearanceMigration` MUST both use it (the inline `index.html` bootstrap copy is exempt — it cannot import modules).

#### Scenario: Parser reused

- **WHEN** the codebase is searched for `t3code:theme` handling in TypeScript modules
- **THEN** one shared constant + parser is imported by all module consumers

### Requirement: Default theme preserves the visual baseline

With the built-in `default` theme active, root-level typography SHALL match the pre-appearance baseline; the `:root` fallback values of `--app-*` variables SHALL equal `BUILT_IN_APPEARANCE_THEMES.default`, enforced by a test.

#### Scenario: Baseline body typography

- **WHEN** the `default` theme is active
- **THEN** unclassed body text renders as it did before the appearance feature (no unintended global font-size change)

#### Scenario: CSS/TS defaults bound

- **WHEN** the defaults-binding test runs
- **THEN** it fails if `:root` `--app-*` values in `index.css` diverge from `BUILT_IN_APPEARANCE_THEMES.default`
