# Stable Commit Remediation

## Why

Commit `40d0ff1c` ("stable") bundled six unrelated concerns; four carry defects the audit flagged: it silently deleted the preview panel's max-width safeguard (whose comment explained it exists so "a wide monitor can't yield a panel that swallows the chat"), duplicated install-metadata parsing between `apps/desktop/src/main.ts` and `DesktopEnvironment` (two sources of truth — an explicit AGENTS.md code smell), baked a ~500-character personal Nerd Font stack into shared contracts defaults, and left the riskiest new code (`replaceInstallDir` retry/backup in the install script) untested.

## What Changes

- Restore the preview-panel viewport-clamped max width (`PREVIEW_PANEL_MAX_WIDTH_PX` + `useViewportClampedMaxWidth`) in `PreviewPanelShell.tsx`.
- Deduplicate install-metadata reading: one exported helper shared by `DesktopEnvironment` and the early-bridge path in `main.ts`.
- Replace `DEFAULT_TERMINAL_FONT_FAMILY` with a short generic monospace stack; personal fonts move to user settings.
- Add tests for `replaceInstallDir` retry/backup semantics in `scripts/install-desktop-build.ts`.

## Capabilities

### New Capabilities

- `desktop-local-install`: behavior of the local desktop install tooling (metadata resolution, install-dir replacement safety) — previously implemented without a spec.

### Modified Capabilities

<!-- none with existing specs; preview clamp and font default are implementation-level restorations -->

## Impact

- `apps/web/src/components/preview/PreviewPanelShell.tsx`, `apps/web/src/hooks/useResizableWidth.ts` (clamp restoration).
- `apps/desktop/src/main.ts`, `apps/desktop/src/app/DesktopEnvironment.ts` (+ its test) — shared helper.
- `packages/contracts/src/settings.ts` (`DEFAULT_TERMINAL_FONT_FAMILY`) — visual change for users relying on the shipped Nerd Font ordering; their explicit settings are unaffected.
- `scripts/install-desktop-build.ts` + `install-desktop-build.test.ts`.
