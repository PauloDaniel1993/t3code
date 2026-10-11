# Workspace folders

A thread of a multi-root project works in several folders. These rules span the server, the decider and every client.

## A thread's folders are frozen

- The folder snapshot (`workspaceFolders`) is written once, when the thread is first bound. The decider in [`ThreadWorkspaceBinding.ts`](../../apps/server/src/orchestration-v2/ThreadWorkspaceBinding.ts) rejects a different one. A relink, refresh or unlink of the workspace file changes only new threads.
- So code that needs a thread's folders resolves the snapshot with `resolveThreadWorkspace` ([`workspaceFolders.ts`](../../packages/shared/src/workspaceFolders.ts)). It never reads the project's current folders.
- Availability is the only fact checked again each turn. A run records `unavailableFolderPaths` once, when its scope is prepared, and everything in that run reads that record, so one run never sees two folder sets.
- Threads without a snapshot (plain projects) keep `worktreePath ?? project.workspaceRoot`.

## Two kinds of path

A folder's `path` is lexical, spelled as the workspace file spells it. `checkoutRoot` and a set member's `repositoryRoot` are realpaths of git's top level. Map a folder into a set through its `checkoutRoot` and `checkoutPrefix` (`snapshotFolderPath`), never by comparing `path` with `repositoryRoot`. Otherwise a symlinked or differently cased folder stays in place, and the agent edits the original checkout while the user believes it is isolated.

## Worktree sets

[`WorktreeSetService`](../../apps/server/src/orchestration-v2/WorktreeSetService.ts) owns a set's whole life. Launches, the MCP handoff, `vcs.createThreadWorktrees`, turn-start recreation, removal and storage cleanup all go through it.

- **Members.** One per git checkout among the snapshot's folders that were in git at binding. A submodule whose superproject is a member rides along in that member's worktree. A separate worktree would collide with the populated submodule directory.
- **Layout.** The session directory is where a lone worktree of the primary folder would go. Members mirror their places below their lowest common ancestor, so relative paths between repositories keep resolving. A one-member set is exactly the old single-worktree path.
- **Creation order.** Parents before children, and otherwise the primary first. `git worktree add` refuses a non-empty path, so a nested member created first would block its parent.
- **Removal order.** Deepest first, each from its own `repositoryRoot`. Removing a parent first deletes the nested member's files and leaves a prunable registration behind.
- **Names.** One branch name for the set, checked free in every member repository before anything is created. Checkouts of one repository share its branches and can't check one out twice, so after the first, a checkout gets `<name>-<folder label>`. Each member records the branch it expects, and drift is measured against that. A rename keeps the suffixes, and if one member's rename fails, the others take their old names back.
- **Failed adds.** `git worktree add -b` creates the branch before it checks the target path. Because the plan proved the name free, the coordinator deletes a branch that a failed add left behind.
- **Binding.** Nothing is written until the set is complete. Then one `thread.metadata.update` carries `branch`, `worktreePath` (the primary's place in the set) and `worktrees`. Writers that know nothing of sets send only `worktreePath`, and the decider drops the tuple, leaving the primary alone in its worktree.
- **Plain projects** keep the old binding, the worktree root and no tuple. Mapping a subfolder project's primary would silently change single-root behaviour.
- **Removal is all or nothing.** Explicit removal and storage cleanup take the whole set. They remove nothing while another thread (archived ones included) or a project folder overlaps any member. Without force, every member must be clean first, so a refusal can't leave half a set. Storage cleanup leaves sets whose members nest for explicit removal: the parent's checkout can't tell a nested worktree from its own untracked or ignored files.
- **The generated editor workspace file** lives in the session directory as `<directory name>.code-workspace`. When the session directory is itself a member's worktree, it goes beside it as `<session directory>.code-workspace`, so it never shows up as a change in that checkout. Removal deletes it and the emptied session directory, but only inside T3's worktrees directory.
