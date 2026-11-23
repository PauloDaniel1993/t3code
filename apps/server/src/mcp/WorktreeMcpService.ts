import {
  CommandId,
  type GitCommandError,
  type TaskFolderError,
  MessageId,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadId,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpListInput,
  type WorktreeMcpListResult,
  type WorktreeMcpSetupScriptStatus,
  type WorktreeMcpStatusResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import {
  isSamePath,
  resolveThreadWorkspace,
  type WorkspaceProject,
  type WorkspaceThread,
} from "@t3tools/shared/workspaceFolders";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as PlatformError from "effect/PlatformError";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorktreeSet from "../orchestration-v2/WorktreeSetService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFolderResolver from "../project/WorkspaceFolderResolver.ts";
import * as WorkspaceFolderFiles from "../workspace/WorkspaceFolderFiles.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { readThread } from "./threadAccess.ts";
import { workspaceBinding } from "./workspaceBinding.ts";

export class WorktreeMcpService extends Context.Service<
  WorktreeMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: WorktreeMcpListInput,
    ) => Effect.Effect<WorktreeMcpListResult, OrchestratorMcpFailure>;
    readonly handoff: (
      scope: McpInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
    ) => Effect.Effect<WorktreeMcpStatusResult, WorktreeMcpFailure>;
    readonly listRefs: (
      input: Omit<VcsListRefsInput, "cwd"> & {
        readonly worktreePath: string | null;
        readonly workspaceRoot: string;
      },
    ) => Effect.Effect<VcsListRefsResult, GitCommandError | PlatformError.PlatformError>;
  }
>()("t3/mcp/WorktreeMcpService") {}

function failure(code: WorktreeMcpFailure["code"], message: string): WorktreeMcpFailure {
  return new WorktreeMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

const asOperationFailed = (prefix: string) =>
  Effect.mapError((error: unknown) =>
    failure("operation_failed", `${prefix}: ${errorMessage(error)}`),
  );

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const worktreeSets = yield* WorktreeSet.WorktreeSetService;
  const folderFiles = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
  const folderResolver = yield* WorkspaceFolderResolver.WorkspaceFolderResolver;

  const resolveFolders = Effect.fn("WorktreeMcpService.resolveFolders")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
    thread: WorkspaceThread,
    project: WorkspaceProject,
    folderPath?: string,
    fallbackRemovedWorktrees = false,
  ) {
    const folders = yield* Effect.forEach(
      resolveThreadWorkspace({ thread, project }).folders,
      (folder) =>
        Effect.gen(function* () {
          if (
            !fallbackRemovedWorktrees ||
            folder.folder.path === undefined ||
            (folderPath === undefined
              ? !folder.isPrimary
              : !isSamePath(folder.folder.path, folderPath)) ||
            folder.effectivePath === null ||
            folder.effectivePath === folder.folder.path ||
            (yield* fileSystem
              .exists(folder.effectivePath)
              .pipe(asOperationFailed("Unable to inspect worktree")))
          )
            return folder;
          // A cleaned-up worktree keeps its binding; list refs from the original folder.
          return { ...folder, effectivePath: folder.folder.path, checkoutRoot: undefined };
        }),
    );
    return yield* folderFiles
      .resolveScope(
        { projectId, threadId, ...(folderPath === undefined ? {} : { folderPath }) },
        folders,
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            error.failure === "folder-not-found"
              ? "folder_not_found"
              : error.failure === "thread-not-found"
                ? "thread_not_found"
                : error.failure === "project-not-found"
                  ? "project_not_found"
                  : "operation_failed",
            error.message,
          ),
        ),
      );
  });

  // Serialize handoffs per thread to avoid creating two worktrees and orphaning one.
  const handoffThreadsInFlight = new Set<string>();

  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "Worktree handoff and status act as the calling T3 thread, so they need an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant worktree capabilities."),
        );

  const loadThread = (scope: McpThreadInvocationScope) =>
    threadManagement.getThreadRecords(scope.thread.threadId, []).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError"
          ? failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`)
          : failure(
              "operation_failed",
              `Unable to read thread ${scope.thread.threadId}: ${errorMessage(error)}`,
            ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`),
      ),
    );

  const loadProject = (threadId: ThreadId, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asOperationFailed(`Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${projectId}' was not found for thread '${threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readDefaultStartFromOrigin = (projectId: ProjectId) =>
    serverSettings.getSettings.pipe(
      Effect.map(
        (settings) =>
          resolveProjectSettings(settings, projectId).settings.newWorktreesStartFromOrigin,
      ),
      asOperationFailed("Unable to read server settings"),
    );

  const handoffIds = (scope: McpThreadInvocationScope) =>
    random.uuidV4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), operation, uuid].join(
            ":",
          );
        return {
          commandId: CommandId.make(part("command", "worktree-handoff")),
          continuationMessageId: MessageId.make(part("message", "worktree-continuation")),
        };
      }),
      Effect.orDie,
    );

  const performHandoff = Effect.fn("WorktreeMcpService.performHandoff")(function* (
    scope: McpThreadInvocationScope,
    input: WorktreeMcpHandoffInput,
  ) {
    const alreadyInWorktree = (worktreePath: string) =>
      failure(
        "already_in_worktree",
        `Thread '${scope.thread.threadId}' is already attached to worktree '${worktreePath}'.`,
      );

    const projection = yield* loadThread(scope);
    if (projection.thread.worktreePath !== null) {
      return yield* alreadyInWorktree(projection.thread.worktreePath);
    }
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.thread.threadId}' is archived and cannot be handed off to a worktree.`,
      );
    }

    const project = yield* loadProject(scope.thread.threadId, projection.thread.projectId);
    // A thread with a folder snapshot works from its own primary folder,
    // which a relink of the project's workspace file never moves.
    const projectCwd = projection.thread.workspaceFolders?.[0]?.path ?? project.workspaceRoot;

    // A project that tracks repositories moves into a task folder: its own folder, which need
    // not be a repository, and a worktree of each tracked one.
    const taskPlan =
      projection.thread.workspaceFolders === undefined
        ? yield* taskFolders
            .plan({ projectId: project.id })
            .pipe(asOperationFailed("Unable to read the project's repositories"))
        : null;
    const projectIsRepository = taskPlan === null || taskPlan.projectIsRepository;
    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: projectCwd })
      .pipe(asOperationFailed("Unable to read git status"));
    if (projectIsRepository && !localStatus.isRepo) {
      return yield* failure(
        "invalid_request",
        `Project workspace '${projectCwd}' is not a git repository.`,
      );
    }

    const localBranchNames = projectIsRepository
      ? yield* gitWorkflow
          .listLocalBranchNames(projectCwd)
          .pipe(asOperationFailed("Unable to list branches"))
      : [];
    if (localBranchNames.includes(input.branch)) {
      const existingRef = yield* gitWorkflow
        .listRefs({ cwd: projectCwd, query: input.branch, refKind: "local" })
        .pipe(
          Effect.map((result) =>
            result.refs.find((ref) => ref.name === input.branch && ref.isRemote !== true),
          ),
          Effect.orElseSucceed(() => undefined),
        );
      const checkoutPath = existingRef?.worktreePath ?? null;
      return yield* failure(
        "invalid_request",
        `Branch '${input.branch}' already exists${
          checkoutPath === null ? "" : ` and is checked out at '${checkoutPath}'`
        }. Choose a different branch name, or delete the existing branch${
          checkoutPath === null ? "" : " and its worktree"
        } first.`,
      );
    }

    let baseRef = input.baseRef;
    if (baseRef === undefined && !projectIsRepository) {
      // Each repository starts from its own default branch.
      baseRef = "HEAD";
    } else if (baseRef === undefined) {
      if (localStatus.refName === null) {
        return yield* failure(
          "invalid_request",
          "Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly.",
        );
      }
      baseRef = localStatus.refName;
    }

    const startFromOrigin =
      input.startFromOrigin ?? (yield* readDefaultStartFromOrigin(project.id));

    const plan =
      projection.thread.workspaceFolders === undefined
        ? null
        : yield* worktreeSets
            .plan({
              thread: projection.thread,
              projectRoot: projectCwd,
              baseRef,
              branch: input.branch,
              startFromOrigin,
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "VcsThreadWorktreesError"
                  ? failure("invalid_request", error.detail)
                  : failure(
                      "operation_failed",
                      `Unable to plan the worktrees: ${errorMessage(error)}`,
                    ),
              ),
            );
    let worktreeBaseRef = baseRef;
    let baseRefName = baseRef;
    let startedFromOrigin = false;
    if (plan === null && startFromOrigin && projectIsRepository) {
      const resolvedRemoteBase = yield* gitWorkflow
        .fetchWorktreeBaseCommit({ cwd: projectCwd, refName: baseRef })
        .pipe(asOperationFailed(`Unable to fetch the remote base of '${baseRef}'`));
      if (resolvedRemoteBase !== null) {
        worktreeBaseRef = resolvedRemoteBase.commitSha;
        baseRefName = `refs/remotes/${resolvedRemoteBase.remoteRefName}`;
        startedFromOrigin = true;
      }
    }

    const ids = yield* handoffIds(scope);

    // Mask interruption after worktree creation through setup; binding can detach and interrupt the caller.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const created = yield* restore(
          Effect.gen(function* () {
            if (plan !== null) {
              const set = yield* worktreeSets.create(plan, WorktreeSet.noWorktreeSetProgress);
              return {
                binding: WorktreeSet.worktreeSetBinding(set),
                paths: set.members.map((member) => member.path),
                startedFromOrigin: set.startedFromOrigin,
                rollback: Effect.suspend(() => worktreeSets.discard(set)),
              };
            }
            const worktree = yield* taskPlan === null
              ? gitWorkflow
                  .createWorktree({
                    cwd: projectCwd,
                    refName: worktreeBaseRef,
                    newRefName: input.branch,
                    baseRefName,
                    path: null,
                  })
                  .pipe(Effect.map((created) => ({ ...created.worktree, taskFolder: null })))
              : taskFolders
                  .create({
                    plan: taskPlan,
                    branch: input.branch,
                    projectStart: { refName: worktreeBaseRef, baseRefName },
                    baseBranch: input.baseRef,
                    startFromOrigin,
                  })
                  .pipe(
                    Effect.map((created) => {
                      // A layout command is handed the branch name, not the fetched commit.
                      startedFromOrigin =
                        !created.laidOutByProject &&
                        (startedFromOrigin || created.repositoriesStartedFromOrigin);
                      return {
                        path: created.taskFolder.projectPath,
                        refName: created.branch,
                        taskFolder: created.taskFolder.root,
                      };
                    }),
                  );
            const { path: worktreePath, refName: branch, taskFolder } = worktree;
            return {
              binding: { worktreePath, branch },
              paths: [worktreePath],
              startedFromOrigin,
              rollback: Effect.suspend(
                (): Effect.Effect<unknown, GitCommandError | TaskFolderError> =>
                  taskFolder === null
                    ? gitWorkflow
                        .removeWorktree({ cwd: projectCwd, path: worktreePath, force: true })
                        .pipe(
                          Effect.andThen(
                            Effect.suspend(() =>
                              gitWorkflow.deleteLocalBranch({
                                cwd: projectCwd,
                                refName: branch,
                                force: true,
                              }),
                            ),
                          ),
                        )
                    : taskFolders.remove({
                        root: taskFolder,
                        force: true,
                        forget: true,
                        deleteBranch: branch,
                      }),
              ).pipe(Effect.ignoreCause({ log: true })),
            };
          }).pipe(asOperationFailed("Unable to create the worktree")),
        );
        const { binding } = created;
        const { worktreePath, branch } = binding;

        const reportFailed = (logMessage: string) =>
          Effect.catchCause((cause: Cause.Cause<unknown>) => {
            const detail = errorMessage(Cause.squash(cause));
            return Effect.logWarning(logMessage, {
              threadId: scope.thread.threadId,
              worktreePath,
              detail,
            }).pipe(Effect.as({ status: "failed", detail } as const));
          });

        const recheckAndBind = Effect.gen(function* () {
          // A concurrent UI binding may have landed during git work; do not orphan a second worktree.
          const recheck = yield* loadThread(scope);
          if (recheck.thread.worktreePath !== null) {
            return yield* alreadyInWorktree(recheck.thread.worktreePath);
          }
          if (recheck.thread.archivedAt !== null) {
            return yield* failure(
              "invalid_request",
              `Thread '${scope.thread.threadId}' was archived while the worktree was being created; the handoff was rolled back.`,
            );
          }
          return yield* threadManagement
            .dispatch({
              type: "thread.metadata.update",
              commandId: ids.commandId,
              threadId: scope.thread.threadId,
              ...binding,
              expectedWorktreePath: null,
              // Binding detaches the session and ends the caller; a later send could lose the race.
              ...(input.continuationPrompt === undefined
                ? {}
                : {
                    continuation: {
                      messageId: ids.continuationMessageId,
                      text: input.continuationPrompt,
                    },
                  }),
            })
            .pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause))
                  return Effect.failCause(
                    Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
                  );
                const error = Cause.findError(cause);
                if (
                  Result.isSuccess(error) &&
                  error.success._tag === "ThreadManagementProviderInstanceDisabledError"
                )
                  return Effect.fail(failure("invalid_request", error.success.message));
                return Effect.fail(
                  failure(
                    "operation_failed",
                    `Unable to re-point the thread at the worktree: ${errorMessage(Cause.squash(cause))}`,
                  ),
                );
              }),
            );
        }).pipe(
          // Do not remove on interruption alone; the thread binding may already have committed.
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : created.rollback,
          ),
        );

        const bound = yield* recheckAndBind;
        const continuation: WorktreeMcpContinuationStatus =
          input.continuationPrompt === undefined
            ? { status: "skipped" }
            : {
                status: "scheduled",
                delivery: bound.storedEvents.some(
                  ({ event }) => event.type === "run.created" && event.payload.status !== "queued",
                )
                  ? "started"
                  : "queued",
              };

        yield* Effect.forEach(
          created.paths,
          (path) =>
            vcsStatusBroadcaster
              .refreshStatus(path)
              .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach),
          { discard: true },
        );

        let setupScript: WorktreeMcpSetupScriptStatus = { status: "skipped" };
        if (input.runSetupScript ?? true) {
          setupScript = yield* setupScriptRunner
            .runForThread({
              threadId: scope.thread.threadId,
              projectId: projection.thread.projectId,
              projectCwd,
              worktreePath,
              project: {
                id: project.id,
                workspaceRoot: project.workspaceRoot,
                scripts: project.scripts,
              },
            })
            .pipe(
              Effect.map((result): WorktreeMcpSetupScriptStatus =>
                result.status === "started"
                  ? {
                      status: "started",
                      scriptName: result.scriptName,
                      terminalId: result.terminalId,
                    }
                  : result.status === "skipped-for-link"
                    ? { status: "skipped" }
                    : { status: "no-script" },
              ),
              reportFailed("worktree handoff setup script failed"),
            );
        }

        const result: WorktreeMcpHandoffResult = {
          ...workspaceBinding(
            { ...projection.thread, ...binding },
            project,
            (yield* resolveFolders(
              scope.thread.threadId,
              project.id,
              { ...projection.thread, ...binding },
              project,
            ).pipe(
              Effect.mapError((error) =>
                failure(
                  "operation_failed",
                  `Handoff recorded, but unable to inspect its folder binding: ${error.message}`,
                ),
              ),
            )).folders,
          ),
          worktreePath,
          branch,
          baseRef,
          startedFromOrigin: created.startedFromOrigin,
          setupScript,
          continuation,
          note:
            continuation.status === "scheduled"
              ? "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the queued continuation prompt then starts the next turn inside the worktree with the conversation preserved. The worktree is not removed automatically when the thread is deleted."
              : "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the conversation continues inside the worktree when the thread receives its next message. Pass continuationPrompt to resume automatically. The worktree is not removed automatically when the thread is deleted.",
        };
        return result;
      }),
    );
  });

  const handoff: WorktreeMcpService["Service"]["handoff"] = Effect.fn("WorktreeMcpService.handoff")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      // Acquire and register cleanup atomically so cancellation cannot strand the guard until restart.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (handoffThreadsInFlight.has(scope.thread.threadId)) {
            return Effect.fail(
              failure(
                "handoff_in_progress",
                `A worktree handoff is already in progress for thread '${scope.thread.threadId}'.`,
              ),
            );
          }
          handoffThreadsInFlight.add(scope.thread.threadId);
          return restore(performHandoff(scope, input)).pipe(
            Effect.ensuring(
              Effect.sync(() => handoffThreadsInFlight.delete(scope.thread.threadId)),
            ),
          );
        }),
      );
    },
  );

  const status: WorktreeMcpService["Service"]["status"] = Effect.fn("WorktreeMcpService.status")(
    function* (callerScope) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const projection = yield* loadThread(scope);
      const project = yield* loadProject(scope.thread.threadId, projection.thread.projectId);

      const defaultStartFromOrigin = yield* readDefaultStartFromOrigin(project.id);

      const result: WorktreeMcpStatusResult = {
        ...workspaceBinding(
          projection.thread,
          project,
          (yield* resolveFolders(scope.thread.threadId, project.id, projection.thread, project))
            .folders,
        ),
        attached: projection.thread.worktreePath !== null,
        worktreePath: projection.thread.worktreePath,
        branch: projection.thread.branch,
        projectWorkspaceRoot: project.workspaceRoot,
        defaultStartFromOrigin,
      };
      return result;
    },
  );

  const list: WorktreeMcpService["Service"]["list"] = Effect.fn("WorktreeMcpService.list")(
    function* (scope, input) {
      yield* requireCapability(scope);
      const { projection } = yield* readThread(input.threadId).pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threadManagement),
      );
      const project = yield* loadProject(projection.thread.id, projection.thread.projectId);
      const resolved = yield* resolveFolders(
        projection.thread.id,
        projection.thread.projectId,
        projection.thread,
        project,
        input.folderPath,
        true,
      );
      const folder = resolved.selected[0];
      if (folder === undefined)
        return yield* failure("folder_not_found", "This thread has no workspace folder.");
      const cwd = folder.effectivePath;
      const folderPath = folder.folder.path ?? folder.folder.uri ?? input.folderPath ?? cwd;
      if (cwd === null || folderPath === null) {
        return yield* failure(
          "folder_unavailable",
          `Workspace folder '${folderPath}' is unavailable.`,
        );
      }
      const probe = yield* folderResolver.probe(cwd, { vcs: true });
      if (probe.availability === "unavailable") {
        return yield* failure(
          "folder_unavailable",
          `Workspace folder '${folderPath}' is unavailable.`,
        );
      }
      const { folderPath: _, threadId: _threadId, ...refInput } = input;
      const refs = yield* listRefs({ ...refInput, worktreePath: null, workspaceRoot: cwd }).pipe(
        asOperationFailed("Unable to list refs"),
      );
      return {
        ...refs,
        folderPath,
        cwd,
        repositoryRoot: refs.isRepo ? (probe.vcs?.checkoutRoot ?? null) : null,
      };
    },
    Effect.mapError((error) =>
      error._tag === "OrchestratorMcpFailure"
        ? error
        : new OrchestratorMcpFailure({
            code:
              error.code === "operation_failed"
                ? "orchestration_error"
                : error.code === "project_not_found" ||
                    error.code === "already_in_worktree" ||
                    error.code === "handoff_in_progress"
                  ? "invalid_request"
                  : error.code,
            message: error.message,
          }),
    ),
  );

  const listRefs: WorktreeMcpService["Service"]["listRefs"] = Effect.fn(
    "WorktreeMcpService.listRefs",
  )(function* ({ worktreePath, workspaceRoot, ...refs }) {
    // Storage cleanup removes a worktree but keeps its path on the thread.
    const cwd =
      worktreePath !== null && (yield* fileSystem.exists(worktreePath))
        ? worktreePath
        : workspaceRoot;
    return yield* gitWorkflow.listRefs({ ...refs, cwd });
  });

  return WorktreeMcpService.of({ handoff, status, list, listRefs });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
  | WorktreeSet.WorktreeSetService
  | WorkspaceFolderFiles.WorkspaceFolderFiles
  | WorkspaceFolderResolver.WorkspaceFolderResolver
  | TaskFolders.TaskFolders
> = Layer.effect(WorktreeMcpService, make);
