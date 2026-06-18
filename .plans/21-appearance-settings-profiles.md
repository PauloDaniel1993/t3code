# Appearance Settings Profiles

## Goal

Add a dedicated Appearance settings area where users can manage named visual profiles for T3 Code. Profiles should cover theme mode, typography, font sizes, density, and app accent color while preserving the current predictable settings behavior.

## Product Decisions

- Add a new `/settings/appearance` page and sidebar item.
- Move the existing Theme control out of General and into Appearance.
- Support named appearance profiles from the first version.
- Built-in profiles are immutable templates: `Default`, `Readable`, `Compact`, and `Terminal`.
- Custom profiles are client-local and editable.
- Appearance settings apply live and persist immediately.
- V1 supports accent color customization only, not full background/text palette editing.
- Provider accent colors remain provider identity markers and are not affected by app accent color.
- Global restore defaults resets the active profile to `Default` but does not delete custom profiles.

## Non-Goals

- No full arbitrary palette editor in v1.
- No import/export UI in v1.
- No synced appearance settings through the server environment.
- No broad refactor of every Tailwind `text-*` class in the app.
- No custom font loading or webfont download management.

## Spec 1: Client Settings Contract

### Scope

Extend client-only settings with an `appearance` object in `packages/contracts/src/settings.ts`.

### Data Model

```ts
appearance: {
  activeProfileId: string;
  profileOrder: string[];
  profiles: Record<string, AppearanceProfile>;
}

AppearanceProfile: {
  id: string;
  name: string;
  colorScheme: "system" | "light" | "dark";
  uiFontFamily: string;
  monoFontFamily: string;
  uiFontSizePx: number;
  chatFontSizePx: number;
  codeFontSizePx: number;
  terminalFontSizePx: number;
  density: "compact" | "default" | "comfortable";
  accentColor: string;
}
```

### Requirements

- Decode missing appearance settings to a complete default state.
- Keep settings client-local through the existing `useSettings` persistence path.
- Validate font-size ranges:
  - UI: 12-18
  - Chat: 13-20
  - Code: 11-18
  - Terminal: 11-20
- Validate persisted accent color as strict `#RRGGBB`.
- Ensure bad or missing active profile IDs fall back to `Default`.

### Deliverables

- Contract schema additions.
- Default appearance constants.
- Contract tests for default decoding, bounds, and custom profile round-trip.

### Exit Criteria

- Existing client settings still decode.
- Appearance settings decode from `{}` with no migration script required.

## Spec 2: Appearance Domain Logic

### Scope

Create focused helper logic for manipulating appearance profiles.

### Requirements

- Resolve the effective active profile from settings.
- Duplicate built-in or custom profiles into a new custom profile.
- Rename custom profiles.
- Delete custom profiles only.
- If the active custom profile is deleted, switch to `Default`.
- Preserve user profile order.
- Clamp unsafe runtime values before applying CSS variables.
- Validate custom accent color before persistence.

### Recommended Location

Start in `apps/web/src/appearance` unless a helper is needed by server/desktop code. Keep `packages/contracts` schema-only.

### Deliverables

- `appearanceProfiles.ts` or equivalent domain module.
- Unit tests for profile operations and fallback behavior.

### Exit Criteria

- Profile behavior is testable without rendering React.

## Spec 3: Theme Migration And Hook Compatibility

### Scope

Move the current `t3code:theme` behavior into appearance settings without breaking existing call sites.

### Requirements

- Preserve the `useTheme()` API shape:
  - `theme`
  - `resolvedTheme`
  - `setTheme`
- Back `theme` with the active appearance profile's `colorScheme`.
- On first hydration, migrate old `localStorage["t3code:theme"]` into the active profile when appearance settings are missing.
- Delete the old key only after successful settings persistence.
- Continue syncing Electron chrome through `desktopBridge.setTheme`.
- Continue suppressing transitions while theme changes apply.

### Deliverables

- Updated `useTheme.ts`.
- Migration helper or integration inside client settings hydration.
- Tests where practical for old-key migration and `setTheme`.

### Exit Criteria

- Existing components using `useTheme()` do not need behavior changes.
- Existing users keep their light/dark/system preference.

## Spec 4: Runtime CSS Variable Application

### Scope

Apply the active appearance profile to root CSS variables.

### Requirements

- Apply variables to `document.documentElement`.
- Do not change global `html { font-size }`.
- Add variables:
  - `--app-ui-font-family`
  - `--app-mono-font-family`
  - `--app-ui-font-size`
  - `--app-chat-font-size`
  - `--app-code-font-size`
  - `--app-terminal-font-size`
  - `--app-density-scale`
  - `--app-density-gap`
  - `--app-density-padding-y`
- Override accent-related tokens:
  - `--primary`
  - `--ring`
  - `--primary-foreground`
- Derive primary foreground automatically from accent contrast.
- Keep `--info`, `--success`, `--warning`, and `--destructive` unchanged.

### Initial CSS Surfaces

- `body` uses `--app-ui-font-family` and `--app-ui-font-size`.
- `pre`, `code`, markdown inline code, code blocks, and file links use `--app-mono-font-family` and code size where appropriate.
- Chat markdown uses `--app-chat-font-size`.
- Terminal/xterm surfaces use `--app-mono-font-family` and `--app-terminal-font-size`.
- Settings rows and key chat surfaces can opt into density variables.

### Deliverables

- CSS variable application helper.
- `index.css` updates for typography and density variables.

### Exit Criteria

- Changing active profile updates visible typography/accent without reload.

## Spec 5: Appearance Settings Route

### Scope

Add a first-class settings page for appearance.

### Requirements

- Add `/settings/appearance` route.
- Add Appearance nav item after General.
- Move Theme out of General into Appearance.
- Keep General restore-default behavior correct after moving Theme.
- Use existing settings layout components.

### Page Structure

1. Profile
   - Active profile selector
   - Duplicate button
   - Rename control for custom profiles
   - Delete button for custom profiles
2. Theme
   - System / Light / Dark
3. Typography
   - UI font
   - Mono font
   - UI font size
   - Chat font size
   - Code font size
   - Terminal font size
4. Density
   - Compact / Default / Comfortable
5. Accent
   - Swatches
   - Custom hex input
6. Preview
   - Sample UI text
   - Sample chat text
   - Inline code
   - Code block
   - Accent button

### Deliverables

- `settings.appearance.tsx`.
- Appearance panel/component.
- Sidebar nav update.
- General panel cleanup.

### Exit Criteria

- Built-ins are selectable but not directly editable.
- Custom profiles can be selected and edited live.

## Spec 6: Controls And Validation UX

### Scope

Define the concrete settings controls and validation behavior.

### Requirements

- Use existing UI primitives where possible.
- Use selects/comboboxes for curated font choices.
- Use `NumberField` for font sizes.
- Use segmented-style controls or select for density.
- Use swatches plus a strict hex input for accent color.
- Show validation feedback for invalid hex and avoid persisting invalid values.
- Keep controls disabled for built-in profiles with a clear Duplicate action.
- Duplicate profile names are allowed; default duplicate name should append `copy`.

### Font Choices

UI fonts:

- DM Sans
- System
- Inter
- Segoe UI
- Atkinson Hyperlegible

Mono fonts:

- System Mono
- Cascadia Code
- JetBrains Mono
- Consolas
- SF Mono

### Accent Swatches

Start with a small set of accessible, visually distinct swatches:

- Current default violet/blue
- Blue
- Emerald
- Amber
- Rose
- Neutral

### Deliverables

- Reusable appearance controls if the component grows.
- Validation helper tests for hex and font-size bounds.

### Exit Criteria

- Invalid inputs do not corrupt persisted settings.
- Keyboard and screen reader labels are present for all controls.

## Spec 7: Restore Defaults And Profile Lifecycle

### Scope

Integrate appearance into reset flows without destroying user-created work.

### Requirements

- Global Restore defaults resets active profile to `Default`.
- Global Restore defaults does not delete custom profiles.
- Per-setting reset buttons should reset editable custom profile fields to the corresponding `Default` field where appropriate.
- Built-in profile controls use Duplicate rather than per-field reset.
- Deleting the active custom profile switches active profile to `Default`.

### Deliverables

- Updated `useSettingsRestore`.
- Reset labels include Appearance when the active profile is not `Default` or custom profile values differ from defaults.

### Exit Criteria

- Restore behavior is predictable and non-destructive.

## Spec 8: Verification And Tests

### Required Automated Checks

- `vp check`
- `vp run typecheck`

### Test Coverage

- Contract decode/default tests.
- Appearance helper tests:
  - duplicate built-in
  - duplicate custom
  - rename custom
  - reject rename/edit for built-in
  - delete custom
  - active fallback after delete
  - invalid accent rejection
- Theme migration tests where practical.
- Browser/settings test for:
  - Appearance nav item renders
  - profile selection updates CSS variables
  - built-in profile controls are read-only
  - duplicated profile can be edited

### Manual Verification

- Start dev server.
- Open `/settings/appearance`.
- Check desktop and browser modes if practical.
- Verify text does not overflow controls on mobile and desktop widths.
- Verify accent color updates focus/ring/button states.
- Verify light/dark/system still work.

### Exit Criteria

- Automated gates pass.
- Appearance page works in a running app.
- No regression to existing General settings behavior.

## Implementation Order

1. Contract schema and defaults.
2. Appearance domain helpers and tests.
3. Theme migration and `useTheme` compatibility.
4. CSS variable application.
5. Appearance route and nav.
6. Profile controls.
7. Typography, density, accent controls.
8. Preview panel.
9. Restore defaults integration.
10. Browser tests and final verification.

