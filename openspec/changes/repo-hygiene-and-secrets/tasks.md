# Tasks — repo-hygiene-and-secrets

## 1. Verify preconditions

- [ ] 1.1 Run `git status --short` and confirm the 13 `.t3-dev/` deletions are staged (`D  .t3-dev/...`). If not staged, run `git rm -r --cached .t3-dev/` (keeps local files).
- [ ] 1.2 Run `git ls-files .t3-dev/` — must output nothing after 1.1.
- [ ] 1.3 Confirm `.gitignore` contains a `.t3-dev/` line (it does, line 19 at time of writing).

## 2. Rotate the dev signing key

- [ ] 2.1 Delete the local file `.t3-dev/dev/secrets/server-signing-key.bin` from disk (it is already untracked; this deletes the compromised local copy). PowerShell: `Remove-Item .t3-dev/dev/secrets/server-signing-key.bin -Force -Confirm:$false`.
- [ ] 2.2 Start the dev server once (`pnpm dev:server:local`) and confirm it boots — `ServerSecretStore.getOrCreateRandom("server-signing-key", 32)` (used from `apps/server/src/auth/SessionStore.ts:402`) regenerates the key. Stop the server afterwards.

## 3. Delete stray artifacts

- [ ] 3.1 `git rm LOCAL_DESKTOP_HANDOFF.md` (root-level machine-specific scratch doc added in `40d0ff1c`).
- [ ] 3.2 `git rm docs/magic-world-reference-atlas.html` (unrelated 1,518-line artifact added in `29e662fc`).

## 4. Prune agent-skill mirrors (keep .claude, .cursor, .codex)

- [ ] 4.1 `git rm -r .roo/ .kiro/ .kilocode/ .continue/ .clinerules/ .cline/`
- [ ] 4.2 `git rm -r .github/skills/ .github/prompts/` (leave the rest of `.github/` untouched — verify with `git status` that only `skills/` and `prompts/` under `.github/` are removed).
- [ ] 4.3 Verify kept dirs are untouched: `git status` shows no changes under `.claude/`, `.cursor/`, `.codex/`.

## 5. Commit and verify

- [ ] 5.1 Create one commit containing: the `.t3-dev/` untracking, both artifact deletions, and the mirror pruning. Suggested message: `Remove tracked dev state, secrets, scratch docs, and stale skill mirrors`.
- [ ] 5.2 Verify spec scenarios: `git ls-files .t3-dev/` empty; `LOCAL_DESKTOP_HANDOFF.md` and `docs/magic-world-reference-atlas.html` absent; pruned dirs absent; `.claude/ .cursor/ .codex/` intact.
- [ ] 5.3 Run required gates: `vp check` and `vp run typecheck` (both must pass; no code changed so failures indicate an unrelated problem). Note: `vp test` largely cannot run on Windows (`spawn EFTYPE`) — run in WSL/CI if needed.
