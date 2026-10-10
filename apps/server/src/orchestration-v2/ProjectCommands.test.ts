import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type ProjectScript,
  type WorkspaceFolderEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  planProjectCommand,
  type ProjectCommand,
  projectCommandIdentities,
  type ProjectCommandState,
} from "./ProjectCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const projectId = ProjectId.make("project-scripts");

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Scripts",
  workspaceRoot: "/tmp/scripts",
  workspaceFile: null,
  folders: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const script = (id: string): ProjectScript => ({
  id,
  name: "Install dependencies",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: false,
});

const plan = (command: ProjectCommand, state: Partial<ProjectCommandState> = {}) =>
  planProjectCommand({
    command,
    state: {
      project: undefined,
      workspaceOwner: undefined,
      workspaceFileOwner: undefined,
      ...state,
    },
    eventId: EventId.make("event:planned"),
    now,
  });

const update = (
  fields: Omit<
    Extract<ProjectCommand, { type: "project.meta.update" }>,
    "type" | "commandId" | "projectId"
  >,
) =>
  plan(
    {
      type: "project.meta.update",
      commandId: CommandId.make("cmd-update"),
      projectId,
      ...fields,
    },
    { project: row() },
  );

const payloadOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result).payload as Record<string, unknown>;
};

const failureOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure : assert.fail("expected a rejection");
};

describe("planProjectCommand", () => {
  it("creates projects with empty scripts and no model default", () => {
    const result = plan({
      type: "project.create",
      commandId: CommandId.make("cmd-create"),
      projectId,
      title: "Scripts",
      workspaceRoot: "/tmp/scripts",
    });
    const event = Result.getOrThrow(result);
    assert.equal(event.type, "project.created");
    assert.equal(event.occurredAt, "2026-01-01T00:00:00.000Z");
    assert.deepInclude(event.payload, { scripts: [], defaultModelSelection: null });
  });

  it("only treats metadata updates as explicit model defaults", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    assert.deepEqual(
      payloadOf(update({ defaultModelSelection: selection })).defaultModelSelection,
      selection,
    );
  });

  it("carries every edited field and omits the rest", () => {
    const scripts = [script("lint")];
    const payload = payloadOf(
      update({
        scripts,
        defaultThreadEnvMode: "worktree",
        autoPull: true,
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
      }),
    );
    assert.deepInclude(payload, {
      scripts,
      defaultThreadEnvMode: "worktree",
      autoPull: true,
      faviconPath: "brand/icon.svg",
      projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
    });
    const renamed = payloadOf(update({ title: "Renamed" }));
    assert.isFalse("defaultThreadEnvMode" in renamed);
    assert.isNull(payloadOf(update({ defaultThreadEnvMode: null })).defaultThreadEnvMode);
  });

  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "a".repeat(25)])(
    "rejects a new script ID that cannot have a shortcut: %s",
    (id) => {
      const failure = failureOf(update({ scripts: [script("lint"), script(id)] }));
      assert.equal(failure._tag, "ProjectCommandInvariantError");
      assert.include(failure.message, "Script ID");
      assert.include(failure.message, "24");
      // The detail is persisted in the rejected receipt, so it omits the raw ID.
      assert.notInclude(failure.message, `'${id}'`);
    },
  );

  it("accepts a script ID at the shortcut length limit", () => {
    const scripts = [script("a".repeat(24))];
    assert.deepEqual(payloadOf(update({ scripts })).scripts, scripts);
  });

  it("keeps legacy scripts editable and removable while rejecting new invalid ones", () => {
    const legacy = script("install-javascript-dependencies");
    const withLegacy = (scripts: ReadonlyArray<ProjectScript>) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-repair-script"),
          projectId,
          scripts,
        },
        { project: row({ scripts: [legacy] }) },
      );
    for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
      assert.deepEqual(payloadOf(withLegacy(scripts)).scripts, scripts);
    }
    assert.equal(
      failureOf(withLegacy([legacy, script("another.invalid.id")]))._tag,
      "ProjectCommandInvariantError",
    );
  });

  it("limits monograms to two graphemes", () => {
    for (const text of ["T3", "é", "किखि", "क्ष्म", "각"]) {
      const monogram = { kind: "monogram", text, color: "violet" } as const;
      assert.deepEqual(payloadOf(update({ projectIcon: monogram })).projectIcon, monogram);
    }
    for (const text of ["ABC", "किखिगि"]) {
      assert.equal(
        failureOf(update({ projectIcon: { kind: "monogram", text, color: "violet" } }))._tag,
        "ProjectCommandInvariantError",
      );
    }
  });

  it("rejects a workspace root held by another active project", () => {
    const owner = row({
      projectId: ProjectId.make("project-existing"),
      workspaceRoot: "/tmp/project",
    });
    const create = failureOf(
      plan(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-duplicate-root"),
          projectId: ProjectId.make("project-duplicate-root"),
          title: "Duplicate",
          workspaceRoot: "/tmp/project",
        },
        { workspaceOwner: owner },
      ),
    );
    assert.equal(create._tag, "ProjectWorkspaceConflictError");
    assert.equal(
      create.message,
      "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
    );
    const move = failureOf(
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-move-root"),
          projectId,
          workspaceRoot: "/tmp/project",
        },
        { project: row(), workspaceOwner: owner },
      ),
    );
    assert.equal(move._tag, "ProjectWorkspaceConflictError");
  });

  it("requires the project to exist, and to be absent on create", () => {
    const create: ProjectCommand = {
      type: "project.create",
      commandId: CommandId.make("cmd-create-twice"),
      projectId,
      title: "Twice",
      workspaceRoot: "/tmp/twice",
    };
    assert.include(failureOf(plan(create, { project: row() })).message, "cannot be created twice");
    const deleted = row({ deletedAt: "2026-01-01T00:00:00.000Z" });
    assert.include(
      failureOf(plan(create, { project: deleted })).message,
      "cannot be created twice",
    );
    for (const command of [
      { type: "project.meta.update", commandId: CommandId.make("cmd-missing"), projectId },
      { type: "project.delete", commandId: CommandId.make("cmd-missing"), projectId },
    ] as const) {
      for (const project of [undefined, deleted]) {
        assert.equal(
          failureOf(plan(command, { project }))._tag,
          "ProjectCommandMissingProjectError",
        );
      }
    }
  });

  it("creates a linked project only with its primary folder at the workspace root", () => {
    const folders = [
      { path: "/work/app", name: "app" },
      { uri: "vscode-remote://ssh-remote+devbox/srv/api", name: "api" },
    ];
    const workspaceFile = "/work/app.code-workspace";
    const create = (fields: {
      workspaceFile?: string;
      folders?: ReadonlyArray<WorkspaceFolderEntry>;
    }) =>
      plan({
        type: "project.create",
        commandId: CommandId.make("cmd-create-linked"),
        projectId,
        title: "Linked",
        workspaceRoot: "/work/app",
        ...fields,
      });
    assert.deepInclude(payloadOf(create({ workspaceFile, folders })), { workspaceFile, folders });
    const plain = payloadOf(create({}));
    assert.isFalse("workspaceFile" in plain);
    assert.isFalse("folders" in plain);
    for (const fields of [
      { workspaceFile },
      { workspaceFile, folders: [] },
      { workspaceFile, folders: folders.toReversed() },
      { workspaceFile, folders: [...folders, { name: "nameless" }] },
      { workspaceFile, folders: [...folders, { path: "/work/both", uri: "file:///x", name: "x" }] },
      { folders },
    ]) {
      assert.equal(failureOf(create(fields))._tag, "ProjectCommandInvariantError");
    }
  });

  it("links, refreshes and unlinks with the primary folder kept at the workspace root", () => {
    const workspaceFile = "/work/app.code-workspace";
    const linked = row({
      workspaceRoot: "/work/app",
      workspaceFile,
      folders: [
        { path: "/work/app", name: "app" },
        { path: "/work/api", name: "api" },
      ],
    });
    const updateLinked = (
      fields: Omit<
        Extract<ProjectCommand, { type: "project.meta.update" }>,
        "type" | "commandId" | "projectId"
      >,
    ) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-update-linked"),
          projectId,
          ...fields,
        },
        { project: linked },
      );

    const link = { workspaceFile, folders: [{ path: "/tmp/scripts", name: "scripts" }] };
    assert.deepInclude(payloadOf(update(link)), link);
    const refresh = { workspaceRoot: "/work/api", folders: [{ path: "/work/api", name: "api" }] };
    assert.deepInclude(payloadOf(updateLinked(refresh)), refresh);
    assert.deepInclude(payloadOf(updateLinked({ workspaceFile: null, folders: null })), {
      workspaceFile: null,
      folders: null,
    });
    assert.isFalse("folders" in payloadOf(updateLinked({ title: "Renamed" })));

    for (const fields of [
      { workspaceRoot: "/work/api" },
      { folders: [{ path: "/work/api", name: "api" }] },
      { workspaceFile: null },
      { folders: null },
    ]) {
      assert.equal(failureOf(updateLinked(fields))._tag, "ProjectCommandInvariantError");
    }
    assert.equal(
      failureOf(update({ workspaceFile, folders: [{ path: "/work/app", name: "app" }] }))._tag,
      "ProjectCommandInvariantError",
    );
  });

  it("claims a workspace file for one project, and a plain root only for plain projects", () => {
    const workspaceFile = "/work/app.code-workspace";
    const owner = row({
      projectId: ProjectId.make("project-owner"),
      workspaceRoot: "/work/app",
      workspaceFile,
      folders: [{ path: "/work/app", name: "app" }],
    });
    const importing = {
      type: "project.create",
      commandId: CommandId.make("cmd-import"),
      projectId,
      title: "App",
      workspaceRoot: "/work/app",
      workspaceFile,
      folders: [{ path: "/work/app", name: "app" }],
    } satisfies ProjectCommand;
    const conflict = failureOf(plan(importing, { workspaceFileOwner: owner }));
    assert.equal(conflict._tag, "ProjectWorkspaceFileConflictError");
    assert.deepInclude(conflict, { workspaceFile, conflictingProjectId: owner.projectId });
    // A plain project at the primary is no conflict for a linked one.
    const plainOwner = row({
      projectId: ProjectId.make("project-plain"),
      workspaceRoot: "/work/app",
    });
    assert.isTrue(Result.isSuccess(plan(importing, { workspaceOwner: plainOwner })));

    const linked = row({
      workspaceRoot: "/work/app",
      workspaceFile,
      folders: [{ path: "/work/app", name: "app" }],
    });
    const unlink = {
      type: "project.meta.update",
      commandId: CommandId.make("cmd-unlink"),
      projectId,
      workspaceFile: null,
      folders: null,
    } satisfies ProjectCommand;
    assert.equal(
      failureOf(plan(unlink, { project: linked, workspaceOwner: plainOwner }))._tag,
      "ProjectWorkspaceConflictError",
    );

    // A link decided while the project was plain can't land once it's linked.
    const staleLink = {
      type: "project.meta.update",
      commandId: CommandId.make("cmd-stale-link"),
      projectId,
      workspaceFile: "/work/other.code-workspace",
      folders: [{ path: "/work/app", name: "app" }],
      expectedWorkspaceFile: null,
    } satisfies ProjectCommand;
    assert.equal(
      failureOf(plan(staleLink, { project: linked }))._tag,
      "ProjectCommandInvariantError",
    );
    assert.isTrue(
      Result.isSuccess(
        plan({ ...staleLink, expectedWorkspaceFile: workspaceFile }, { project: linked }),
      ),
    );
  });

  it("names every identity a command claims or releases", () => {
    const workspaceFile = "/work/app.code-workspace";
    const plain = row({ workspaceRoot: "/work/app" });
    const linked = row({
      workspaceRoot: "/work/app",
      workspaceFile,
      folders: [{ path: "/work/app", name: "app" }],
    });
    const meta = (fields: Partial<Extract<ProjectCommand, { type: "project.meta.update" }>>) =>
      ({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-meta"),
        projectId,
        ...fields,
      }) satisfies ProjectCommand;
    const folders = [{ path: "/work/app", name: "app" }];

    // Link gives up the plain root and claims the file.
    assert.deepEqual(projectCommandIdentities(meta({ workspaceFile, folders }), plain), {
      claimedFile: workspaceFile,
      roots: ["/work/app"],
      files: [workspaceFile],
    });
    // Relink claims the new file and releases the old one.
    assert.deepEqual(
      projectCommandIdentities(meta({ workspaceFile: "/work/b.code-workspace", folders }), linked),
      {
        claimedFile: "/work/b.code-workspace",
        roots: [],
        files: ["/work/app.code-workspace", "/work/b.code-workspace"],
      },
    );
    // Unlink claims the root back and releases the file.
    assert.deepEqual(
      projectCommandIdentities(meta({ workspaceFile: null, folders: null }), linked),
      { claimedRoot: "/work/app", roots: ["/work/app"], files: [workspaceFile] },
    );
    // A refresh that moves the primary claims nothing: linked projects own no root.
    assert.deepEqual(
      projectCommandIdentities(meta({ workspaceRoot: "/work/api", folders }), linked),
      { roots: [], files: [] },
    );
    assert.deepEqual(projectCommandIdentities(meta({ workspaceRoot: "/work/x" }), plain), {
      claimedRoot: "/work/x",
      roots: ["/work/x"],
      files: [],
    });
    assert.deepEqual(projectCommandIdentities(meta({ title: "Renamed" }), plain), {
      roots: [],
      files: [],
    });
  });

  it("deletes with a single project.deleted event", () => {
    const event = Result.getOrThrow(
      plan(
        { type: "project.delete", commandId: CommandId.make("cmd-delete"), projectId },
        { project: row() },
      ),
    );
    assert.equal(event.type, "project.deleted");
    assert.deepEqual(event.payload, { projectId, deletedAt: "2026-01-01T00:00:00.000Z" });
  });
});
