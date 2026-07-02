# appearance-themes Specification

## Purpose

Defines client-local Appearance themes for T3 Code, including built-in and custom theme lifecycle, global theme mode, light/dark color variants, typography, density, migration, runtime CSS application, settings UI, and verification.

## Requirements

### Requirement: Persist appearance settings locally

The system SHALL store Appearance settings in client-local settings under `appearance`. Appearance settings SHALL include global color scheme mode, active theme id, custom theme order, and custom theme records.

#### Scenario: Missing appearance settings

- **WHEN** client settings decode without an `appearance` field
- **THEN** the decoded settings include a complete default Appearance state
- **AND** the active theme resolves to built-in `Default`

#### Scenario: Invalid active theme id

- **WHEN** the saved active theme id does not refer to a built-in or custom theme
- **THEN** the active theme resolves to built-in `Default`

#### Scenario: Invalid custom theme

- **WHEN** a custom theme record has invalid colors, font sizes, density, variant data, or id shape
- **THEN** that custom theme is discarded during decode
- **AND** remaining valid themes remain available

### Requirement: Provide immutable built-in themes

The system SHALL provide built-in themes `Default`, `Readable`, `Compact`, and `Terminal` as immutable templates. `Default` SHALL represent the current T3 Code baseline.

#### Scenario: Select built-in theme

- **WHEN** the user selects a built-in theme
- **THEN** the active theme changes immediately
- **AND** controls show the built-in values as read-only

#### Scenario: Duplicate built-in theme

- **WHEN** the user duplicates a built-in theme
- **THEN** the system creates a custom editable theme with equivalent values
- **AND** selects the new custom theme

#### Scenario: Restore Appearance defaults

- **WHEN** the user restores Appearance defaults
- **THEN** the active theme switches to built-in `Default`
- **AND** custom themes are preserved

### Requirement: Manage custom themes

The system SHALL allow custom themes to be created by duplicating an existing built-in or custom theme. Custom themes SHALL be editable, renameable, and deletable.

#### Scenario: Duplicate custom theme

- **WHEN** the user duplicates a custom theme
- **THEN** the new theme has the same values and a copy-style name
- **AND** receives a generated custom id

#### Scenario: Rename custom theme

- **WHEN** the user renames a custom theme to a non-empty name
- **THEN** the custom theme name updates

#### Scenario: Delete active custom theme

- **WHEN** the user deletes the active custom theme
- **THEN** the active theme switches to built-in `Default`

#### Scenario: Attempt to edit built-in theme

- **WHEN** code attempts to mutate, rename, or delete a built-in theme
- **THEN** the operation is rejected or ignored without changing the built-in

### Requirement: Apply global color scheme mode

The system SHALL expose a global `system | light | dark` mode. The existing `useTheme()` hook SHALL preserve its API shape and return `theme`, `resolvedTheme`, and `setTheme`.

#### Scenario: Set theme mode

- **WHEN** a caller invokes `setTheme("dark")`
- **THEN** `appearance.colorScheme` updates to `dark`
- **AND** `useTheme().theme` returns `dark`
- **AND** Electron chrome is synced through `desktopBridge.setTheme("dark")` when available

#### Scenario: System mode changes

- **WHEN** color scheme mode is `system` and the OS/browser preference changes
- **THEN** the resolved theme changes
- **AND** the document `dark` class updates

#### Scenario: Bootstrap mirror

- **WHEN** color scheme mode changes
- **THEN** the system writes the same value to `localStorage["t3code:theme"]`
- **AND** `index.html` can use that key for pre-React light/dark bootstrap

### Requirement: Migrate legacy visual settings

The system SHALL migrate legacy theme mode and terminal font settings without mutating built-in `Default`.

#### Scenario: Legacy mode only

- **WHEN** no Appearance settings exist and `t3code:theme` stores a non-default mode
- **THEN** the system creates and activates a custom `Migrated` theme only if needed
- **AND** stores the legacy mode in `appearance.colorScheme`

#### Scenario: Legacy terminal font

- **WHEN** no Appearance settings exist and `terminalFontFamily` differs from the default stack
- **THEN** the system creates and activates a custom `Migrated` theme using that terminal/mono font

#### Scenario: Legacy defaults

- **WHEN** no Appearance settings exist and all legacy values match defaults
- **THEN** the system activates built-in `Default` without creating a custom theme

### Requirement: Support typography and density customization

The system SHALL support configurable UI, chat, code, and terminal font sizes, curated UI and mono font choices, custom mono/terminal font family lists, and density per theme.

#### Scenario: Font size bounds

- **WHEN** persisted font sizes are outside supported bounds
- **THEN** decoding rejects or clamps them to safe values before runtime application

#### Scenario: Font size slider update

- **WHEN** the user changes a font size slider
- **THEN** visible text updates live
- **AND** the numeric pixel value is visible and editable
- **AND** persistence is debounced

#### Scenario: Terminal font application

- **WHEN** terminal font family or terminal font size changes
- **THEN** open xterm terminals update their options and refit safely

### Requirement: Support light and dark color variants

The system SHALL allow editable custom themes to define light and dark variants with accent, background, foreground, surface, muted, contrast, and translucent sidebar values. Secondary tokens SHALL be derived at runtime.

#### Scenario: Edit valid custom color

- **WHEN** the user enters a valid `#RRGGBB` color for an editable custom theme
- **THEN** the system persists the color
- **AND** updates CSS variables without reload

#### Scenario: Invalid color input

- **WHEN** the user enters an invalid color
- **THEN** the system shows inline validation feedback
- **AND** does not persist the invalid value

#### Scenario: Unsafe contrast

- **WHEN** a foreground/background or primary foreground combination fails minimum contrast
- **THEN** the system blocks persistence and explains the issue

#### Scenario: Status colors remain stable

- **WHEN** a custom theme is active
- **THEN** `success`, `warning`, `destructive`, and `info` semantic colors remain controlled by T3 Code defaults

### Requirement: Apply appearance through CSS variables

The system SHALL apply active Appearance values to `document.documentElement` CSS variables and semantic tokens.

#### Scenario: Active theme changes

- **WHEN** the active theme changes
- **THEN** the app updates typography, density, accent, core surface colors, and resolved light/dark variant values without reload

#### Scenario: Default theme active

- **WHEN** built-in `Default` is active
- **THEN** the app visually matches the current T3 Code baseline

#### Scenario: Browser chrome sync

- **WHEN** theme variables are applied
- **THEN** browser chrome/theme color synchronization continues to use the current visible surface color

### Requirement: Provide Appearance settings UI

The web UI SHALL expose `/settings/appearance` after General in Settings navigation. The page SHALL use existing settings layout components and T3 visual style.

#### Scenario: Appearance nav item

- **WHEN** the user opens Settings
- **THEN** the sidebar includes `Appearance` after `General`
- **AND** `/settings/appearance` renders the Appearance settings page

#### Scenario: Built-in read-only controls

- **WHEN** a built-in theme is selected
- **THEN** Appearance controls show values but are disabled
- **AND** a Duplicate/Copy theme action is available

#### Scenario: Custom editable controls

- **WHEN** a custom theme is selected
- **THEN** controls are enabled
- **AND** edits apply live with validation

#### Scenario: Appearance preview

- **WHEN** the Appearance page renders
- **THEN** it shows a lightweight preview containing settings text, chat text, inline code, a code block, a diff sample, a terminal sample, and an accent button

### Requirement: Preserve existing settings behavior

The system SHALL move Theme and Terminal font controls from General to Appearance while preserving restore-default behavior.

#### Scenario: General settings visual controls removed

- **WHEN** the user opens General settings
- **THEN** Theme and Terminal font controls are not shown there
- **AND** non-appearance General settings remain unchanged

#### Scenario: Restore defaults on Appearance

- **WHEN** the user uses Restore defaults on Appearance
- **THEN** active Appearance returns to built-in `Default`
- **AND** custom themes are not deleted

### Requirement: Defer syntax and full annotation theme customization

The system SHALL NOT implement syntax theme selection or full desktop preview annotation token mapping in v1.

#### Scenario: Code highlighting remains stable

- **WHEN** the user edits an Appearance theme
- **THEN** code font, size, and surrounding chrome may update
- **AND** syntax theme selection remains unchanged

#### Scenario: Preview annotation basic sync

- **WHEN** desktop preview annotation overlays use existing app theme variables
- **THEN** they continue receiving basic app theme sync
- **AND** full token mapping is deferred to a follow-up OpenSpec change
