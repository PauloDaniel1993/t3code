import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { OrchestrationV2EventSinkLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as WorkspaceFiles from "./WorkspaceFiles.ts";
import * as WorkspaceFolderResolver from "./WorkspaceFolderResolver.ts";

const configLayer = (workspaceFileProjects: boolean) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, workspaceFileProjects };
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "project-workspace-file-" })),
  );

/** Every dependency of ProjectService.make, with real folders, git and workspace files. */
const dependencies = (workspaceFileProjects: boolean) =>
  Layer.mergeAll(
    OrchestrationV2EventSinkLayerLive,
    ProjectStore.layer,
    ProjectionStore.layer,
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    WorkspaceFiles.layer,
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
    Layer.provideMerge(configLayer(workspaceFileProjects)),
    Layer.provideMerge(NodeServices.layer),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const result = yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, "-c", "user.email=t3@example.com", "-c", "user.name=T3", ...args],
    });
    if (result.code !== 0) return yield* Effect.die(new Error(result.stderr));
  }).pipe(Effect.provide(ProcessRunner.layer));

/** A temp directory with the named folders, and a writer for workspace files in it. */
const workspace = Effect.fn("ProjectWorkspaceFileTest.workspace")(function* (
  folders: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-linked-project-" });
  for (const folder of folders)
    yield* fs.makeDirectory(path.join(root, folder), { recursive: true });
  const writeFile = (name: string, folderPaths: ReadonlyArray<string>) =>
    fs
      .writeFileString(
        path.join(root, name),
        JSON.stringify({ folders: folderPaths.map((folderPath) => ({ path: folderPath })) }),
      )
      .pipe(Effect.as(path.join(root, name)));
  return { root, at: (...segments: Array<string>) => path.join(root, ...segments), writeFile };
});

const seedThread = Effect.fn("ProjectWorkspaceFileTest.seedThread")(function* (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly worktreePath?: string;
  readonly branch?: string;
}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: input.projectId,
    title: input.threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`created:${input.threadId}`),
        type: "thread.created",
        threadId: input.threadId,
        providerInstanceId,
        occurredAt: createdAt,
        payload,
      },
    ],
  });
});

const commandId = (name: string) => CommandId.make(`command:${name}`);

it.layer(dependencies(true))("ProjectService workspace files", (it) => {
  it.effect("imports a workspace file as a project at its first folder, with folder facts", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const dir = yield* workspace(["app", "lib"]);
      const filePath = yield* dir.writeFile("team.code-workspace", ["app", "lib", "gone"]);
      const projectId = ProjectId.make("project:import");

      const project = yield* service.importWorkspaceFile({
        commandId: commandId("import"),
        projectId,
        workspaceFilePath: filePath,
      });

      assert.equal(project.title, "team");
      assert.equal(project.workspaceRoot, dir.at("app"));
      assert.equal(project.workspaceFile, filePath);
      assert.deepEqual(
        project.folders?.map((folder) => [folder.label, folder.path, folder.availability]),
        [
          ["app", dir.at("app"), "available"],
          ["lib", dir.at("lib"), "available"],
          ["gone", dir.at("gone"), "unavailable"],
        ],
      );
      assert.equal(project.folders?.[2]?.unavailableReason, "missing");
      // Folders outside git say so; the primary never repeats the project's identity.
      assert.deepEqual(project.folders?.[0]?.vcs, null);

      const titled = yield* service.importWorkspaceFile({
        commandId: commandId("import-titled"),
        projectId: ProjectId.make("project:import-titled"),
        workspaceFilePath: yield* dir.writeFile("other.code-workspace", ["lib"]),
        title: "Chosen",
      });
      assert.equal(titled.title, "Chosen");
    }),
  );

  it.effect("keeps a plain project at the same folder apart from the linked one", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const dir = yield* workspace(["app"]);
      const filePath = yield* dir.writeFile("app.code-workspace", ["app"]);
      const linked = yield* service.importWorkspaceFile({
        commandId: commandId("coexist-linked"),
        projectId: ProjectId.make("project:coexist-linked"),
        workspaceFilePath: filePath,
      });
      const plain = yield* service.create({
        commandId: commandId("coexist-plain"),
        projectId: ProjectId.make("project:coexist-plain"),
        title: "App",
        workspaceRoot: dir.at("app"),
      });
      assert.equal(plain.workspaceFile, undefined);
      assert.equal(linked.workspaceRoot, plain.workspaceRoot);

      // Folder lookups (desktop activation, the CLI) find the plain project.
      const byRoot = yield* service.getByWorkspaceRoot(dir.at("app"));
      assert.equal(Option.getOrThrow(byRoot).id, plain.id);

      const again = yield* service
        .importWorkspaceFile({
          commandId: commandId("coexist-again"),
          projectId: ProjectId.make("project:coexist-again"),
          workspaceFilePath: filePath,
        })
        .pipe(Effect.flip);
      assert.equal(again._tag, "ProjectFileConflictError");
      assert.equal(
        again._tag === "ProjectFileConflictError" ? again.conflictingProjectId : undefined,
        linked.id,
      );
      const secondPlain = yield* service
        .create({
          commandId: commandId("coexist-second-plain"),
          projectId: ProjectId.make("project:coexist-second-plain"),
          title: "App",
          workspaceRoot: dir.at("app"),
        })
        .pipe(Effect.flip);
      assert.equal(secondPlain._tag, "ProjectConflictError");
    }),
  );

  it.effect("rejects a file it can't use without creating anything", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const dir = yield* workspace(["lib"]);
      const reject = (name: string, workspaceFilePath: string) =>
        service
          .importWorkspaceFile({
            commandId: commandId(name),
            projectId: ProjectId.make(`project:${name}`),
            workspaceFilePath,
          })
          .pipe(
            Effect.flip,
            Effect.map((error) =>
              error._tag === "WorkspaceFileUnavailableError" ? error.diagnostic.code : error._tag,
            ),
          );

      assert.equal(
        yield* reject("reject-missing", dir.at("missing.code-workspace")),
        "file-not-found",
      );
      assert.equal(
        yield* reject("reject-primary", yield* dir.writeFile("x.code-workspace", ["gone", "lib"])),
        "primary-unusable",
      );
      assert.isTrue(
        Option.isNone(yield* service.getById(ProjectId.make("project:reject-primary"))),
      );
      // No folder is ever created for a file.
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(dir.at("gone")));
    }),
  );

  it.effect("links a plain project whose folder leads the file, freezing its threads", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* workspace(["app", "lib"]);
      yield* fs.writeFileString(dir.at("app", "README.md"), "app\n");
      yield* git(dir.at("app"), ["init", "--initial-branch=main"]);
      yield* git(dir.at("app"), ["add", "."]);
      yield* git(dir.at("app"), ["commit", "-m", "init"]);
      yield* git(dir.at("app"), ["worktree", "add", "-b", "feature", dir.at("app-feature")]);

      const projectId = ProjectId.make("project:link");
      yield* service.create({
        commandId: commandId("link-create"),
        projectId,
        title: "App",
        workspaceRoot: dir.at("app"),
      });
      const rootThread = ThreadId.make("thread:link-root");
      const worktreeThread = ThreadId.make("thread:link-worktree");
      yield* seedThread({ projectId, threadId: rootThread });
      yield* seedThread({
        projectId,
        threadId: worktreeThread,
        worktreePath: dir.at("app-feature"),
        branch: "feature",
      });

      const mismatched = yield* service
        .linkWorkspaceFile({
          commandId: commandId("link-mismatch"),
          projectId,
          workspaceFilePath: yield* dir.writeFile("lib-first.code-workspace", ["lib", "app"]),
        })
        .pipe(Effect.flip);
      assert.equal(
        mismatched._tag === "WorkspaceFileUnavailableError" ? mismatched.diagnostic.code : "",
        "primary-unusable",
      );

      const linked = yield* service.linkWorkspaceFile({
        commandId: commandId("link"),
        projectId,
        workspaceFilePath: yield* dir.writeFile("team.code-workspace", ["app", "lib"]),
      });
      assert.equal(linked.id, projectId);
      assert.equal(linked.title, "App");
      assert.deepEqual(
        linked.folders?.map((folder) => folder.path),
        [dir.at("app"), dir.at("lib")],
      );

      // Each existing thread keeps the one folder it worked in; the link adds none.
      const appCheckout = yield* fs.realPath(dir.at("app"));
      const featureCheckout = yield* fs.realPath(dir.at("app-feature"));
      const root = yield* projections.getThread(rootThread);
      assert.deepEqual(root.workspaceFolders, [
        {
          path: dir.at("app"),
          name: "app",
          label: "app",
          checkoutRoot: appCheckout,
          checkoutPrefix: "",
        },
      ]);
      assert.isUndefined(root.worktrees);
      const worktree = yield* projections.getThread(worktreeThread);
      assert.deepEqual(
        worktree.workspaceFolders?.map((folder) => folder.path),
        [dir.at("app-feature")],
      );
      assert.deepEqual(worktree.worktrees, [
        { repositoryRoot: appCheckout, path: featureCheckout, branch: "feature" },
      ]);
      assert.equal(worktree.worktreePath, dir.at("app-feature"));
    }),
  );

  it.effect("relinks without moving bound threads, and unlinks back to a plain project", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const dir = yield* workspace(["app", "lib"]);
      const projectId = ProjectId.make("project:relink");
      yield* service.importWorkspaceFile({
        commandId: commandId("relink-import"),
        projectId,
        workspaceFilePath: yield* dir.writeFile("one.code-workspace", ["app", "lib"]),
      });
      const threadId = ThreadId.make("thread:relink");
      yield* seedThread({ projectId, threadId });
      yield* projections.getThread(threadId);
      // A thread of a linked project binds its own snapshot at creation.
      const snapshot = yield* service.snapshotWorkspaceFolders(projectId);
      const eventSink = yield* EventSink.EventSinkV2;
      const thread = yield* projections.getThread(threadId);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("bound:relink"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: thread.updatedAt,
            payload: { ...thread, workspaceFolders: snapshot! },
          },
        ],
      });

      const relinked = yield* service.linkWorkspaceFile({
        commandId: commandId("relink"),
        projectId,
        workspaceFilePath: yield* dir.writeFile("two.code-workspace", ["lib", "app"]),
      });
      assert.equal(relinked.workspaceRoot, dir.at("lib"));
      assert.equal(
        (yield* projections.getThread(threadId)).workspaceFolders?.[0]?.path,
        dir.at("app"),
      );
      // The shell has no folder list, so it names the thread's own primary.
      const shell = yield* projections.getThreadShell(threadId);
      assert.equal(shell?.workspacePrimaryPath, dir.at("app"));

      // A plain project now at the primary blocks unlinking until it goes.
      const plain = yield* service.create({
        commandId: commandId("relink-plain"),
        projectId: ProjectId.make("project:relink-plain"),
        title: "Lib",
        workspaceRoot: dir.at("lib"),
      });
      const blocked = yield* service
        .unlinkWorkspaceFile({ commandId: commandId("unlink-blocked"), projectId })
        .pipe(Effect.flip);
      assert.equal(
        blocked._tag === "ProjectConflictError" ? blocked.conflictingProjectId : blocked._tag,
        plain.id,
      );
      assert.equal(
        Option.getOrThrow(yield* service.getById(projectId)).workspaceFile,
        relinked.workspaceFile,
      );
      yield* service.delete({ commandId: commandId("relink-plain-delete"), projectId: plain.id });

      const unlinked = yield* service.unlinkWorkspaceFile({
        commandId: commandId("unlink"),
        projectId,
      });
      assert.equal(unlinked.workspaceRoot, dir.at("lib"));
      assert.isUndefined(unlinked.workspaceFile);
      assert.isUndefined(unlinked.folders);
      assert.equal((yield* projections.getThread(threadId)).workspaceFolders?.length, 2);
      assert.isTrue(Option.isSome(yield* service.getByWorkspaceRoot(dir.at("lib"))));
    }),
  );

  it.effect("snapshots a linked project's folders for a new thread", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* workspace(["app/web", "notes"]);
      yield* fs.writeFileString(dir.at("app", "web", "index.ts"), "export {};\n");
      yield* git(dir.at("app"), ["init", "--initial-branch=main"]);
      const filePath = path.join(dir.root, "team.code-workspace");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify({
          folders: [
            { path: "app/web", name: "Web" },
            { path: "notes" },
            { path: "gone" },
            { uri: "vscode-remote://ssh-remote+devbox/srv/api" },
          ],
        }),
      );
      const projectId = ProjectId.make("project:snapshot");
      yield* service.importWorkspaceFile({
        commandId: commandId("snapshot-import"),
        projectId,
        workspaceFilePath: filePath,
      });

      assert.deepEqual(yield* service.snapshotWorkspaceFolders(projectId), [
        {
          path: dir.at("app", "web"),
          name: "Web",
          label: "Web",
          checkoutRoot: yield* fs.realPath(dir.at("app")),
          checkoutPrefix: "web",
        },
        { path: dir.at("notes"), name: "notes", label: "notes", checkoutRoot: null },
        // Unavailable at binding: no checkout root, so never checkpointed for this thread.
        { path: dir.at("gone"), name: "gone", label: "gone" },
        { uri: "vscode-remote://ssh-remote+devbox/srv/api", name: "api", label: "api" },
      ]);

      yield* fs.remove(dir.at("app"), { recursive: true });
      const blocked = yield* service.snapshotWorkspaceFolders(projectId).pipe(Effect.flip);
      assert.equal(blocked._tag, "WorkspacePrimaryFolderUnavailableError");
    }),
  );

  it.effect("lets one of a competing relink and import claim a workspace file", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const dir = yield* workspace(["app", "lib"]);
      const firstFile = yield* dir.writeFile("first.code-workspace", ["app"]);
      const contested = yield* dir.writeFile("contested.code-workspace", ["lib"]);
      const relinking = ProjectId.make("project:race-relink");
      yield* (yield* ProjectService.make).importWorkspaceFile({
        commandId: commandId("race-relink-import"),
        projectId: relinking,
        workspaceFilePath: firstFile,
      });

      const reachedCommit = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Hold the relink between its plan and its commit, inside its locks.
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(
          EventSink.EventSinkV2,
          EventSink.EventSinkV2.of({
            ...eventSink,
            commitProjectCommand: (input) =>
              input.commandId === commandId("race-relink")
                ? Deferred.succeed(reachedCommit, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(eventSink.commitProjectCommand(input)),
                  )
                : eventSink.commitProjectCommand(input),
          }),
        ),
      );
      const relink = yield* service
        .linkWorkspaceFile({
          commandId: commandId("race-relink"),
          projectId: relinking,
          workspaceFilePath: contested,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(reachedCommit);
      const importing = yield* service
        .importWorkspaceFile({
          commandId: commandId("race-import"),
          projectId: ProjectId.make("project:race-import"),
          workspaceFilePath: contested,
        })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.isUndefined(importing.pollUnsafe());
      yield* Deferred.succeed(release, undefined);

      assert.equal((yield* Fiber.join(relink)).workspaceFile, contested);
      const lost = yield* Fiber.join(importing);
      assert.equal(
        lost._tag === "ProjectFileConflictError" ? lost.conflictingProjectId : lost._tag,
        relinking,
      );
    }),
  );

  it.effect("lets one of a competing unlink and plain create claim a folder", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const dir = yield* workspace(["app"]);
      const unlinking = ProjectId.make("project:race-unlink");
      yield* (yield* ProjectService.make).importWorkspaceFile({
        commandId: commandId("race-unlink-import"),
        projectId: unlinking,
        workspaceFilePath: yield* dir.writeFile("app.code-workspace", ["app"]),
      });

      const reachedCommit = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(
          EventSink.EventSinkV2,
          EventSink.EventSinkV2.of({
            ...eventSink,
            commitProjectCommand: (input) =>
              input.commandId === commandId("race-unlink")
                ? Deferred.succeed(reachedCommit, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(eventSink.commitProjectCommand(input)),
                  )
                : eventSink.commitProjectCommand(input),
          }),
        ),
      );
      const unlink = yield* service
        .unlinkWorkspaceFile({ commandId: commandId("race-unlink"), projectId: unlinking })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(reachedCommit);
      const creating = yield* service
        .create({
          commandId: commandId("race-create"),
          projectId: ProjectId.make("project:race-create"),
          title: "App",
          workspaceRoot: dir.at("app"),
        })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.isUndefined(creating.pollUnsafe());
      yield* Deferred.succeed(release, undefined);

      assert.isUndefined((yield* Fiber.join(unlink)).workspaceFile);
      const lost = yield* Fiber.join(creating);
      assert.equal(
        lost._tag === "ProjectConflictError" ? lost.conflictingProjectId : lost._tag,
        unlinking,
      );
    }),
  );

  it.effect(
    "rejects other edits mixed with a workspace-file change, and folder edits when linked",
    () =>
      Effect.gen(function* () {
        const service = yield* ProjectService.make;
        const dir = yield* workspace(["app", "lib"]);
        const projectId = ProjectId.make("project:mixed");
        yield* service.importWorkspaceFile({
          commandId: commandId("mixed-import"),
          projectId,
          workspaceFilePath: yield* dir.writeFile("app.code-workspace", ["app"]),
        });
        const mixed = yield* service
          .update({ commandId: commandId("mixed"), projectId, workspaceFilePath: null, title: "X" })
          .pipe(Effect.flip);
        assert.equal(mixed._tag, "ProjectInvalidRequestError");
        const moved = yield* service
          .update({ commandId: commandId("mixed-root"), projectId, workspaceRoot: dir.at("lib") })
          .pipe(Effect.flip);
        assert.equal(moved._tag, "ProjectInvalidRequestError");
      }),
  );
});

it.layer(dependencies(false))("ProjectService workspace files, turned off", (it) => {
  it.effect("refuses to import or link while the server has them off", () =>
    Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const dir = yield* workspace(["app"]);
      const filePath = yield* dir.writeFile("app.code-workspace", ["app"]);
      const imported = yield* service
        .importWorkspaceFile({
          commandId: commandId("off-import"),
          projectId: ProjectId.make("project:off-import"),
          workspaceFilePath: filePath,
        })
        .pipe(Effect.flip);
      assert.equal(imported._tag, "WorkspaceFileProjectsDisabledError");
      const projectId = ProjectId.make("project:off-plain");
      yield* service.create({
        commandId: commandId("off-plain"),
        projectId,
        title: "App",
        workspaceRoot: dir.at("app"),
      });
      const linked = yield* service
        .update({ commandId: commandId("off-link"), projectId, workspaceFilePath: filePath })
        .pipe(Effect.flip);
      assert.equal(linked._tag, "WorkspaceFileProjectsDisabledError");
    }),
  );
});
