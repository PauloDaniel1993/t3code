import type {
  OrchestrationV2AppThread,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointPart,
  OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import { resolveThreadWorkspace } from "@t3tools/shared/workspaceFolders";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { CheckpointServiceV2Shape, FileRestoreRefusal } from "./CheckpointService.ts";
import { checkpointRestoreParts } from "./CheckpointScopeParts.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.";

const CONVERSATION_ONLY = "Rewind the conversation without restoring files instead.";

/** What a client shows when a turn's files can't be restored, naming the folders at fault. */
export function fileRestoreRefusalMessage(refusal: FileRestoreRefusal): string {
  const folders = refusal.folders.join(", ");
  const named = refusal.folders.length > 0;
  switch (refusal.reason) {
    case "not-ready":
      return `${named ? `Files in ${folders} weren't` : "This turn's files weren't"} checkpointed. ${CONVERSATION_ONLY}`;
    case "missing-checkout":
      return `${named ? `The checkout for ${folders}` : "This thread's checkout"} no longer exists. ${CONVERSATION_ONLY}`;
    case "missing-ref":
      return `${named ? `The checkpoint for ${folders}` : "This turn's checkpoint"} is no longer available. ${CONVERSATION_ONLY}`;
    case "shared":
      return named
        ? `File restore requires isolated worktrees. ${folders} may contain changes from another thread. ${CONVERSATION_ONLY}`
        : SHARED_WORKSPACE_RESTORE_MESSAGE;
  }
}

interface RestoreSafetyDependencies {
  readonly fileSystem: FileSystem.FileSystem;
  readonly projections: ProjectionStoreV2["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly path: Path.Path;
}

/**
 * Whether restoring `parts` could overwrite work that isn't this thread's. A
 * part restores a whole checkout, so it must be one of the thread's own
 * worktrees, and no other thread may work in, above or below it. The thread's
 * own nested members never conflict with each other.
 */
export const restoreIsolationRefusal = Effect.fn("orchestrationV2.restoreIsolationRefusal")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath" | "worktrees">,
    parts: ReadonlyArray<Pick<OrchestrationV2CheckpointPart, "cwd" | "folders">>,
    dependencies: RestoreSafetyDependencies,
  ) {
    const { fileSystem, projections, projects, path } = dependencies;
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };
    const existingRealPath = (candidate: string) =>
      fileSystem
        .realPath(candidate)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
    const refusal = (shared: ReadonlySet<number>): FileRestoreRefusal | undefined =>
      shared.size === 0
        ? undefined
        : {
            reason: "shared",
            folders: parts.flatMap((part, index) =>
              shared.has(index) ? part.folders.map((folder) => folder.label) : [],
            ),
          };

    // A thread working in its project's checkout (root mode) shares it.
    const own = new Set<string>();
    for (const root of [
      ...(thread.worktrees ?? []).map((member) => member.path),
      ...(thread.worktreePath === null ? [] : [thread.worktreePath]),
    ]) {
      const real = yield* existingRealPath(root);
      if (real !== null) own.add(real);
    }
    const targets: Array<string> = [];
    const shared = new Set<number>();
    for (const [index, part] of parts.entries()) {
      const cwd = yield* fileSystem.realPath(part.cwd);
      targets.push(cwd);
      if (!own.has(cwd)) shared.add(index);
    }
    if (shared.size === parts.length) return refusal(shared);

    const shell = yield* projections.getShellSnapshot();
    const checkedPaths = new Set<string>();
    for (const otherThread of [...shell.threads, ...shell.archivedThreads]) {
      if (otherThread.id === thread.id || otherThread.deletedAt !== null) continue;
      const other = yield* projections.getCheckpointContext(otherThread.id);
      const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
      const paths = [
        otherThread.worktreePath,
        ...(otherThread.worktrees ?? []).map((member) => member.path),
        ...other.checkpointScopes.map((candidate) => candidate.cwd),
        ...other.checkpoints.flatMap(
          (checkpoint) => checkpoint.parts?.map((part) => part.cwd) ?? [],
        ),
        // A failed turn can leave an errored session with a live event stream.
        // A session shared across threads keeps the cwd it was opened with,
        // often another thread's; each turn runs in the thread's own
        // worktree or project root, which this list already covers.
        ...providerContext.providerSessions.flatMap((session) =>
          session.status === "stopped" ||
          session.capabilities.sessions.supportsMultipleProviderThreadsPerSession
            ? []
            : [session.cwd, ...(session.additionalDirectories ?? [])],
        ),
      ].filter((value): value is string => value !== null);
      if (otherThread.worktreePath === null) {
        // A thread without a worktree works in its project's folders.
        const project = yield* projects.get(otherThread.projectId, { includeDeleted: true });
        if (Option.isNone(project)) return refusal(new Set(parts.keys()));
        const workspaceThread =
          (otherThread.workspaceFolderCount ?? 0) > 1
            ? yield* projections.getThread(otherThread.id)
            : otherThread;
        for (const folder of resolveThreadWorkspace({
          thread: workspaceThread,
          project: project.value,
        }).folders) {
          if (folder.effectivePath !== null) paths.push(folder.effectivePath);
        }
      }
      for (const candidate of paths) {
        if (checkedPaths.has(candidate)) continue;
        checkedPaths.add(candidate);
        const otherCwd = yield* existingRealPath(candidate);
        if (otherCwd === null) continue;
        targets.forEach((cwd, index) => {
          if (contains(cwd, otherCwd) || contains(otherCwd, cwd)) shared.add(index);
        });
      }
      if (shared.size === parts.length) break;
    }
    return refusal(shared);
  },
);

/**
 * Why `checkpoint`'s files can't be restored now, or undefined when they can.
 * File restore is all or nothing: every git part must be ready, its checkout
 * present with the part's ref, and the checkout this thread's alone. Command
 * admission asks, and the rollback effect asks again before the provider
 * rewinds, so a newly shared worktree is refused too.
 */
export const fileRestoreRefusal = Effect.fn("orchestrationV2.fileRestoreRefusal")(function* (
  thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath" | "worktrees">,
  scope: OrchestrationV2CheckpointScope,
  checkpoint: OrchestrationV2Checkpoint,
  dependencies: RestoreSafetyDependencies & {
    readonly checkpoints: Pick<CheckpointServiceV2Shape, "preflightRestore">;
  },
) {
  const preflight = yield* dependencies.checkpoints.preflightRestore({ scope, checkpoint });
  if (preflight !== undefined) return preflight;
  return yield* restoreIsolationRefusal(
    thread,
    checkpointRestoreParts(scope, checkpoint),
    dependencies,
  );
});
