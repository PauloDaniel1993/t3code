import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  type Project,
  WorkspaceFileUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { expectedProjectMutationFailure, projectMutationOperation } from "./ProjectMutation.ts";
import {
  ProjectConflictError,
  ProjectFileConflictError,
  ProjectOperationError,
  type ProjectService,
} from "./ProjectService.ts";

const projectId = ProjectId.make("project:mutation-mapping");
const project = {
  id: projectId,
  title: "Mapping",
  workspaceRoot: "/work/mapping",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

it.effect("preserves every project mutation field", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const projects: Pick<
      ProjectService["Service"],
      "create" | "delete" | "importWorkspaceFile" | "update"
    > = {
      create: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      importWorkspaceFile: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      update: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      delete: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
    };

    yield* projectMutationOperation(projects, {
      type: "project.create",
      commandId: CommandId.make("command:create"),
      projectId,
      title: "Created",
      workspaceRoot: "/work/created",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:update"),
      projectId,
      title: "Updated",
      workspaceRoot: "/work/updated",
      defaultModelSelection: null,
      autoPull: false,
      projectIcon: null,
      faviconPath: null,
      defaultThreadEnvMode: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.import-workspace-file",
      commandId: CommandId.make("command:import"),
      projectId,
      workspaceFilePath: "/work/team.code-workspace",
      title: "Team",
    });
    // Null unlinks, so it must reach the service rather than read as absent.
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:unlink"),
      projectId,
      workspaceFilePath: null,
    });
    yield* projectMutationOperation(projects, {
      type: "project.delete",
      commandId: CommandId.make("command:delete"),
      projectId,
      force: true,
    });

    assert.deepEqual(yield* Ref.get(calls), [
      {
        commandId: "command:create",
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        commandId: "command:update",
        projectId,
        title: "Updated",
        workspaceRoot: "/work/updated",
        defaultModelSelection: null,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
        scripts: [],
      },
      {
        commandId: "command:import",
        projectId,
        workspaceFilePath: "/work/team.code-workspace",
        title: "Team",
      },
      { commandId: "command:unlink", projectId, workspaceFilePath: null },
      { commandId: "command:delete", projectId, force: true },
    ]);
  }),
);

it("tells clients why an expected mutation was refused, and hides operational failures", () => {
  const other = ProjectId.make("project:other");
  const diagnostic = { code: "file-not-found" as const, message: "Workspace file not found." };
  assert.deepEqual(
    expectedProjectMutationFailure(new WorkspaceFileUnavailableError({ projectId, diagnostic })),
    { message: "Workspace file not found.", diagnostic },
  );
  const fileConflict = expectedProjectMutationFailure(
    new ProjectFileConflictError({
      projectId,
      workspaceFile: "/work/team.code-workspace",
      conflictingProjectId: other,
    }),
  );
  assert.equal(fileConflict?.diagnostic?.code, "conflict");
  assert.equal(fileConflict?.conflictingProjectId, other);
  assert.equal(
    expectedProjectMutationFailure(
      new ProjectConflictError({
        projectId,
        workspaceRoot: "/work/app",
        conflictingProjectId: other,
      }),
    )?.conflictingProjectId,
    other,
  );
  assert.isUndefined(
    expectedProjectMutationFailure(
      new ProjectOperationError({ operation: "read-project", projectId, cause: "SQL text" }),
    ),
  );
});
