import { McpAttachmentInput } from "../attachment/input.ts";
import {
  NonNegativeInt,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectImportWorkspaceFilePayload,
  ProjectWorkspaceFolder,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ProjectResult = Schema.Struct({
  ...Project.fields,
  workspaceFile: Schema.NullOr(TrimmedNonEmptyString),
  folders: Schema.Array(ProjectWorkspaceFolder),
});

const shared = {
  success: ProjectResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
};
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description:
    "List registered projects in this environment, one row per project, including the linked workspaceFile (null for plain projects) and ordered folders with available folder facts. workspaceRoot is the primary folder. Pages use the current project snapshot and may shift between calls.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(ProjectResult),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description:
    "Read a registered project in this environment, including its saved scripts, linked workspaceFile (null for plain projects), and ordered folders with availability and repository facts when known. workspaceRoot is the primary folder. Reading also works when folders are unavailable.",
  parameters: Schema.Struct({ projectId: ProjectId }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Import a VS Code .code-workspace file using workspaceFilePath, a path on this environment's server, when workspace-file projects are enabled. File mode accepts only workspaceFilePath and optional title (defaults to the filename), and never creates directories or repositories. Otherwise register workspaceRoot with a required title; set createWorkspaceRootIfMissing to create the directory. Omit both paths to start a new project from just its required title: the app makes a Git repository in its own projects folder, with a README, an icon, and a first commit (commitError says why a commit failed; the project exists either way). Results include workspaceFile and ordered folders; workspaceRoot is the primary folder. Each call creates a new request; an existing registered file or plain directory is rejected with conflictingProjectId. Clone separately with t3_project_clone when needed.",
  parameters: Schema.Struct({
    ...ProjectCreatePayload.fields,
    title: ProjectImportWorkspaceFilePayload.fields.title,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
    workspaceFilePath: Schema.optional(ProjectImportWorkspaceFilePayload.fields.workspaceFilePath),
  }),
  success: Schema.Struct({ ...ProjectResult.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description:
    "Update a registered project's settings. Omitted fields are preserved. Send workspaceFilePath on its own to link a plain project (the file's first folder must match workspaceRoot), relink to a different file, refresh the current file, or unlink with null. Linking, relinking and refreshing require workspace-file projects to be enabled. Unlink keeps the stored primary folder, history and thread bindings, and may conflict with a plain project at that folder. A linked project's workspaceRoot cannot be edited directly. Results include workspaceFile and ordered folders; workspaceRoot is the primary folder. Uses the same project service as the app.",
  parameters: Schema.Struct({ projectId: ProjectId, ...ProjectUpdatePayload.fields }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description:
    "Delete a project using the existing project deletion lifecycle. Nonempty projects require force=true. This does not delete the repository directory or promise a deleted-thread count.",
  parameters: Schema.Struct({ projectId: ProjectId, force: Schema.optionalKey(Schema.Boolean) }),
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository using the app's source-control service. This only clones; register the returned cwd with t3_project_create. An existing destination is not adopted or removed on failure.",
  parameters: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    'Create an ordinary TOP-LEVEL thread with an explicit workspace binding before its agent starts. Use this when the user requests independent work, a new thread, or a PR stack in its own worktree; use delegate_task for child subagents. Set workspaceStrategy to {type:"worktree",baseRef:"parent-branch",branch:"new-branch",startFromOrigin:false} for a new worktree based on local commits, or {type:"existing_worktree",worktreePath:"/absolute/path",branch:"existing-branch"} to use an existing checkout. For upstream commits, set startFromOrigin:true. Omitted workspaceStrategy means the project root, NOT the caller\'s worktree. Omit projectId/modelSelection/modes to inherit those settings. Set scratch:true instead of projectId for a thread without a project: it runs in a fresh folder of its own, outside any repository. Put the task in message. Do not ask the agent to create its own worktree via shell: that does not update the thread binding. Each call creates a new launch with no retry key; retain threadId and use t3_thread_read/t3_thread_wait to follow preparation. After errors or lost responses, inspect t3_thread_list before retrying. Attachments must be pending uploads. Requires a full-access/default caller.',
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Launch without a project, in its own folder under the environment's Scratch project. Not with projectId or workspaceStrategy.",
      }),
    ),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "Choose where this thread runs before starting its agent: worktree creates and binds a new checkout from baseRef; existing_worktree binds worktreePath; root uses the project checkout. Omitted means root, not the caller's worktree. For a PR stack use the parent branch as baseRef and startFromOrigin:false. Uncommitted changes are not copied.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description:
          "First task prompt, delivered after workspace preparation. Omit message and attachments to create an idle thread.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ManagedProjectFolders.ManagedProjectFolders,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
