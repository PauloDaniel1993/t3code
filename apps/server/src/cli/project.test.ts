import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  AuthAdministrativeScopes,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  EventId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ProjectId,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient, HttpRouter, HttpPlatform, Etag } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  ProjectServiceLayerLive,
} from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as WorkspaceFolderResolver from "../project/WorkspaceFolderResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectHttpApiLayer } from "../project/http.ts";
import { persistServerRuntimeState } from "../serverRuntimeState.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  projectCommandErrorFromLiveServerRequest,
} from "./project.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(CliRuntimeLayer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  );

const makeConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

const readProjects = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const layer = ProjectServiceLayerLive.pipe(
      Layer.provideMerge(ProjectEnrichmentService.layer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(WorkspaceFolderResolver.layer),
      Layer.provideMerge(ProjectFaviconResolver.layer),
      Layer.provideMerge(T3ProjectFileLoader.layer),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
    return yield* ProjectService.ProjectService.pipe(
      Effect.flatMap((projects) => projects.snapshot),
      Effect.provide(layer),
    );
  });

const workspaceFileEnvironment = { T3CODE_WORKSPACE_FILE_PROJECTS: "true" };

class ProjectCliTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.projects,
) {}

it.effect("uses the same import service over live HTTP and preserves its file conflict", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-live-file-" });
    const baseDir = NodePath.join(root, "state");
    const primary = NodePath.join(root, "app");
    const filePath = NodePath.join(root, "Live Team.code-workspace");
    yield* fs.makeDirectory(primary);
    yield* fs.writeFileString(filePath, '{"folders":[{"path":"app"}]}');
    const config = { ...(yield* makeConfig(baseDir)), workspaceFileProjects: true };
    const serviceLayer = ProjectServiceLayerLive.pipe(
      Layer.provideMerge(ProjectEnrichmentService.layer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(WorkspaceFolderResolver.layer),
      Layer.provideMerge(ProjectFaviconResolver.layer),
      Layer.provideMerge(T3ProjectFileLoader.layer),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provide(ServerConfig.layer(config)),
    );
    const authLayer = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
      effect.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, {
          sessionId: AuthSessionId.make("test"),
          subject: "test",
          method: "bearer-access-token",
          scopes: new Set(AuthAdministrativeScopes),
        }),
      ),
    );
    const startupLayer = Layer.succeed(ServerRuntimeStartup, {
      awaitCommandReady: Effect.void,
      markHttpListening: Effect.void,
      enqueueCommand: (effect) => effect,
    });
    const routesLayer = HttpApiBuilder.layer(ProjectCliTestApi).pipe(
      Layer.provide(projectHttpApiLayer),
      Layer.provide(serviceLayer),
      Layer.provide(authLayer),
      Layer.provide(startupLayer),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const web = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      (web) => Effect.promise(() => web.dispose()),
    );
    // A running server has finished startup before the CLI's one-second probe.
    const ready = yield* Effect.promise(() =>
      web.handler(
        new Request(
          `http://project.test${EnvironmentHttpApi.groups.projects.endpoints.snapshot.path}`,
        ),
      ),
    );
    assert.equal(ready.status, 200);
    yield* persistServerRuntimeState({
      path: config.serverRuntimeStatePath,
      state: {
        version: 1,
        pid: process.pid,
        port: 1,
        origin: "http://project.test",
        startedAt: "2026-10-10T00:00:00Z",
      },
    });
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return web.handler(request);
    };
    yield* runCli(
      ["project", "add", filePath, "--title", "  Explicit title  ", "--base-dir", baseDir],
      workspaceFileEnvironment,
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    const added = (yield* readProjects(baseDir)).projects[0]!;
    assert.equal(added.title, "Explicit title");
    assert.equal(added.workspaceFile, filePath);
    assert.include(requests, "POST /api/projects/mutate");
    const duplicate = yield* runCli(
      ["project", "add", filePath, "--base-dir", baseDir],
      workspaceFileEnvironment,
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.flip);
    assert.instanceOf(duplicate, ProjectLiveServerDeclaredResponseError);
    assert.equal(duplicate.diagnostic?.code, "conflict");
    assert.equal(duplicate.conflictingProjectId, added.id);
    assert.equal((yield* readProjects(baseDir)).projects.length, 1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("imports workspace files alongside plain projects and preserves file identity", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-file-" });
    const baseDir = NodePath.join(root, "state");
    const primary = NodePath.join(root, "app");
    const secondary = NodePath.join(root, "shared");
    const filePath = NodePath.join(root, "Team Space.CODE-WORKSPACE");
    yield* fs.makeDirectory(primary);
    yield* fs.makeDirectory(secondary);
    yield* fs.writeFileString(
      filePath,
      '{ // JSONC\n "folders": [{"path":"app"}, {"path":"shared", "name":"Shared"}], }',
    );
    yield* runCli(["project", "add", filePath, "--base-dir", baseDir], workspaceFileEnvironment);
    yield* runCli(["project", "add", primary, "--base-dir", baseDir]);
    const snapshot = yield* readProjects(baseDir);
    assert.equal(snapshot.projects.length, 2);
    const linked = snapshot.projects.find((project) => project.workspaceFile != null)!;
    assert.equal(linked.title, "Team Space");
    assert.equal(linked.workspaceRoot, primary);
    assert.deepEqual(
      linked.folders?.map((folder) => folder.path),
      [primary, secondary],
    );
    const duplicate = yield* runCli(
      ["project", "add", filePath, "--base-dir", baseDir],
      workspaceFileEnvironment,
    ).pipe(Effect.flip);
    assert.equal((duplicate as { conflictingProjectId?: string }).conflictingProjectId, linked.id);
    yield* runCli(["project", "rename", primary, "Plain", "--base-dir", baseDir]);
    assert.equal(
      (yield* readProjects(baseDir)).projects.find((project) => project.id === linked.id)?.title,
      "Team Space",
    );
    const plain = (yield* readProjects(baseDir)).projects.find(
      (project) => project.workspaceFile == null,
    )!;
    const unlinkConflict = yield* runCli([
      "project",
      "unlink",
      filePath,
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);
    assert.equal(
      (unlinkConflict as { conflictingProjectId?: string }).conflictingProjectId,
      plain.id,
    );
    assert.equal(
      (yield* readProjects(baseDir)).projects.find((project) => project.id === linked.id)
        ?.workspaceFile,
      filePath,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("links, relinks, rereads and unlinks through the project mutation service", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-link-" });
    const baseDir = NodePath.join(root, "state");
    const primary = NodePath.join(root, "app");
    yield* fs.makeDirectory(primary);
    yield* runCli(["project", "add", primary, "--base-dir", baseDir]);
    const id = (yield* readProjects(baseDir)).projects[0]!.id;
    const first = NodePath.join(root, "first.code-workspace");
    const second = NodePath.join(root, "second.code-workspace");
    yield* fs.writeFileString(first, '{"folders":[{"path":"app"}]}');
    yield* fs.writeFileString(second, '{"folders":[{"path":"app"},{"path":"other"}]}');
    const disabledLink = yield* runCli(["project", "link", id, first, "--base-dir", baseDir]).pipe(
      Effect.flip,
    );
    assert.equal((disabledLink as { _tag?: string })._tag, "WorkspaceFileProjectsDisabledError");
    yield* runCli(["project", "link", id, first, "--base-dir", baseDir], workspaceFileEnvironment);
    yield* runCli(
      ["project", "link", first, second, "--base-dir", baseDir],
      workspaceFileEnvironment,
    );
    yield* fs.writeFileString(second, '{"folders":[{"path":"app"},{"path":"shared"}]}');
    yield* runCli(["project", "link", id, second, "--base-dir", baseDir], workspaceFileEnvironment);
    assert.equal((yield* readProjects(baseDir)).projects[0]?.folders?.length, 2);
    yield* fs.remove(second);
    yield* runCli(["project", "unlink", second, "--base-dir", baseDir]);
    const unlinked = (yield* readProjects(baseDir)).projects[0]!;
    assert.isTrue(unlinked.workspaceFile == null);
    assert.isUndefined(unlinked.folders);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps suffix-named directories plain and never creates missing file paths", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-file-errors-" });
    const baseDir = NodePath.join(root, "state");
    const directory = NodePath.join(root, "folder.code-workspace");
    yield* fs.makeDirectory(directory);
    yield* runCli(["project", "add", directory, "--base-dir", baseDir]);
    assert.isTrue((yield* readProjects(baseDir)).projects[0]?.workspaceFile == null);
    const missing = NodePath.join(root, "missing.code-workspace");
    const disabled = yield* runCli(["project", "add", missing, "--base-dir", baseDir]).pipe(
      Effect.flip,
    );
    assert.equal((disabled as { _tag?: string })._tag, "WorkspaceFileProjectsDisabledError");
    const absent = yield* runCli(
      ["project", "add", missing, "--base-dir", baseDir],
      workspaceFileEnvironment,
    ).pipe(Effect.flip);
    assert.equal((absent as { diagnostic?: { code: string } }).diagnostic?.code, "file-not-found");
    assert.isFalse(yield* fs.exists(missing));
    const malformed = NodePath.join(root, "bad.code-workspace");
    yield* fs.writeFileString(malformed, '{"folders":[');
    const broken = yield* runCli(
      ["project", "add", malformed, "--base-dir", baseDir],
      workspaceFileEnvironment,
    ).pipe(Effect.flip);
    assert.equal((broken as { diagnostic?: { code: string } }).diagnostic?.code, "malformed-jsonc");
    const emptyTitle = yield* runCli(
      ["project", "add", malformed, "--title", "   ", "--base-dir", baseDir],
      workspaceFileEnvironment,
    ).pipe(Effect.flip);
    assert.equal((emptyTitle as { _tag?: string })._tag, "ProjectTitleEmptyError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("preserves live workspace diagnostics and conflict identity", () => {
  const diagnostic = {
    code: "conflict" as const,
    message: "Already linked",
    path: "C:/Team Space/team.code-workspace",
  };
  const cause = new EnvironmentRequestInvalidError({
    code: "invalid_request",
    reason: "invalid_command",
    traceId: "trace",
    detail: diagnostic.message,
    diagnostic,
    conflictingProjectId: "existing" as ProjectId,
  });
  const error = projectCommandErrorFromLiveServerRequest(cause);
  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.equal(error.message, diagnostic.message);
  assert.deepEqual(error.diagnostic, diagnostic);
  assert.equal(error.conflictingProjectId, cause.conflictingProjectId);
});

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "access_token_issuance_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it.effect("adds, renames, and removes projects through the V2 project CLI domain", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-cli-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-v2-project-workspace-"),
    );

    yield* runCli(["project", "add", workspaceRoot, "--title", "Alpha", "--base-dir", baseDir]);
    const added = (yield* readProjects(baseDir)).projects[0];
    assert.equal(added?.title, "Alpha");
    assert.equal(added?.workspaceRoot, workspaceRoot);

    yield* runCli(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
    assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Beta");

    yield* runCli(["project", "remove", added?.id ?? "", "--base-dir", baseDir]);
    assert.deepEqual((yield* readProjects(baseDir)).projects, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const makeProjectLookupFixture = Effect.fn("ProjectCliTest.makeProjectLookupFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-lookup-" });
  const baseDir = NodePath.join(root, "state");
  const workspaceRoot = NodePath.join(root, "workspace");
  yield* fs.makeDirectory(workspaceRoot);
  yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
  const project = (yield* readProjects(baseDir)).projects[0];
  assert.isDefined(project);
  return { baseDir, workspaceRoot, project: project! };
});

const makeThreadPersistenceLayer = Effect.fn("ProjectCliTest.makeThreadPersistenceLayer")(
  function* (baseDir: string) {
    const config = yield* makeConfig(baseDir);
    return Layer.mergeAll(
      OrchestrationV2EventSinkLayerLive,
      ProjectionStore.layer,
      EventStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
  },
);

const seedNativeThreads = Effect.fn("ProjectCliTest.seedNativeThreads")(function* (
  baseDir: string,
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly archived: boolean;
  }>,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  const createdAt = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  yield* Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      commandId: CommandId.make("project-cli-seed-threads"),
      events: threads.map(({ id, projectId, archived }) => {
        const payload: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id,
          projectId,
          title: id,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: archived ? createdAt : null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        return {
          id: EventId.make(`project-cli-create-${id}`),
          type: "thread.created" as const,
          threadId: id,
          providerInstanceId,
          occurredAt: createdAt,
          payload,
        };
      }),
    });
  }).pipe(Effect.provide(layer));
});

const readNativeThreadState = Effect.fn("ProjectCliTest.readNativeThreadState")(function* (
  baseDir: string,
  threadId: ThreadId,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  return yield* Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    return {
      thread: yield* projections.getThread(threadId),
      events: yield* events.read({ threadId }).pipe(Stream.runCollect),
    };
  }).pipe(Effect.provide(layer));
});

it.layer(NodeServices.layer)("project deletion with native V2 threads", (it) => {
  it.effect.each([
    { label: "an active thread", archived: false, missing: false },
    { label: "an archived thread", archived: true, missing: false },
    {
      label: "an active thread after its workspace disappears",
      archived: false,
      missing: true,
    },
    {
      label: "an archived thread after its workspace disappears",
      archived: true,
      missing: true,
    },
  ])("rejects unforced removal of a project with $label", ({ archived, missing }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      const threadId = ThreadId.make("project-cli-preserved-thread");
      yield* seedNativeThreads(baseDir, [{ id: threadId, projectId: project.id, archived }]);
      const before = yield* readNativeThreadState(baseDir, threadId);
      if (missing) yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);

      const error = yield* runCli([
        "project",
        "remove",
        missing ? workspaceRoot : project.id,
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Removing a nonempty project must require --force."),
        }),
      );

      assert.include(error.message, "not empty");
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual(yield* readNativeThreadState(baseDir, threadId), before);
      assert.equal(yield* fs.exists(workspaceRoot), !missing);
    }),
  );

  it.effect.each(["present", "missing"] as const)(
    "force-removes active and archived V2 threads with the workspace %s, preserving unrelated projects",
    (workspace) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        const otherWorkspace = `${workspaceRoot}-other`;
        yield* fs.makeDirectory(otherWorkspace);
        yield* runCli(["project", "add", otherWorkspace, "--base-dir", baseDir]);
        const otherProject = (yield* readProjects(baseDir)).projects.find(
          (entry) => entry.workspaceRoot === otherWorkspace,
        );
        assert.isDefined(otherProject);
        const activeId = ThreadId.make("project-cli-deleted-active");
        const archivedId = ThreadId.make("project-cli-deleted-archived");
        const unrelatedId = ThreadId.make("project-cli-unrelated-thread");
        yield* seedNativeThreads(baseDir, [
          { id: activeId, projectId: project.id, archived: false },
          { id: archivedId, projectId: project.id, archived: true },
          { id: unrelatedId, projectId: otherProject!.id, archived: false },
        ]);
        const unrelatedBefore = yield* readNativeThreadState(baseDir, unrelatedId);
        if (workspace === "missing") {
          yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        }

        yield* runCli([
          "project",
          "remove",
          workspace === "missing" ? workspaceRoot : project.id,
          "--force",
          "--base-dir",
          baseDir,
        ]);

        assert.deepEqual(
          (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
          [otherProject!.id],
        );
        for (const threadId of [activeId, archivedId]) {
          const state = yield* readNativeThreadState(baseDir, threadId);
          assert.isNotNull(state.thread.deletedAt);
          assert.lengthOf(
            state.events.filter((record) => record.event.type === "thread.deleted"),
            1,
          );
        }
        assert.deepEqual(yield* readNativeThreadState(baseDir, unrelatedId), unrelatedBefore);
        assert.equal(yield* fs.exists(workspaceRoot), workspace === "present");
        assert.isTrue(yield* fs.exists(otherWorkspace));
      }),
  );
});

it.layer(NodeServices.layer)("project lookup with unavailable workspaces", (it) => {
  it.effect.each(["id", "stored path"] as const)(
    "removes an empty project by %s after its directory is gone",
    (identifier) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        yield* runCli([
          "project",
          "remove",
          identifier === "id" ? project.id : workspaceRoot,
          "--base-dir",
          baseDir,
        ]);
        assert.deepEqual((yield* readProjects(baseDir)).projects, []);
        assert.isFalse(yield* fs.exists(workspaceRoot));
      }),
  );

  it.effect("renames by ID and stored path after the directory is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      for (const [identifier, title] of [
        [project.id, "Renamed by ID"],
        [workspaceRoot, "Renamed by stored path"],
      ] as const) {
        yield* runCli(["project", "rename", identifier, title, "--base-dir", baseDir]);
        assert.equal((yield* readProjects(baseDir)).projects[0]?.title, title);
      }
      assert.isFalse(yield* fs.exists(workspaceRoot));
    }),
  );

  it.effect("does not resolve another environment's project ID in an empty database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      const replacementDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-empty-" });
      const error = yield* runCli([
        "project",
        "remove",
        project.id,
        "--force",
        "--base-dir",
        replacementDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "No active project found");
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual((yield* readProjects(replacementDir)).projects, []);
    }),
  );

  it.effect("normalizes existing paths without conflating separately registered symlinks", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* runCli([
        "project",
        "rename",
        `${workspaceRoot}${NodePath.sep}.`,
        "Normalized",
        "--base-dir",
        baseDir,
      ]);
      assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Normalized");
      const aliasPath = `${workspaceRoot}-alias`;
      NodeFS.symlinkSync(workspaceRoot, aliasPath, "junction");
      const unknownAlias = yield* runCli([
        "project",
        "remove",
        aliasPath,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.include(unknownAlias.message, "No active project found");
      yield* runCli(["project", "add", aliasPath, "--base-dir", baseDir]);
      const added = (yield* readProjects(baseDir)).projects;
      assert.equal(added.length, 2);
      const aliasProject = added.find((entry) => entry.workspaceRoot === aliasPath);
      assert.isDefined(aliasProject);
      assert.notEqual(aliasProject?.id, project.id);
      yield* runCli(["project", "remove", `${aliasPath}${NodePath.sep}.`, "--base-dir", baseDir]);
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.isTrue(NodeFS.existsSync(workspaceRoot));
    }),
  );
});
