import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  EnvironmentRequestInvalidError,
  WorkspaceFileProjectsDisabledError,
  WorkspaceFileUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  ProjectConflictError,
  ProjectFileConflictError,
  ProjectNotEmptyError,
  ProjectNotFoundError,
  ProjectOperationError,
} from "./ProjectService.ts";
import { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import { failProjectMutation } from "./http.ts";
import { expectedProjectMutationFailure } from "./ProjectMutation.ts";

const projectId = ProjectId.make("project:http-mutation");

it.effect.each([
  new ProjectNotFoundError({ projectId }),
  new ProjectNotEmptyError({ projectId }),
  new ProjectConflictError({
    projectId,
    workspaceRoot: "/workspace/project",
    conflictingProjectId: ProjectId.make("project:http-mutation-conflict"),
  }),
  new ProjectFileConflictError({
    projectId,
    workspaceFile: "/workspace/team.code-workspace",
    conflictingProjectId: ProjectId.make("project:http-mutation-conflict"),
  }),
  new WorkspaceFileUnavailableError({
    projectId,
    diagnostic: { code: "file-not-found", message: "Workspace file not found." },
  }),
  new WorkspaceFileProjectsDisabledError(),
])("maps expected project mutation failures to invalid requests", (cause) =>
  Effect.gen(function* () {
    const error = yield* failProjectMutation(cause).pipe(Effect.flip);

    assert.instanceOf(error, EnvironmentRequestInvalidError);
    assert.equal(error.code, "invalid_request");
    assert.equal(error.reason, "invalid_command");
    const expected = expectedProjectMutationFailure(cause)!;
    assert.equal(error.message, expected.message);
    assert.deepEqual(error.diagnostic, expected.diagnostic);
    assert.equal(error.conflictingProjectId, expected.conflictingProjectId);
  }),
);

it.effect.each([
  new ProjectOperationError({
    operation: "dispatch-project-command",
    projectId,
    cause: "database unavailable",
  }),
  new ServerRuntimeStartupError({
    mode: "web",
    host: null,
    port: 0,
    cause: "startup unavailable",
  }),
])("keeps operational and startup failures internal", (cause) =>
  Effect.gen(function* () {
    const error = yield* failProjectMutation(cause).pipe(Effect.flip);

    assert.equal(error._tag, "EnvironmentInternalError");
    assert.equal(error.code, "internal_error");
    assert.equal(error.reason, "project_mutation_failed");
  }),
);
