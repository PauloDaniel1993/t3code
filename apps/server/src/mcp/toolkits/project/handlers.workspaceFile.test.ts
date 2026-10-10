import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type WorkspaceFolderEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as IdAllocator from "../../../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import { OrchestrationV2EventSinkLayerLive } from "../../../orchestration-v2/runtimeLayer.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "../../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../../project/ProjectFaviconResolver.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as WorkspaceFolderResolver from "../../../project/WorkspaceFolderResolver.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectHandlersLive } from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:mcp-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const caller = {
  id: threadId,
  projectId: ProjectId.make("project:caller"),
  providerInstanceId,
  runtimeMode: "full-access",
  interactionMode: "default",
  archivedAt: null,
  deletedAt: null,
} as OrchestrationV2ThreadShell;

const dependencies = (workspaceFileProjects: boolean) =>
  Layer.mergeAll(
    OrchestrationV2EventSinkLayerLive,
    ProjectStore.layer,
    ProjectionStore.layer,
    IdAllocator.layer,
  ).pipe(
    Layer.provideMerge(
      LegacyV1ThreadImporter.layer.pipe(Layer.provide(OrchestrationV2EventSinkLayerLive)),
    ),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: () => Effect.succeed(null),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          resolvePath: () => Effect.succeed(null),
        }),
        WorkspaceFolderResolver.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, workspaceFileProjects };
        }),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mcp-project-file-" }))),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );

const testLayer = (enabled: boolean) =>
  Layer.mergeAll(
    Project.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:mcp-project"),
      threadId,
      providerSessionId: "session",
      providerInstanceId,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(caller),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/unused-projects",
      createNamedProject: () => Effect.die("A file import must not create a named project."),
    }),
  ).pipe(Layer.provideMerge(dependencies(enabled)));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mcp-workspace-file-" });
  for (const folder of ["app", "lib", "other"]) yield* fs.makeDirectory(path.join(root, folder));
  const at = (name: string) => path.join(root, name);
  const write = (name: string, folders: ReadonlyArray<WorkspaceFolderEntry>) =>
    fs.writeFileString(at(name), encodeJson({ folders })).pipe(Effect.as(at(name)));
  return { fs, at, write };
});

const toolkit = ProjectToolkit.pipe(Effect.provide(ProjectHandlersLive));

it.layer(testLayer(true))("workspace-file project MCP tools", (it) => {
  it.effect("imports, reads and pages one project with ordered folder facts", () =>
    Effect.gen(function* () {
      const tools = yield* toolkit;
      const dir = yield* fixture;
      const initial = yield* (yield* Project.ProjectService).snapshot;
      const expectedCount =
        initial.projects.filter((project) => project.deletedAt === null).length + 2;
      const file = yield* dir.write("team.code-workspace", [
        { path: "app", name: "App" },
        { path: "lib", name: "Library" },
        { path: "gone", name: "Missing" },
        { uri: "vscode-remote://ssh-remote+devbox/srv/api", name: "Remote" },
      ]);
      const imported = yield* tools
        .handle("t3_project_create", { workspaceFilePath: file })
        .pipe(Stream.unwrap, Stream.runCollect);
      const project = imported.at(-1)?.result;
      expect(project).toMatchObject({
        title: "team",
        workspaceFile: file,
        workspaceRoot: dir.at("app"),
        folders: [
          { path: dir.at("app"), name: "App", label: "App", availability: "available", vcs: null },
          { path: dir.at("lib"), name: "Library", availability: "available", vcs: null },
          { path: dir.at("gone"), availability: "unavailable", unavailableReason: "missing" },
          {
            uri: "vscode-remote://ssh-remote+devbox/srv/api",
            availability: "unavailable",
            unavailableReason: "remote",
          },
        ],
      });
      if (project === undefined || !("id" in project)) throw new Error("Import failed");
      const read = yield* tools
        .handle("t3_project_read", { projectId: project.id })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(read.at(-1)?.result).toEqual(project);
      const plain = yield* tools
        .handle("t3_project_create", { title: "Plain", workspaceRoot: dir.at("app") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(plain.at(-1)?.result).toMatchObject({
        workspaceFile: null,
        folders: [{ path: dir.at("app"), name: "app", label: "app" }],
      });
      const listed: Array<ProjectRecord> = [];
      for (let cursor = 0; cursor < expectedCount; cursor += 1) {
        const result = yield* tools
          .handle("t3_project_list", { cursor, limit: 1 })
          .pipe(Stream.unwrap, Stream.runCollect);
        const page = result.at(-1)?.result;
        if (page === undefined || !("projects" in page)) throw new Error("List failed");
        expect(page.projects).toHaveLength(1);
        expect(page.nextCursor).toBe(cursor + 1 < expectedCount ? cursor + 1 : null);
        listed.push(...page.projects);
      }
      expect(listed.filter((row) => row.id === project.id)).toEqual([project]);
      expect(
        listed.filter((row) => row.workspaceFile === null && row.workspaceRoot === dir.at("app")),
      ).toEqual([plain.at(-1)?.result]);
    }),
  );

  it.effect("links, relinks, refreshes and unlinks through update while preserving settings", () =>
    Effect.gen(function* () {
      const tools = yield* toolkit;
      const dir = yield* fixture;
      const created = yield* tools
        .handle("t3_project_create", { title: "Existing", workspaceRoot: dir.at("app") })
        .pipe(Stream.unwrap, Stream.runCollect);
      const plain = created.at(-1)?.result;
      if (plain === undefined || !("id" in plain)) throw new Error("Create failed");
      yield* tools
        .handle("t3_project_update", { projectId: plain.id, autoPull: true })
        .pipe(Stream.unwrap, Stream.runCollect);
      const update = (workspaceFilePath: string | null) =>
        tools
          .handle("t3_project_update", { projectId: plain.id, workspaceFilePath })
          .pipe(Stream.unwrap, Stream.runCollect);
      const file = yield* dir.write("team.code-workspace", [
        { path: "app", name: "App" },
        { path: "lib", name: "Lib" },
      ]);
      const linked = yield* update(file);
      expect(linked.at(-1)?.result).toMatchObject({
        id: plain.id,
        title: "Existing",
        autoPull: true,
        workspaceFile: file,
        folders: [{ name: "App" }, { name: "Lib" }],
      });
      const mixed = yield* tools
        .handle("t3_project_update", {
          projectId: plain.id,
          workspaceFilePath: file,
          title: "Dropped",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(mixed.at(-1)?.result).toMatchObject({ code: "invalid_request" });
      const rootEdit = yield* tools
        .handle("t3_project_update", { projectId: plain.id, workspaceRoot: dir.at("other") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(rootEdit.at(-1)?.result).toMatchObject({ code: "invalid_request" });
      const replacement = yield* dir.write("replacement.code-workspace", [
        { path: "other", name: "Other" },
      ]);
      expect((yield* update(replacement)).at(-1)?.result).toMatchObject({
        workspaceRoot: dir.at("other"),
        workspaceFile: replacement,
      });
      yield* dir.write("replacement.code-workspace", [
        { path: "other", name: "Other" },
        { path: "lib", name: "Library" },
      ]);
      expect((yield* update(replacement)).at(-1)?.result).toMatchObject({
        folders: [{ name: "Other" }, { name: "Library" }],
      });
      yield* dir.fs.remove(replacement);
      expect((yield* update(null)).at(-1)?.result).toMatchObject({
        id: plain.id,
        title: "Existing",
        autoPull: true,
        workspaceRoot: dir.at("other"),
        workspaceFile: null,
        folders: [{ name: "other" }],
      });
      const deleted = yield* tools
        .handle("t3_project_delete", { projectId: plain.id })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(deleted.at(-1)?.result).toMatchObject({
        workspaceFile: null,
        folders: [{ path: dir.at("other") }],
      });
    }),
  );

  it.effect("returns diagnostics and conflict IDs without changing the existing project", () =>
    Effect.gen(function* () {
      const tools = yield* toolkit;
      const dir = yield* fixture;
      const file = yield* dir.write("team.code-workspace", [{ path: "app", name: "App" }]);
      const create = () =>
        tools
          .handle("t3_project_create", { workspaceFilePath: file, title: "Explicit title" })
          .pipe(Stream.unwrap, Stream.runCollect);
      const project = (yield* create()).at(-1)?.result;
      if (project === undefined || !("id" in project)) throw new Error("Import failed");
      expect(project.title).toBe("Explicit title");
      expect((yield* create()).at(-1)?.result).toMatchObject({
        code: "invalid_request",
        diagnostic: { code: "conflict", path: file },
        conflictingProjectId: project.id,
      });
      const plain = (yield* tools
        .handle("t3_project_create", { title: "Plain", workspaceRoot: dir.at("app") })
        .pipe(Stream.unwrap, Stream.runCollect)).at(-1)?.result;
      if (plain === undefined || !("id" in plain)) throw new Error("Create failed");
      const unlink = yield* tools
        .handle("t3_project_update", { projectId: project.id, workspaceFilePath: null })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(unlink.at(-1)?.result).toMatchObject({
        code: "invalid_request",
        conflictingProjectId: plain.id,
      });
      const read = yield* tools
        .handle("t3_project_read", { projectId: project.id })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(read.at(-1)?.result).toEqual(project);
      const malformed = dir.at("bad.code-workspace");
      yield* dir.fs.writeFileString(malformed, "{ invalid");
      const rejected = yield* tools
        .handle("t3_project_create", { workspaceFilePath: malformed })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(rejected.at(-1)?.result).toMatchObject({
        code: "invalid_request",
        diagnostic: { code: "malformed-jsonc", path: malformed },
      });
      const missingPrimary = yield* dir.write("missing.code-workspace", [
        { path: "gone", name: "Gone" },
      ]);
      const unavailable = yield* tools
        .handle("t3_project_create", { workspaceFilePath: missingPrimary })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(unavailable.at(-1)?.result).toMatchObject({
        code: "invalid_request",
        diagnostic: { code: "primary-unusable", path: dir.at("gone"), entryIndex: 0 },
      });
    }),
  );

  it.effect("rejects missing titles and mixed create modes without registering a project", () =>
    Effect.gen(function* () {
      const tools = yield* toolkit;
      const dir = yield* fixture;
      const file = yield* dir.write("team.code-workspace", [{ path: "app", name: "App" }]);
      const before = yield* (yield* Project.ProjectService).snapshot;
      for (const input of [
        {},
        { workspaceRoot: dir.at("app") },
        { workspaceFilePath: file, workspaceRoot: dir.at("app") },
        { workspaceFilePath: file, createWorkspaceRootIfMissing: false },
        { workspaceFilePath: file, scripts: [] },
        { workspaceFilePath: file, defaultModelSelection: null },
      ]) {
        const rejected = yield* tools
          .handle("t3_project_create", input)
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
      }
      expect((yield* (yield* Project.ProjectService).snapshot).projects).toEqual(before.projects);
    }),
  );
});

it.layer(testLayer(false))("disabled workspace-file project MCP tools", (it) => {
  it.effect("refuses import and link without falling back to named creation", () =>
    Effect.gen(function* () {
      const tools = yield* toolkit;
      const dir = yield* fixture;
      const file = yield* dir.write("team.code-workspace", [{ path: "app", name: "App" }]);
      const imported = yield* tools
        .handle("t3_project_create", { workspaceFilePath: file, title: "Team" })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(imported.at(-1)?.encodedResult).toMatchObject({
        code: "invalid_request",
        message: "Workspace-file projects are not enabled on this server.",
      });
      const created = yield* tools
        .handle("t3_project_create", { title: "Plain", workspaceRoot: dir.at("app") })
        .pipe(Stream.unwrap, Stream.runCollect);
      const project = created.at(-1)?.result;
      if (project === undefined || !("id" in project)) throw new Error("Create failed");
      const linked = yield* tools
        .handle("t3_project_update", { projectId: project.id, workspaceFilePath: file })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(linked.at(-1)?.encodedResult).toMatchObject({
        code: "invalid_request",
        message: "Workspace-file projects are not enabled on this server.",
      });
      expect((yield* (yield* Project.ProjectService).snapshot).projects).toHaveLength(1);
    }),
  );
});
