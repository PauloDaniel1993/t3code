# Tasks — stable-commit-remediation

## 1. Restore preview-panel clamp

- [ ] 1.1 Retrieve the baseline implementation: `git show 82a9bcc7:apps/web/src/components/preview/PreviewPanelShell.tsx` and locate `PREVIEW_PANEL_MAX_WIDTH_PX` (1400) and `useViewportClampedMaxWidth` (including its explanatory comment about wide monitors).
- [ ] 1.2 Re-add both to the current `PreviewPanelShell.tsx` and pass the clamped max into the `useResizableWidth` call site (keep `useResizableWidth`'s `maxWidth` parameter optional as-is in `apps/web/src/hooks/useResizableWidth.ts`).
- [ ] 1.3 Test (extend the existing hook/component test if present, else add one near `useResizableWidth`): width requests above the viewport-derived max clamp to it.

## 2. Deduplicate install-metadata reading

- [ ] 2.1 In `apps/desktop/src/app/DesktopEnvironment.ts`: extract the pure parser `parseLocalInstallMetadata(jsonText: string)` (Schema-validated `.t3code-install.json` shape) and the stateDir derivation (`dev` vs `userdata`) as exported functions; `DesktopEnvironment.make` uses them.
- [ ] 2.2 In `apps/desktop/src/main.ts`: replace `readEarlyLocalInstallHome`'s inline `JSON.parse` + hand-rolled `trimNonEmpty` + duplicated stateDir logic with `NodeFS.readFileSync` + the shared `parseLocalInstallMetadata` + shared derivation.
- [ ] 2.3 Tests in `apps/desktop/src/app/DesktopEnvironment.test.ts`: parser accepts the canonical shape, rejects malformed JSON/fields; derivation cases (`dev`, `userdata`); add a test asserting `main.ts`'s early path and `DesktopEnvironment` produce the same home for the same metadata fixture (import both helpers).

## 3. Generic terminal font default

- [ ] 3.1 In `packages/contracts/src/settings.ts`: replace the ~500-char `DEFAULT_TERMINAL_FONT_FAMILY` Nerd Font stack with `'"JetBrains Mono", "Cascadia Code", Consolas, Menlo, monospace'`.
- [ ] 3.2 Check dependents: `apps/web/src/appearance/appearanceThemes.ts` built-in themes and `appearanceMigration.ts` compare against `DEFAULT_TERMINAL_FONT_FAMILY` — confirm the comparison semantics still hold (migration creates a `Migrated` theme only when the persisted value differs from the new default; a user who had persisted the OLD default string will now get a `Migrated` theme preserving it — acceptable and correct; note it in the migration test).
- [ ] 3.3 Update `packages/contracts/src/settings.test.ts` expectations; add the "existing user setting preserved" decode test if missing.
- [ ] 3.4 Add an interim note to `.plans/21-appearance-settings-profiles.md` documenting the default change (per AGENTS.md same-change plan-update rule).

## 4. Install-script replacement tests

- [ ] 4.1 In `scripts/install-desktop-build.ts`: refactor `replaceInstallDir` to accept an injectable FS facade (`{ rename, rm, mkdir, exists, cpBackup }`) defaulting to real `node:fs` operations; export `INSTALL_REPLACE_ATTEMPTS` and the retry delay as constants.
- [ ] 4.2 In `scripts/install-desktop-build.test.ts`: add tests — (a) transient lock: rename fails N-1 times then succeeds → completes, backup cleaned; (b) persistent failure: all attempts fail → previous install restored from backup, nonzero exit/thrown error with clear message; (c) attempts/delay constants respected (count facade calls; no real sleeps — inject a no-op delay).
- [ ] 4.3 Smoke: run `pnpm install:desktop -- --help` (or dry-run path) to confirm the script still parses args and runs.

## 5. Gates

- [ ] 5.1 `vp check` passes.
- [ ] 5.2 `vp run typecheck` passes.
- [ ] 5.3 Run touched package tests (`apps/desktop`, `apps/web`, `scripts`, `packages/contracts`) via `vp test run`; use WSL/CI where Windows `spawn EFTYPE` blocks server-style tests.
