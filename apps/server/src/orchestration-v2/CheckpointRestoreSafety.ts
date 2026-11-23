import {
  isLiveSubagentShell,
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointPart,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShell,
  type TaskFolder,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { isSamePath, resolveThreadWorkspace } from "@t3tools/shared/workspaceFolders";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { CheckpointServiceV2Shape, FileRestoreRefusal } from "./CheckpointService.ts";
import { checkpointRestoreParts } from "./CheckpointScopeParts.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

const SHARED_WORKSPACE_RESTORE_REASON =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread or a side chat.";
const UNFINISHED_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

const CONVERSATION_ONLY =
  "Rewind the conversation without restoring files instead, or delete side chats you no longer need.";

export const SHARED_WORKSPACE_RESTORE_MESSAGE = `${SHARED_WORKSPACE_RESTORE_REASON} ${CONVERSATION_ONLY}`;

/** Why a turn's files can't be restored, naming the folders at fault. */
export function fileRestoreRefusalReason(refusal: FileRestoreRefusal): string {
  const folders = refusal.folders.join(", ");
  const named = refusal.folders.length > 0;
  switch (refusal.reason) {
    case "not-ready":
      return `${named ? `Files in ${folders}` : "Files"} weren't checkpointed at that point.`;
    case "missing-checkout":
      return `${named ? `The checkout for ${folders}` : "This thread's checkout"} no longer exists.`;
    case "missing-ref":
      return `${named ? `The checkpoint for ${folders}` : "That checkpoint"} is no longer available.`;
    case "shared":
      return named
        ? `File restore requires isolated worktrees. ${folders} may contain changes from another thread or a side chat.`
        : SHARED_WORKSPACE_RESTORE_REASON;
  }
}

/** What a client shows when it asks to restore files that can't be. */
export function fileRestoreRefusalMessage(refusal: FileRestoreRefusal): string {
  return `${fileRestoreRefusalReason(refusal)} ${CONVERSATION_ONLY}`;
}

interface RestoreSafetyDependencies {
  readonly fileSystem: FileSystem.FileSystem;
  readonly projections: ProjectionStoreV2["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly path: Path.Path;
}

/**
 * Whether restoring `parts` could overwrite work that isn't this thread's. A
 * part may restore a whole checkout, so it must be one of the thread's own
 * worktrees, and no other thread may work in, above or below it. The thread's
 * own nested members never conflict with each other.
 */
export const restoreIsolationRefusal = Effect.fn("orchestrationV2.restoreIsolationRefusal")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath" | "worktrees">,
    parts: ReadonlyArray<Pick<OrchestrationV2CheckpointPart, "cwd" | "folders">>,
    dependencies: RestoreSafetyDependencies,
    taskFolder?: Pick<TaskFolder, "repositories"> | null,
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
      fileSystem.realPath(candidate).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
    const resolve = (candidate: string) =>
      existingRealPath(candidate).pipe(Effect.map((real) => real ?? path.resolve(candidate)));
    // realPath keeps the caller's casing, and Windows paths ignore it.
    const pathKey = (real: string) => (isWindowsAbsolutePath(real) ? real.toLowerCase() : real);
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
      ...(taskFolder?.repositories ?? []).map((repository) => repository.worktreePath),
      ...(thread.worktreePath === null ? [] : [thread.worktreePath]),
    ]) {
      own.add(pathKey(yield* resolve(root)));
    }
    const targets: Array<string> = [];
    const shared = new Set<number>();
    for (const [index, part] of parts.entries()) {
      const cwd = pathKey(yield* resolve(part.cwd));
      targets.push(cwd);
      if (!own.has(pathKey(cwd))) shared.add(index);
    }
    if (shared.size === parts.length) return refusal(shared);

    const shell = yield* projections.getShellSnapshot();
    const threads = [...shell.threads, ...shell.archivedThreads];
    const threadsById = new Map(threads.map((candidate) => [candidate.id, candidate]));
    const subagentAncestors = (candidate: OrchestrationV2ThreadShell) => {
      const ancestors: OrchestrationV2AppThread["id"][] = [];
      const seen = new Set<string>();
      let current: OrchestrationV2ThreadShell | undefined = candidate;
      while (current !== undefined && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.lineage?.relationshipToParent !== "subagent") return undefined;
        const parentId: OrchestrationV2AppThread["id"] | null = current.lineage.parentThreadId;
        if (parentId === null) return undefined;
        ancestors.push(parentId);
        if (parentId === thread.id) return ancestors;
        current = threadsById.get(parentId);
      }
      return undefined;
    };
    const ancestorProviders = new Map<
      OrchestrationV2AppThread["id"],
      ReadonlyArray<OrchestrationV2ProviderThread>
    >();
    const checkedPaths = new Set<string>();
    for (const otherThread of threads) {
      if (otherThread.id === thread.id || otherThread.deletedAt !== null) continue;
      // An idle side chat that only answered questions never touched the shared worktree.
      if (
        otherThread.lineage?.sideChat === true &&
        otherThread.activeRunId === null &&
        isSamePath(otherThread.worktreePath ?? "", thread.worktreePath ?? "")
      ) {
        const { turnItems } = yield* projections.getThreadRecords(otherThread.id, ["turnItems"], {
          turnItemTypes: ["command_execution", "file_change", "dynamic_tool"],
        });
        if (turnItems.length === 0) continue;
      }
      const other = yield* projections.getCheckpointContext(otherThread.id);
      const ancestors = subagentAncestors(otherThread);
      const nativeSubagent = ancestors !== undefined && isProviderNativeSubagentThread(otherThread);
      // Native children can be runless; their completion lives on the parent's task record.
      if (
        otherThread.worktreePath === thread.worktreePath &&
        (otherThread.status === "completed" ||
          (nativeSubagent && otherThread.status === "idle" && other.runs.length === 0)) &&
        otherThread.activeRunId === null &&
        !isLiveSubagentShell(otherThread) &&
        ancestors !== undefined &&
        !other.runs.some((run) => UNFINISHED_RUN_STATUSES.has(run.status)) &&
        otherThread.lineage.parentThreadId !== null &&
        otherThread.forkedFrom?.type === "node"
      ) {
        const taskNodeId = otherThread.forkedFrom.nodeId;
        const { subagents } = yield* projections.getThreadRecords(
          otherThread.lineage.parentThreadId,
          ["subagents"],
          { subagentIds: [taskNodeId] },
        );
        const task = subagents.find(
          (candidate) => candidate.id === taskNodeId && candidate.childThreadId === otherThread.id,
        );
        if (
          task?.status === "completed" &&
          task.origin === (nativeSubagent ? "provider_native" : "app_owned")
        ) {
          if (!nativeSubagent) continue;
          // Runless shells omit background work; inspect the raw records before restoring files.
          const { providerThreads, turnItems } = yield* projections.getThreadRecords(
            otherThread.id,
            ["providerThreads", "turnItems"],
            {
              turnItemTypes: ["command_execution", "file_change", "dynamic_tool", "subagent"],
              turnItemStatuses: ["pending", "running", "waiting"],
            },
          );
          if (
            turnItems.length === 0 &&
            !providerThreads.some(
              (providerThread) =>
                providerThread.status === "active" ||
                (providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
            )
          ) {
            // Claude can keep a child's unattributed background commands on an ancestor session.
            let pendingAncestorWork = false;
            for (const ancestorId of ancestors) {
              let providers = ancestorProviders.get(ancestorId);
              if (providers === undefined) {
                const records = yield* projections.getThreadRecords(ancestorId, [
                  "providerThreads",
                ]);
                providers = records.providerThreads;
                ancestorProviders.set(ancestorId, providers);
              }
              if (
                providers.some(
                  (provider) =>
                    provider.providerInstanceId === task.providerInstanceId &&
                    (provider.pendingBackgroundTasks?.length ?? 0) > 0,
                )
              ) {
                pendingAncestorWork = true;
                break;
              }
            }
            if (!pendingAncestorWork) continue;
          }
        }
      }
      const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
      const paths = [
        otherThread.worktreePath,
        ...(otherThread.worktrees ?? []).map((member) => member.path),
        // Where its latest run checkpoints, part by part. Older runs' places
        // are history: a later thread may own them now.
        ...other.checkpointScopes.flatMap((scope) => [
          scope.cwd,
          ...(scope.parts?.map((part) => part.cwd) ?? []),
        ]),
        // A failed turn can leave an errored session with a live event stream.
        // A session shared across threads keeps the cwd and extra directories
        // it was opened with, often another thread's, even this one's; each
        // turn runs in the thread's own places, which this list already covers.
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
        if (
          otherThread.workspaceFolderCount === undefined &&
          project.value.workspaceFile === null
        ) {
          paths.push(...(project.value.trackedFolders ?? []).map((folder) => folder.path));
        }
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
          if (contains(cwd, pathKey(otherCwd)) || contains(pathKey(otherCwd), cwd))
            shared.add(index);
        });
      }
      if (shared.size === parts.length) break;
    }
    return refusal(shared);
  },
);

/**
 * Admission and rollback both require every part's ref and exclusive checkout,
 * so a worktree shared after admission is still refused before rewinding.
 */
export const fileRestoreRefusal = Effect.fn("orchestrationV2.fileRestoreRefusal")(function* (
  thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath" | "worktrees">,
  scope: OrchestrationV2CheckpointScope,
  checkpoint: OrchestrationV2Checkpoint,
  dependencies: RestoreSafetyDependencies & {
    readonly checkpoints: Pick<CheckpointServiceV2Shape, "preflightRestore">;
    readonly allowMissingWorktrees?: boolean;
  },
) {
  let preflight = yield* dependencies.checkpoints.preflightRestore({ scope, checkpoint });
  if (preflight?.reason === "missing-checkout" && dependencies.allowMissingWorktrees !== false) {
    // Worktree cleanup leaves refs in the source repository. Admission can check
    // them there; execution recreates the managed member and checks again.
    const lookupParts = [];
    for (const part of checkpointRestoreParts(scope, checkpoint)) {
      if (yield* dependencies.fileSystem.exists(part.cwd)) {
        lookupParts.push(part);
        continue;
      }
      const member = thread.worktrees?.find((member) => isSamePath(member.path, part.cwd));
      if (member !== undefined) {
        lookupParts.push({ ...part, cwd: member.repositoryRoot });
      } else if (
        thread.worktreePath !== null &&
        isSamePath(thread.worktreePath, part.cwd) &&
        checkpoint.parts === undefined
      ) {
        const owner = yield* dependencies.projections.getThread(thread.id);
        const repositoryRoot =
          owner.workspaceFolders?.[0]?.path ??
          Option.getOrUndefined(yield* dependencies.projects.get(owner.projectId))?.workspaceRoot;
        lookupParts.push(repositoryRoot === undefined ? part : { ...part, cwd: repositoryRoot });
      } else {
        lookupParts.push(part);
      }
    }
    preflight = yield* dependencies.checkpoints.preflightRestore({
      scope,
      checkpoint: { ...checkpoint, parts: lookupParts },
    });
  }
  if (preflight !== undefined) return preflight;
  return yield* restoreIsolationRefusal(
    thread,
    checkpointRestoreParts(scope, checkpoint),
    dependencies,
  );
});

// Admission uses this for tracked task folders, including a linked project with no root ref.
export const isCheckpointRestoreIsolated = Effect.fn("orchestrationV2.isCheckpointRestoreIsolated")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath" | "worktrees">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    taskFolder: Pick<TaskFolder, "repositories"> | null,
    dependencies: RestoreSafetyDependencies,
  ) {
    if (thread.worktreePath === null) return false;
    const refusal = yield* restoreIsolationRefusal(
      thread,
      [
        { cwd: scope.cwd, folders: [] },
        ...(taskFolder?.repositories ?? []).map((repository) => ({
          cwd: repository.worktreePath,
          folders: [],
        })),
      ],
      dependencies,
      taskFolder,
    );
    return refusal === undefined;
  },
);
