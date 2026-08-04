---
name: merge-upstream-into-fork
description: Integrate new upstream commits into a long-lived fork branch. Covers the pre-flight analysis that sizes the job before touching history, choosing merge vs rebase, predicting conflicts with a dry-run merge, reworking fork features whose dependencies upstream replaced, and separating merge-caused test failures from pre-existing ones. Use when pulling pingdotgg/t3code (or any upstream) into a fork's long-lived branch, when a fork branch has drifted behind, or when an upstream change rewrote code a fork feature depends on.
---

# Merge upstream into a fork

This fork (`PauloDaniel1993/t3code`) carries a large delta on top of `pingdotgg/t3code`
and integrates upstream repeatedly. The expensive part is never the conflicts git reports.
It is (1) picking the wrong integration strategy, and (2) fork features whose dependency
upstream deleted underneath them — those produce zero conflict markers and a broken app.

Work in three phases: **analyse before touching history**, **integrate**, **triage**.
Do not skip phase 1. It takes minutes and decides everything after it.

Commands are POSIX shell. On Windows PowerShell: quote rev ranges (`git diff "a..b"`,
otherwise `..` is parsed as a range operator and git errors), use `$env:NAME = "value"`,
and never pipe a long-running command through `Select-String` — it buffers all output,
so a hung run looks identical to a slow one. Redirect to a file and read it instead.

## Phase 1 — Analyse

### 1.1 Establish the refs

```bash
git fetch origin --prune && git fetch upstream --prune
git fetch origin main:main          # fast-forward local main without checking it out
git switch dev && git merge --ff-only origin/dev
```

Update *both* local `main` and the fork branch first. Analysis run against a stale local
`main` measures the wrong delta and produces a plan for a job that does not exist.

Confirm the fork's `main` actually matches upstream before trusting it as the target:

```bash
git rev-list --left-right --count origin/main...upstream/main   # expect "0	0"
```

### 1.2 Prove the merge will not duplicate commits

The standard fear on a repeatedly-rebased fork is that merging re-applies commits that
past rebases already brought in. Verify rather than assume:

```bash
BASE=$(git merge-base dev main)
git merge-base --is-ancestor "$BASE" dev && echo "dev descends from the old upstream tip"
git cherry dev main | cut -c1 | sort | uniq -c    # want all '+', no '-'
```

`git cherry` marks `-` when a commit on `main` is patch-equivalent to one already on `dev`
(i.e. it would duplicate). All `+` means every incoming commit is genuinely new.

**Why this holds:** past rebases left `dev` descending from the old `main` tip, so that
commit *is* the merge base and only the new commits come across. Duplication is a
rebase/cherry-pick failure mode; a merge from a true ancestor cannot produce it.

Beware the inverse trap: `git cherry dev origin/<merged-feature-branch>` reports large
false "missing commit" counts on this fork, because merged branches sit at their
pre-rebase tips and rebasing changed their patch-ids. A nonzero count there is **not**
evidence of lost work. Compare against a known-good control ref before believing it.

### 1.3 Size the collision surface

```bash
git log --oneline --no-merges "$BASE..main"      # what upstream did
git diff --stat "$BASE..main" | tail -1
comm -12 <(git diff --name-only "$BASE..main" | sort) \
         <(git diff --name-only "$BASE..dev"  | sort)   # the overlap
```

Overlap is usually tiny relative to both sides. Record the number but **do not plan from
it** — see 1.5. Also count how many fork commits touch the overlap; that is the upper
bound on rebase conflict stops:

```bash
git log --oneline --no-merges "$BASE..dev" -- $(comm -12 ...) | wc -l
```

### 1.4 Predict the actual conflicts without touching the repo

```bash
git merge-tree --write-tree --name-only main dev
```

This performs a full three-way merge in memory and prints exactly which files conflict.
Zero mutation, seconds to run. **This is the single highest-value step in the process** —
it converts "how bad is this?" into a concrete file list before any commitment.

### 1.5 Find the semantic collisions (the ones with no conflict markers)

File-name overlap under-reports the real work. A fork feature breaks when upstream
*replaces the thing it was built on*, even in files the fork never touched. Check:

```bash
git diff --name-status -M "$BASE..main" | grep -v '^M'   # adds, deletes, renames
git diff "$BASE..main" -- '**/package.json'              # removed dependencies
```

Then for each fork feature, ask: **does the API it calls still exist?**

Concretely, in the v0.0.32 integration: upstream #4860 replaced xterm.js with a
libghostty-vt WASM renderer and dropped xterm from `apps/web/package.json` entirely.
The fork's terminal typography feature was written against `new Terminal({fontFamily})`,
`FitAddon`, and `terminal.options` mutation. Git reported one ordinary conflict; the real
job was a rewrite against a different API. Signals to grep for:

- New directories in upstream's add list (`apps/web/src/terminal/ghostty/`) — a
  replacement subsystem.
- Dependencies removed from a `package.json` the fork imports from.
- A single file with a huge rewrite in `--stat` (845 lines changed = replaced, not edited).

Also check for **adjacent** upstream work — no conflict, but now two implementations of
nearby behavior (e.g. upstream adding default-branch caching while the fork has its own
PR-lookup fix). These are review items, not rework, but they belong in the report.

### 1.6 Choose the strategy

| Strategy | Cost | Use when |
|---|---|---|
| **Merge** (`git merge main`) | One conflict pass. No history rewrite. No force-push. | **Default.** The fork branch is published, or has many PR merge commits. |
| Linear rebase | One stop per conflicting commit; flattens PR merges; force-push | Only if a linear-on-upstream history is a hard requirement. |
| `rebase --rebase-merges` | Most conflict-prone; force-push | Preserving PR topology *and* linear shape. Rarely worth it. |
| Squash onto main | Cheapest resolution; loses granular history | Fork delta is being rewritten wholesale anyway. |

Merge is the default here and the bar to leave it is high. A published `dev` has already
cost this fork one force-push recovery incident. The semantic rework is identical under
every strategy, so a rebase buys history shape and nothing else.

Present the tradeoff with real numbers from 1.3/1.4 and let the developer choose. Never
rebase a published branch without explicit sign-off.

### 1.7 Turn on rerere

```bash
git config rerere.enabled true
git config rerere.autoupdate true
```

Records each conflict resolution and replays it automatically next time. On a fork that
integrates repeatedly this compounds — do it before the first merge, not after.

## Phase 2 — Integrate

### 2.1 Backup, and park work in progress

```bash
git branch backup/dev-before-main-merge-$(date +%Y%m%d) dev
git stash push -u -m "wip-before-merge" -- <explicit paths>
```

Check first whether any dirty file is also changed upstream — that predicts a messy
`stash pop`:

```bash
comm -12 <(git diff --name-only | sort) <(git diff --name-only "$BASE..main" | sort)
```

Stash by explicit path. A bare `git stash -u` also sweeps up untracked local debris
(logs, screenshots, build output) and makes restoring it noisy.

### 2.2 Merge and resolve

```bash
git merge --no-ff main -m "merge: integrate upstream main (<version>) into dev"
```

Sort each conflict into one of two kinds and treat them differently:

**Mechanical** — both sides appended to the same region (a new test at the end of a
`describe`, an import in a sorted list). Keep both sides. Do not choose.

**Semantic** — upstream changed the substrate. Take upstream's version wholesale, then
re-apply the fork's *intent* on the new API. Do not attempt to merge the fork's old
implementation line by line into a replaced subsystem; you will produce code that
references APIs that no longer exist.

When re-applying intent, read the new API first. It frequently already handles what the
fork implemented by hand — in the terminal rework, `setFont()` owned font loading, cell
remeasurement, refit, and re-render with an epoch guard, which deleted ~25 lines of manual
`requestAnimationFrame` and refit logic. **The rework is usually smaller than the original.**

Port upstream's own guards to the fork's code path. If upstream re-reads the theme after
an async surface loads (because it can change mid-load), the fork's font handling needs
the same guard for the same reason.

Watch for defaults that silently disagree. The renderer appends Nerd Font glyph fallbacks
to any face it is given; the fork's default stack ended in `monospace`, a generic family
that always resolves and would have made every appended fallback dead — silently breaking
prompt glyphs. The fix was to forward *only* a genuinely custom face and let the renderer's
default apply. **Compare the fork's default against upstream's new default explicitly.**

### 2.3 Reinstall before typechecking

If `pnpm-lock.yaml` or any `package.json` changed, `pnpm install` before believing any
typecheck or test result.

### 2.4 Update the fork's own tests and specs

A reworked feature invalidates whatever asserted its old shape. Both need updating and
neither shows as a conflict:

- Tests that mock the replaced dependency (`vi.mock("@xterm/xterm")` → mock the new surface).
  Async factories (`await Surface.create(...)`) mean the test's mount helper must await too.
- OpenSpec specs under `openspec/specs/` that describe the old mechanism. Grep the spec
  tree for the removed technology name.

Lock the non-obvious behavior in a test — the default-family/glyph-fallback interaction
above is invisible on inspection and deserves an explicit assertion.

## Phase 3 — Triage the results

### 3.1 Verify

```bash
pnpm typecheck                       # whole workspace; cheap and catches API drift
pnpm --filter ./apps/<app> test -- <specific test files>   # targeted first
```

Run targeted tests for what changed, then broaden. Note this repo's AGENTS.md discourages
repo-wide checks for ordinary work — an upstream integration is one of the few times the
broad run is justified, because the blast radius is the whole tree.

### 3.2 Separate pre-existing failures from merge damage

**Never report a failure as merge-caused without this check.** A big integration lands on
top of whatever was already broken, and conflating the two wastes a debugging session:

```bash
# Is the failing file identical to what dev had before the merge?
git diff --name-only "backup/dev-before-main-merge-<date>..HEAD" -- <failing files>
# empty  => byte-identical => the failure is pre-existing, full stop
```

If a failing file *was* touched by the merge, look at what actually changed in it before
concluding. In one case the merge's only edit to a failing test was removing an unrelated
mock line, while the failing assertion was a Windows path-separator issue shared with an
untouched sibling file.

For failures in files that came from upstream, check whether the fork has any content there:

```bash
git diff --name-only main..HEAD -- <failing files>
# empty => byte-identical to upstream => upstream's own test, failing for an
#          environment reason (e.g. POSIX path assertions on Windows), not the merge
```

Report the three buckets separately: **merge-caused** (fix now), **pre-existing** (out of
scope, list them), **platform artifact** (upstream tests that cannot pass on this OS).

### 3.3 Land it

Separate commits by concern, not by file. The merge commit body should name the upstream
headline changes, list which files needed manual resolution and why, and describe any
behavioral decision made during rework (such as deferring to the renderer's default stack).
A future reader hitting the same code needs the reasoning, not the diff.

Restore parked work afterwards (`git stash pop`) and keep it separate from the merge.

### 3.4 Do not sweep up local state

Before any `git add -A`, check what is actually untracked and whether it is ignored:

```bash
git status --short | grep '^??'
git check-ignore -v <paths>          # no output = NOT ignored, would be committed
```

Screenshots, logcat dumps, build output directories, and personal build config are local.
Personal service credentials in particular (EAS project ids, account slugs, owner fields)
often sit deliberately uncommitted — **ask before committing them**, and prefer adding the
debris to `.gitignore` over committing it.

## Fork-specific gotchas

- `gh` resolves to **upstream's** PR numbers here. Always pass `-R PauloDaniel1993/t3code`.
- `exactOptionalPropertyTypes` is on. An optional property must be *omitted*, not set to
  `undefined` — build such objects with conditional spread, not `{ key: maybeUndefined }`.
- Recovering a bad force-push: the pre-push tip is in `git reflog show origin/dev`, but
  that reflog only knows what you last *fetched*. A PR merged on GitHub after your last
  fetch is invisible there. Cross-check `gh pr list -R PauloDaniel1993/t3code --base dev
  --state merged` before declaring recovery complete.
- The fork keeps its own migration ledger under `apps/server/src/persistence/ForkMigrations/`.
  Upstream does not touch it, but check for upstream migrations before assuming that holds.
- `.claude/skills` is a symlink to `.agents/skills`, so a skill written once is discovered
  by Claude Code automatically.

## Reporting

Close with a summary the developer can plan from, not a wall of git output:

1. **State** — which refs moved, where the backup is.
2. **What needed rework and why** — the semantic collisions, with the API that changed.
3. **What merged cleanly but is now adjacent** to new upstream work — review candidates.
4. **Verification** — what passed, and the three failure buckets from 3.2 kept distinct.
5. **What was not done** — unverified suites, deferred items. Say so plainly.
