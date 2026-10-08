# T3 Code fork

This fork tracks upstream T3 Code and carries its own features on top. These terms name how the fork relates to upstream, and the fork's own features; upstream's product vocabulary lives in `docs/internals/glossary.md`.

## Language

**Upstream**:
The pingdotgg/t3code project this fork follows, and its `main` branch in particular.
_Avoid_: Theo's version, origin

**Fork delta**:
Everything the fork carries on top of upstream `main`: its own features, migrations, branding, and local-install behavior.
_Avoid_: our changes, customizations

**V2 preview line**:
Upstream's unreleased line of development that preview releases are cut from, ahead of `main` and built on orchestration v2.
_Avoid_: V2 branch, Theo's version, preview branch

**Orchestration v2**:
The server engine inside the V2 preview line that replaces the V1 decider, projector, and reactors.
_Avoid_: V2 (unqualified)

**V2 integration**:
The effort to bring the V2 preview line into the fork with the fork delta ported onto it, carried on the `integrate/v2` branch.
_Avoid_: V2 merge, V2 migration

### Workspace files

**Workspace file**:
A VS Code `.code-workspace` file naming a set of folders. A multi-root project stays linked to it, and the file owns the folder list.
_Avoid_: workspace (unqualified), VS Code project

**Multi-root project**:
A project imported from a workspace file, covering every folder the file names.
_Avoid_: workspace project, project group

**Workspace folder**:
One folder of a multi-root project, in file order.
_Avoid_: root, sub-project, member project

**Primary folder**:
The first workspace folder. Threads start there and reach the others from it. It is never replaced while unavailable.
_Avoid_: main folder, cwd folder

**Unavailable folder**:
A workspace folder this environment can't reach (missing on disk, or a remote URI). It stays listed but is excluded from agent access, version control, worktrees and checkpoints.
_Avoid_: broken folder

**Folder snapshot**:
A thread's frozen list of workspace folders and their labels, with its primary folder, written when the thread is first bound. Later changes to the workspace file never change it; each turn only re-checks which of its folders are available.
_Avoid_: thread folders

**Worktree set**:
The worktrees one thread works in, one per git checkout among its folders, created and removed all-or-nothing.
_Avoid_: worktree tuple

**Session directory**:
The directory holding a thread's worktree set, mirroring the folders' layout on disk.
_Avoid_: worktree root
