# desktop-local-install Specification

## ADDED Requirements

### Requirement: Single source of truth for install metadata

Local-install metadata (`.t3code-install.json`) SHALL be parsed by exactly one exported helper. Both the Electron early-bridge path (`apps/desktop/src/main.ts`) and `DesktopEnvironment` MUST use it; the state-dir derivation (`dev` vs `userdata`) SHALL likewise exist once.

#### Scenario: Helper reused

- **WHEN** the desktop app resolves its install home during early bridge setup and during environment construction
- **THEN** both paths call the same exported metadata helper and produce identical results for identical inputs

### Requirement: Install-dir replacement is safe and recoverable

`replaceInstallDir` in `scripts/install-desktop-build.ts` SHALL retry transient replacement failures a bounded number of times, SHALL preserve a backup of the previous install until the new install is in place, and SHALL restore the backup when replacement ultimately fails.

#### Scenario: Transient lock retried

- **WHEN** the target directory is temporarily locked and unlocks before retries are exhausted
- **THEN** the replacement completes and the backup is cleaned up

#### Scenario: Persistent failure restores backup

- **WHEN** replacement fails on every attempt
- **THEN** the previous install is restored from backup and the script exits with a nonzero status and a clear error

### Requirement: Preview panel width remains viewport-clamped

The preview panel SHALL clamp its maximum width to the viewport so it cannot expand to swallow the chat on wide monitors.

#### Scenario: Wide-monitor clamp

- **WHEN** the user drags the preview panel divider on a viewport wider than the clamp threshold
- **THEN** the panel width stops at the viewport-derived maximum and the chat column remains visible

### Requirement: Generic default terminal font stack

The shipped `DEFAULT_TERMINAL_FONT_FAMILY` SHALL be a short, generic monospace stack with no machine-specific font names. User-configured terminal fonts SHALL continue to decode unchanged.

#### Scenario: Fresh install default

- **WHEN** a user with no terminal font setting opens the terminal
- **THEN** the font stack contains only broadly available monospace families ending in `monospace`

#### Scenario: Existing user setting preserved

- **WHEN** a user previously persisted a custom terminal font family
- **THEN** decode returns their value unchanged
