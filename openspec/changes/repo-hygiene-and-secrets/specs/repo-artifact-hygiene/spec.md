# repo-artifact-hygiene Specification

## ADDED Requirements

### Requirement: No local dev state or secrets tracked in git

The repository MUST NOT track any files under `.t3-dev/` (local dev home: SQLite state, logs, caches, secrets). The `.gitignore` entry for `.t3-dev/` SHALL be effective (no tracked exceptions).

#### Scenario: Dev state files are untracked

- **WHEN** `git ls-files .t3-dev/` is run
- **THEN** it outputs nothing

#### Scenario: Historical signing key is treated as compromised

- **WHEN** the local server next starts after `.t3-dev/dev/secrets/server-signing-key.bin` is deleted
- **THEN** `ServerSecretStore.getOrCreateRandom("server-signing-key", 32)` generates a fresh key and existing sessions are invalidated

### Requirement: No machine-specific scratch or unrelated artifacts

The repository root SHALL contain only standard project files (AGENTS.md, CLAUDE.md, CONTRIBUTING, LICENSE, README, config). Machine-specific handoff notes and artifacts unrelated to T3 Code MUST NOT be committed.

#### Scenario: Scratch handoff doc removed

- **WHEN** the repo tree is listed at root
- **THEN** `LOCAL_DESKTOP_HANDOFF.md` does not exist

#### Scenario: Unrelated artifact removed

- **WHEN** `docs/` is listed
- **THEN** `magic-world-reference-atlas.html` does not exist

### Requirement: Canonical agent-skill directories

Agent-skill definitions SHALL exist only in `.claude/`, `.cursor/`, and `.codex/`. Other agent-tool mirror directories MUST be removed to prevent unmaintained drift.

#### Scenario: Mirror directories pruned

- **WHEN** the repo tree is listed
- **THEN** `.roo/`, `.kiro/`, `.kilocode/`, `.github/skills/`, `.github/prompts/`, `.continue/`, `.clinerules/`, and `.cline/` do not exist

#### Scenario: Kept directories remain intact

- **WHEN** `.claude/skills/`, `.cursor/`, and `.codex/` are listed
- **THEN** their skill/command files are unchanged by this change
