# Repo Hygiene And Secrets

## Why

A branch audit found security-relevant artifacts committed to git: a server signing key (`.t3-dev/dev/secrets/server-signing-key.bin`, recoverable from history at commit `29e662fc`), local dev databases/logs under the gitignored `.t3-dev/` path, machine-specific scratch documentation at the repo root, an unrelated 1,518-line HTML artifact in `docs/`, and ~10 hand-copied agent-skill mirror directories with proven drift. These undermine repo trust and reviewability before any merge to `main`.

## What Changes

- Rotate the local dev server signing key (delete the file; the server regenerates it on next start). The historical key is treated as compromised.
- Commit the already-staged `.t3-dev/` untracking (13 files removed from the index via `git rm --cached`; local files kept; `.gitignore` already covers the path).
- Delete `LOCAL_DESKTOP_HANDOFF.md` (root-level machine-specific scratch state with stale branch/sha references).
- Delete `docs/magic-world-reference-atlas.html` (unrelated personal artifact).
- Prune agent-skill mirror directories: keep `.claude/`, `.cursor/`, `.codex/`; delete `.roo/`, `.kiro/`, `.kilocode/`, `.github/skills/`, `.github/prompts/`, `.continue/`, `.clinerules/`, `.cline/`.

## Capabilities

### New Capabilities

- `repo-artifact-hygiene`: Rules for what must never be tracked (dev state, secrets, scratch docs, personal artifacts) and which agent-skill directories are canonical.

### Modified Capabilities

<!-- none — no existing spec's requirements change -->

## Impact

- Git index only (deletions + untracking); no application code changes.
- Local dev sessions are invalidated once the signing key is regenerated (acceptable for a dev instance).
- Agent tooling: only `.claude/`, `.cursor/`, `.codex/` skill copies remain; other tools lose their local skill definitions.
