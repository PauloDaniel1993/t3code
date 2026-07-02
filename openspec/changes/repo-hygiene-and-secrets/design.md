# Design — repo-hygiene-and-secrets

## Context

Commit `29e662fc` first committed `.t3-dev/` (including `dev/secrets/server-signing-key.bin`, SQLite state, an 11k-line trace log) and `docs/magic-world-reference-atlas.html`; commit `40d0ff1c` added root-level `LOCAL_DESKTOP_HANDOFF.md`. The `.t3-dev/` untracking (`git rm -r --cached`) is already staged in the working tree but uncommitted. Ten agent-tool directories carry hand-copied duplicates of the OPSX skills; a later edit/revert cycle (`917b2f95` → `b1a54bc2`) proved they drift.

## Goals / Non-Goals

**Goals:**

- Remove all dev-state/secret/scratch/unrelated artifacts from the git index.
- Rotate the exposed dev signing key.
- Reduce skill mirrors to the three directories actually used (`.claude/`, `.cursor/`, `.codex/`).

**Non-Goals:**

- History rewriting (`git filter-repo`). The key stays in history; rotation makes it worthless. Scrubbing can be a follow-up if the fork is ever published.
- Adding a mirror-sync script (only three dirs remain; revisit if drift recurs).

## Decisions

- **Rotate by deletion, not manual generation**: `apps/server/src/auth/SessionStore.ts:402` resolves the key via `ServerSecretStore.getOrCreateRandom("server-signing-key", 32)`, which regenerates a missing file. Deleting the local file is the whole rotation. Alternative (manual key write) rejected — bypasses the store's canonical path handling.
- **Prune instead of sync-script**: user decision. Keeping `.claude/`, `.cursor/`, `.codex/` only. Residual risk: those three can still drift; accepted, documented here.
- **One hygiene commit**: all deletions + the staged untracking land in a single commit with a descriptive message, separate from any feature work.

## Risks / Trade-offs

- [Old key recoverable from history] → rotation invalidates it; document that it must never be reused. History scrub deferred.
- [Local sessions dropped on key rotation] → acceptable for a dev instance; users just sign in again.
- [Other agent tools lose local skills] → intentional; re-add per-tool copies only when a tool is actually adopted.
