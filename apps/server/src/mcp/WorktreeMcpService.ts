import {
  CommandId,
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
} from "@t3tools/contracts";
import {
  resolveThreadWorkspace,
  type WorkspaceProject,
  type WorkspaceThread,
} from "@t3tools/shared/workspaceFolders";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorktreeSet from "../orchestration-v2/WorktreeSetService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFolderResolver from "../project/WorkspaceFolderResolver.ts";
import * as WorkspaceFolderFiles from "../workspace/WorkspaceFolderFiles.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
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
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const worktreeSets = yield* WorktreeSet.WorktreeSetService;
  const folderFiles = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
  const folderResolver = yield* WorkspaceFolderResolver.WorkspaceFolderResolver;

  const resolveFolders = (
    threadId: ThreadId,
    projectId: ProjectId,
    thread: WorkspaceThread,
    project: WorkspaceProject,
    folderPath?: string,
  ) =>
    folderFiles
      .resolveScope(
        { projectId, threadId, ...(folderPath === undefined ? {} : { folderPath }) },
        resolveThreadWorkspace({ thread, project }).folders,
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

  const readDefaultStartFromOrigin = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.newWorktreesStartFromOrigin),
    asOperationFailed("Unable to read server settings"),
  );

  const handoffIds = (scope: McpThreadInvocationScope) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), operation, uuid].join(
            ":",
          );
        return {
          commandId: CommandId.make(part("command", "worktree-handoff")),
          continuationCommandId: CommandId.make(part("command", "worktree-continuation")),
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

    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: projectCwd })
      .pipe(asOperationFailed("Unable to read git status"));
    if (!localStatus.isRepo) {
      return yield* failure(
        "invalid_request",
        `Project workspace '${projectCwd}' is not a git repository.`,
      );
    }

    const localBranchNames = yield* gitWorkflow
      .listLocalBranchNames(projectCwd)
      .pipe(asOperationFailed("Unable to list branches"));
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
    if (baseRef === undefined) {
      if (localStatus.refName === null) {
        return yield* failure(
          "invalid_request",
          "Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly.",
        );
      }
      baseRef = localStatus.refName;
    }

    const startFromOrigin = input.startFromOrigin ?? (yield* readDefaultStartFromOrigin);

    // The set covers every git checkout among the thread's folders, each name
    // and place checked free before anything is created.
    const plan = yield* worktreeSets
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
            : failure("operation_failed", `Unable to plan the worktrees: ${errorMessage(error)}`),
        ),
      );

    const ids = yield* handoffIds(scope);

    // Mask interruption after worktree creation through setup; binding can detach and interrupt the caller.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const set = yield* restore(
          worktreeSets
            .create(plan, WorktreeSet.noWorktreeSetProgress)
            .pipe(asOperationFailed("Unable to create the worktree")),
        );
        const binding = WorktreeSet.worktreeSetBinding(set);
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

        // suspend: build the rollback only if cleanup actually runs. It
        // removes each worktree before deleting its fresh branch.
        const removeCreatedWorktree = Effect.suspend(() => worktreeSets.discard(set));

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
          yield* worktreeSets
            .bind({
              commandId: ids.commandId,
              threadId: scope.thread.threadId,
              set,
              expectedWorktreePath: null,
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
            Cause.hasInterruptsOnly(cause) ? Effect.void : removeCreatedWorktree,
          ),
        );

        // Queue continuation immediately after binding; detachment terminates the caller, so relaunch needs a durable message.
        const queueContinuation: Effect.Effect<WorktreeMcpContinuationStatus, WorktreeMcpFailure> =
          Effect.suspend(() =>
            input.continuationPrompt === undefined
              ? Effect.succeed<WorktreeMcpContinuationStatus>({ status: "skipped" })
              : threadManagement
                  .sendToThread({
                    projectId: projection.thread.projectId,
                    commandId: ids.continuationCommandId,
                    threadId: scope.thread.threadId,
                    messageId: ids.continuationMessageId,
                    text: input.continuationPrompt,
                    attachments: [],
                    mode: "queue",
                    createdBy: "agent",
                    creationSource: "mcp",
                  })
                  .pipe(
                    Effect.map((sendResult): WorktreeMcpContinuationStatus => ({
                      status: "scheduled",
                      delivery: sendResult.delivery,
                    })),
                    reportFailed("worktree handoff continuation failed to queue"),
                  ),
          );

        const continuation = yield* recheckAndBind.pipe(Effect.andThen(queueContinuation));

        yield* Effect.forEach(
          set.members,
          (member) =>
            vcsStatusBroadcaster
              .refreshStatus(member.path)
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
          startedFromOrigin: set.startedFromOrigin,
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

      const defaultStartFromOrigin = yield* readDefaultStartFromOrigin;

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
      const refs = yield* gitWorkflow
        .listRefs({ ...refInput, cwd })
        .pipe(asOperationFailed("Unable to list refs"));
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

  return WorktreeMcpService.of({ handoff, status, list });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | Crypto.Crypto
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
  | WorktreeSet.WorktreeSetService
  | WorkspaceFolderFiles.WorkspaceFolderFiles
  | WorkspaceFolderResolver.WorkspaceFolderResolver
> = Layer.effect(WorktreeMcpService, make);
