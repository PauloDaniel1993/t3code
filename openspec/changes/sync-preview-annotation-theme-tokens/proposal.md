## Why

Appearance themes in v1 synchronize app-level CSS variables and browser/desktop chrome, but desktop preview annotation overlays still rely on their existing limited token bridge. Full annotation theming needs its own change because it crosses desktop preview rendering, overlay tokens, and annotation contrast behavior.

## What Changes

- Define the preview annotation token map required for custom Appearance themes.
- Sync relevant Appearance colors and typography to desktop preview annotation overlays.
- Preserve readable defaults for built-in `Default`, `Readable`, `Compact`, and `Terminal`.
- Add validation so annotation foreground, background, focus, selection, and destructive states remain legible.
- Keep v1 basic app theme sync behavior stable until the full token map lands.

## Impact

- Affected areas:
  - desktop preview annotation overlay styling
  - app-to-preview theme synchronization
  - `apps/web/src/appearance` runtime helpers
  - preview annotation tests and manual verification
- Required verification:
  - focused token mapping tests where practical
  - manual desktop preview annotation checks in light/dark custom themes
  - `vp check`
  - `vp run typecheck`
