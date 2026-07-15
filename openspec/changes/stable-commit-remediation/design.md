# Design — stable-commit-remediation

## Context

Commit `40d0ff1c` mixed local-install tooling, a reveal-in-file-manager feature, sidebar category UI, a terminal font setting, HTTP cache headers, and a panel-width change into one commit labeled "stable". The reveal feature, cache headers, and sidebar UI are sound (sidebar extraction is handled by `sidebar-categories-fixes`); this change remediates the four defective clusters. History is not rewritten — fixes land as new commits.

## Goals / Non-Goals

**Goals:**

- Restore the deliberate preview clamp safeguard.
- One install-metadata code path.
- Ship neutral defaults in shared contracts.
- Test the destructive install-script path.

**Non-Goals:**

- Splitting/rewording the historical commit (would require history rewrite).
- Changing the reveal-in-file-manager feature or HTTP cache header behavior.
- Redesigning the local-install workflow.

## Decisions

- **Restore, don't parameterize, the clamp**: re-add `PREVIEW_PANEL_MAX_WIDTH_PX = 1400` and `useViewportClampedMaxWidth` to `PreviewPanelShell.tsx` as they existed at baseline `82a9bcc7` (retrieve via `git show 82a9bcc7 -- apps/web/src/components/preview/PreviewPanelShell.tsx`). `useResizableWidth`'s optional `maxWidth` can stay optional (harmless generality) but the preview call site must pass the clamp. Alternative (make unlimited width a setting) rejected — no demand; the original comment documents the safeguard's purpose.
- **Metadata helper location**: export `readLocalInstallMetadata` (and the stateDir derivation) from `apps/desktop/src/app/DesktopEnvironment.ts` (it already has the Schema-validated implementation); `main.ts`'s early path calls it with a synchronous FS adapter. If the early-bridge truly cannot await Effect, extract the pure parse (`parseLocalInstallMetadata(jsonText)`) into a small shared module both use — the pure function is the single source of truth; the wrappers differ only in IO.
- **Font default**: `DEFAULT_TERMINAL_FONT_FAMILY = '"JetBrains Mono", "Cascadia Code", Consolas, Menlo, monospace'` (short, cross-platform, no Nerd Font variants). Existing user settings decode unchanged (`TerminalFontFamily` schema untouched). Note in `.plans/21` interim notes (which already anticipated migrating this value).
- **Install-script tests**: refactor `replaceInstallDir` to accept an injectable FS facade (rename/rm/mkdir/backup ops) so retry/backup/restore is unit-testable without touching the real filesystem; keep `INSTALL_REPLACE_ATTEMPTS`/delay as exported constants asserted in tests. Follows the existing pattern of the script's pure render helpers already under test.

## Risks / Trade-offs

- [Clamp restoration changes behavior for anyone relying on ultra-wide panels] → intended reversion of an undocumented regression; the clamp value matches the pre-fork baseline.
- [Font default change alters fresh-install visuals] → only affects users without an explicit setting; personal stacks belong in user settings.
- [FS-facade refactor of a working script] → covered by new unit tests plus an unchanged-behavior smoke run of `pnpm install:desktop` locally.
