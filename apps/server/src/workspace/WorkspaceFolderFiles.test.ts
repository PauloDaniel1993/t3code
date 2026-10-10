import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2AppThread,
  type ProjectContentMatch,
  type ProjectEntry,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type WorkspaceFolderEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspaceFolderFiles from "./WorkspaceFolderFiles.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const projectId = ProjectId.make("project:folder-files");
const threadId = ThreadId.make("thread:folder-files");

// Each test registers the project and thread it reads; the stores are stand-ins
// for persistence, which the service only reads.
const projectRows = new Map<ProjectId, ProjectStore.ProjectRow>();
const threads = new Map<ThreadId, OrchestrationV2AppThread>();

const StoresLayer = Layer.merge(
  Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (id) => Effect.succeed(Option.fromUndefinedOr(projectRows.get(id))),
  }),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThread: (id) => {
      const thread = threads.get(id);
      return thread === undefined
        ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }))
        : Effect.succeed(thread);
    },
  }),
);

const WorkspaceEntriesLive = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const PlatformLayer = Layer.empty.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-folder-files-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const folderFilesLayer = <R>(entries: Layer.Layer<WorkspaceEntries.WorkspaceEntries, never, R>) =>
  WorkspaceFolderFiles.layer.pipe(
    Layer.provide(
      WorkspaceFileSystem.layer.pipe(Layer.provide(WorkspacePaths.layer), Layer.provide(entries)),
    ),
    Layer.provide(entries),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(StoresLayer),
  );

const TestLayer = folderFilesLayer(WorkspaceEntriesLive).pipe(Layer.provideMerge(PlatformLayer));

function projectRow(input: {
  readonly workspaceRoot: string;
  readonly folders?: ReadonlyArray<WorkspaceFolderEntry>;
}): ProjectStore.ProjectRow {
  return {
    projectId,
    title: "Folders",
    workspaceRoot: input.workspaceRoot,
    workspaceFile: input.folders === undefined ? null : `${input.workspaceRoot}.code-workspace`,
    folders: input.folders === undefined ? null : [...input.folders],
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    deletedAt: null,
  };
}

function snapshotThread(input: {
  readonly worktreePath: string | null;
  readonly workspaceFolders: OrchestrationV2AppThread["workspaceFolders"];
  readonly worktrees?: OrchestrationV2AppThread["worktrees"];
}): OrchestrationV2AppThread {
  const now = DateTime.makeUnsafe("2026-10-10T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Folders",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.worktrees?.[0]?.branch ?? null,
    worktreePath: input.worktreePath,
    workspaceFolders: input.workspaceFolders,
    ...(input.worktrees === undefined ? {} : { worktrees: input.worktrees }),
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-folder-files-" });
});

const writeFiles = Effect.fn("writeFiles")(function* (
  root: string,
  files: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  }
});

/** A linked project with `app` as primary and `api` beside it, both under `root`. */
const appAndApi = Effect.fn("appAndApi")(function* (root: string) {
  const path = yield* Path.Path;
  const app = path.join(root, "app");
  const api = path.join(root, "api");
  projectRows.set(
    projectId,
    projectRow({
      workspaceRoot: app,
      folders: [
        { path: app, name: "app" },
        { path: api, name: "api" },
      ],
    }),
  );
  return { app, api };
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFolderFiles", (it) => {
  describe("canonical paths", () => {
    it.effect("use no prefix in a one-folder scope, like a plain project", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const path = yield* Path.Path;
        const root = path.join(yield* makeTempDir, "app");
        yield* writeFiles(root, { "api/main.ts": "plain" });
        projectRows.set(projectId, projectRow({ workspaceRoot: root }));

        const read = yield* files.readFile({ scope: { projectId }, path: "api/main.ts" });
        expect(read).toMatchObject({ relativePath: "api/main.ts", contents: "plain" });

        const listed = yield* files.listEntries({ scope: { projectId }, directoryPath: "" });
        expect(listed.entries).toEqual([{ path: "api", kind: "directory" }]);
        expect(listed.folders).toEqual([{ folderPath: root, label: "app", status: "ok" }]);
      }),
    );

    it.effect("never read a primary subdirectory named like a label as that folder", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const { app, api } = yield* appAndApi(yield* makeTempDir);
        yield* writeFiles(app, { "api/main.ts": "primary subdirectory" });
        yield* writeFiles(api, { "main.ts": "api folder" });

        const scope = { projectId };
        expect(yield* files.readFile({ scope, path: "app/api/main.ts" })).toMatchObject({
          relativePath: "app/api/main.ts",
          contents: "primary subdirectory",
        });
        expect(yield* files.readFile({ scope, path: "api/main.ts" })).toMatchObject({
          relativePath: "api/main.ts",
          contents: "api folder",
        });
      }),
    );

    it.effect("resolve a worktree thread's folders inside its worktree set", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const repo = path.join(root, "repo");
        const worktree = path.join(root, "worktrees", "repo");
        yield* writeFiles(repo, { "app/a.ts": "", "lib/x.ts": "source checkout" });
        yield* writeFiles(worktree, { "app/a.ts": "", "lib/x.ts": "thread worktree" });
        projectRows.set(projectId, projectRow({ workspaceRoot: path.join(repo, "app") }));
        threads.set(
          threadId,
          snapshotThread({
            worktreePath: path.join(worktree, "app"),
            workspaceFolders: [
              { path: path.join(repo, "app"), name: "app", label: "app", checkoutRoot: repo },
              { path: path.join(repo, "lib"), name: "lib", label: "lib", checkoutRoot: repo },
            ],
            worktrees: [{ repositoryRoot: repo, path: worktree, branch: "t3/folders" }],
          }),
        );

        const scope = { projectId, threadId };
        expect(yield* files.readFile({ scope, path: "lib/x.ts" })).toMatchObject({
          relativePath: "lib/x.ts",
          contents: "thread worktree",
        });
        const resolved = yield* files.resolveScope(scope);
        expect(resolved.folders.map((folder) => folder.effectivePath)).toEqual([
          path.join(worktree, "app"),
          path.join(worktree, "lib"),
        ]);
      }),
    );

    it.effect("fail an unavailable folder with a typed error, never falling back", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const repo = path.join(root, "repo");
        // The set's worktree is gone, but the source checkout still has the file.
        yield* writeFiles(repo, { "app/a.ts": "", "lib/x.ts": "source checkout" });
        projectRows.set(projectId, projectRow({ workspaceRoot: path.join(repo, "app") }));
        threads.set(
          threadId,
          snapshotThread({
            worktreePath: path.join(root, "gone", "app"),
            workspaceFolders: [
              { path: path.join(repo, "app"), name: "app", label: "app", checkoutRoot: repo },
              { path: path.join(repo, "lib"), name: "lib", label: "lib", checkoutRoot: repo },
            ],
            worktrees: [
              { repositoryRoot: repo, path: path.join(root, "gone"), branch: "t3/folders" },
            ],
          }),
        );

        const error = yield* Effect.flip(
          files.readFile({ scope: { projectId, threadId }, path: "lib/x.ts" }),
        );
        expect(error).toMatchObject({
          _tag: "WorkspaceScopeError",
          failure: "folder-unavailable",
          folder: path.join(repo, "lib"),
        });

        const searched = yield* files.searchEntries({
          scope: { projectId, threadId },
          query: "x",
          limit: 10,
        });
        expect(searched.entries).toEqual([]);
        expect(searched.folders?.map((folder) => folder.status)).toEqual([
          "unavailable",
          "unavailable",
        ]);
      }),
    );

    it.effect("reject paths that leave their folder or name no folder", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const path = yield* Path.Path;
        const { app, api } = yield* appAndApi(yield* makeTempDir);
        yield* writeFiles(app, { "secret.ts": "primary" });
        yield* writeFiles(api, { "main.ts": "" });
        const scope = { projectId };

        expect(
          yield* Effect.flip(files.readFile({ scope, path: "api/../app/secret.ts" })),
        ).toMatchObject({ _tag: "WorkspacePathOutsideRootError" });
        expect(yield* Effect.flip(files.readFile({ scope, path: "web/main.ts" }))).toMatchObject({
          _tag: "WorkspaceScopeError",
          failure: "folder-not-found",
          folder: "web",
        });
        // An absolute host path is not a canonical path, even in a one-folder scope.
        projectRows.set(projectId, projectRow({ workspaceRoot: app }));
        expect(
          yield* Effect.flip(files.readFile({ scope, path: path.join(api, "main.ts") })),
        ).toMatchObject({ _tag: "WorkspacePathOutsideRootError" });
      }),
    );

    it.effect("hold a path to the folder the client pinned", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const { app, api } = yield* appAndApi(yield* makeTempDir);
        yield* writeFiles(api, { "main.ts": "api" });

        expect(
          yield* files.readFile({ scope: { projectId, folderPath: api }, path: "api/main.ts" }),
        ).toMatchObject({ contents: "api" });
        // The label now names another folder than the one search returned.
        expect(
          yield* Effect.flip(
            files.readFile({ scope: { projectId, folderPath: app }, path: "api/main.ts" }),
          ),
        ).toMatchObject({ failure: "folder-changed", folder: app });
        expect(
          yield* Effect.flip(
            files.readFile({ scope: { projectId, folderPath: `${api}-old` }, path: "api/main.ts" }),
          ),
        ).toMatchObject({ failure: "folder-not-found" });
        // The pinned folder was renamed, so its old label names no folder now.
        expect(
          yield* Effect.flip(
            files.readFile({ scope: { projectId, folderPath: api }, path: "old-api/main.ts" }),
          ),
        ).toMatchObject({ failure: "folder-changed", folder: api });
      }),
    );

    it.effect("report a remote folder as unavailable without reaching for it", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const app = path.join(yield* makeTempDir, "app");
        yield* fileSystem.makeDirectory(app);
        const remote = "vscode-remote://ssh-remote+devbox/srv/api";
        projectRows.set(
          projectId,
          projectRow({
            workspaceRoot: app,
            folders: [
              { path: app, name: "app" },
              { uri: remote, name: "api" },
            ],
          }),
        );

        const listed = yield* files.listEntries({ scope: { projectId }, directoryPath: "" });
        expect(listed.folders).toEqual([
          { folderPath: app, label: "app", status: "ok" },
          { folderPath: remote, label: "api", status: "unavailable" },
        ]);
        expect(
          yield* Effect.flip(files.readFile({ scope: { projectId }, path: "api/main.ts" })),
        ).toMatchObject({ failure: "folder-unavailable", folder: remote });
      }),
    );

    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "keep a backslash in a POSIX file name instead of reading it as a separator",
      () =>
        Effect.gen(function* () {
          const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = path.join(yield* makeTempDir, "app");
          yield* writeFiles(root, { "a\\b.txt": "backslash", "a/b.txt": "nested" });
          projectRows.set(projectId, projectRow({ workspaceRoot: root }));

          expect(
            yield* files.writeFile({ scope: { projectId }, path: "a\\b.txt", contents: "new" }),
          ).toEqual({ relativePath: "a\\b.txt" });
          expect(yield* fileSystem.readFileString(path.join(root, "a\\b.txt"))).toBe("new");
          expect(yield* fileSystem.readFileString(path.join(root, "a", "b.txt"))).toBe("nested");
        }),
    );

    it.effect("fail a thread of another project as not found", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        yield* appAndApi(yield* makeTempDir);
        threads.set(threadId, {
          ...snapshotThread({ worktreePath: null, workspaceFolders: undefined }),
          projectId: ProjectId.make("project:other"),
        });
        expect(yield* Effect.flip(files.resolveScope({ projectId, threadId }))).toMatchObject({
          failure: "thread-not-found",
        });
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes inside the canonical path's folder", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { app, api } = yield* appAndApi(yield* makeTempDir);
        yield* writeFiles(app, { "keep.ts": "" });
        yield* writeFiles(api, { "keep.ts": "" });
        const scope = { projectId };

        expect(
          yield* files.writeFile({ scope, path: "api/src/new.ts", contents: "written" }),
        ).toEqual({ relativePath: "api/src/new.ts" });
        expect(yield* fileSystem.readFileString(path.join(api, "src", "new.ts"))).toBe("written");
        expect(yield* fileSystem.exists(path.join(app, "src", "new.ts"))).toBe(false);

        expect(
          yield* Effect.flip(files.writeFile({ scope, path: "api/../escape.ts", contents: "" })),
        ).toMatchObject({ _tag: "WorkspacePathOutsideRootError" });
        expect(yield* fileSystem.exists(path.join(path.dirname(api), "escape.ts"))).toBe(false);
      }),
    );
  });

  describe("search and listing", () => {
    it.effect("give a nested folder's files to that folder, once", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const path = yield* Path.Path;
        const repo = path.join(yield* makeTempDir, "repo");
        const nested = path.join(repo, "packages", "api");
        yield* writeFiles(repo, { "root.ts": "", "packages/api/handler.ts": "" });
        projectRows.set(
          projectId,
          projectRow({
            workspaceRoot: repo,
            folders: [
              { path: repo, name: "repo" },
              { path: nested, name: "api" },
            ],
          }),
        );
        const scope = { projectId };

        const searched = yield* files.searchEntries({
          scope,
          query: "handler",
          limit: 20,
          kind: "file",
        });
        expect(searched.entries).toEqual([{ path: "api/handler.ts", kind: "file" }]);
        expect(searched.folders).toEqual([
          { folderPath: repo, label: "repo", status: "ok" },
          { folderPath: nested, label: "api", status: "ok" },
        ]);

        const narrowed = yield* files.searchEntries({
          scope: { projectId, folderPath: repo },
          query: "handler",
          limit: 20,
          kind: "file",
        });
        expect(narrowed.entries).toEqual([{ path: "api/handler.ts", kind: "file" }]);
        // A result opens with the pin of the folder its label names.
        expect(
          yield* files.readFile({
            scope: { projectId, folderPath: nested },
            path: "api/handler.ts",
          }),
        ).toMatchObject({ relativePath: "api/handler.ts" });
        // Reached through the outer folder, the file keeps its one canonical name.
        expect(
          yield* files.readFile({ scope, path: "repo/packages/api/handler.ts" }),
        ).toMatchObject({ relativePath: "api/handler.ts" });

        expect(yield* files.listEntries({ scope, directoryPath: "" })).toEqual({
          entries: [],
          truncated: false,
          folders: searched.folders,
        });
        expect(
          (yield* files.listEntries({ scope, directoryPath: "repo/packages" })).entries,
        ).toEqual([{ path: "api", kind: "directory" }]);
        expect(
          (yield* files.listEntries({
            scope: { projectId, folderPath: nested },
            directoryPath: "",
          })).entries,
        ).toEqual([{ path: "api/handler.ts", kind: "file" }]);
      }),
    );

    it.effect("let a query start with a folder label to search that folder", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const app = path.join(root, "app");
        const server = path.join(root, "p2");
        yield* writeFiles(app, { "web/main.ts": "" });
        yield* writeFiles(server, { "src/main.ts": "", "src/other.ts": "" });
        projectRows.set(
          projectId,
          projectRow({
            workspaceRoot: app,
            folders: [
              { path: app, name: "app" },
              { path: server, name: "backend" },
            ],
          }),
        );
        const search = (query: string) =>
          files
            .searchEntries({ scope: { projectId }, query, limit: 20, kind: "file" })
            .pipe(Effect.map((result) => result.entries.map((entry) => entry.path)));

        expect(yield* search("backend/src/main")).toEqual(["backend/src/main.ts"]);
        expect(yield* search("main")).toEqual(
          expect.arrayContaining(["app/web/main.ts", "backend/src/main.ts"]),
        );
        expect((yield* search("@backend/")).toSorted()).toEqual([
          "backend/src/main.ts",
          "backend/src/other.ts",
        ]);
      }),
    );
  });
});

/** Per-folder results keyed by folder basename, so merge order is exact. */
const folderResults = new Map<string, ReadonlyArray<string> | "fail">();
const searchedFolders: string[] = [];

const StubEntriesLayer = Layer.effect(
  WorkspaceEntries.WorkspaceEntries,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const resultsFor = (
      cwd: string,
    ): Effect.Effect<
      ReadonlyArray<string>,
      WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed
    > => {
      searchedFolders.push(path.basename(cwd));
      const result = folderResults.get(path.basename(cwd)) ?? [];
      return result === "fail"
        ? Effect.fail(
            new WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed({
              cwd,
              queryLength: 1,
              pageSize: 1,
              reason: "index broke",
            }),
          )
        : Effect.succeed(result);
    };
    return WorkspaceEntries.WorkspaceEntries.of({
      browse: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      refresh: () => Effect.void,
      search: (input) =>
        resultsFor(input.cwd).pipe(
          Effect.map((paths) => ({
            entries: paths.map((entryPath): ProjectEntry => ({ path: entryPath, kind: "file" })),
            truncated: false,
          })),
        ),
      searchContents: (input) =>
        resultsFor(input.cwd).pipe(
          Effect.map((lines) => ({
            matches: lines.map((line, index): ProjectContentMatch => ({
              path: `file-${index}.ts`,
              lineNumber: 1,
              lineContent: line,
              matchRanges: [{ start: 0, end: 1 }],
            })),
            truncated: false,
          })),
        ),
    });
  }),
).pipe(Layer.provide(NodeServices.layer));

const StubLayer = folderFilesLayer(StubEntriesLayer).pipe(Layer.provideMerge(PlatformLayer));

/** A linked project of folders `a`, `b` and `c`, each an empty directory. */
const threeFolders = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* makeTempDir;
  const folders = ["a", "b", "c"].map((name) => ({ path: path.join(root, name), name }));
  for (const folder of folders) yield* fileSystem.makeDirectory(folder.path);
  projectRows.set(projectId, projectRow({ workspaceRoot: folders[0]!.path, folders }));
  folderResults.clear();
  searchedFolders.length = 0;
  return folders;
});

it.layer(StubLayer, { excludeTestServices: true })("WorkspaceFolderFiles fan-out", (it) => {
  it.effect("merges folders rank by rank under one total limit", () =>
    Effect.gen(function* () {
      const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
      yield* threeFolders;
      folderResults.set("a", ["a1", "a2", "a3"]);
      folderResults.set("b", ["b1", "b2", "b3"]);
      folderResults.set("c", ["c1"]);

      const result = yield* files.searchEntries({ scope: { projectId }, query: "x", limit: 4 });
      expect(result.entries.map((entry) => entry.path)).toEqual(["a/a1", "b/b1", "c/c1", "a/a2"]);
      expect(result.truncated).toBe(true);

      const all = yield* files.searchEntries({ scope: { projectId }, query: "x", limit: 10 });
      expect(all.entries).toHaveLength(7);
      expect(all.truncated).toBe(false);
    }),
  );

  it.effect("caps content matches at one byte budget across folders", () =>
    Effect.gen(function* () {
      const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
      yield* threeFolders;
      const line = "x".repeat(WorkspaceFolderFiles.SCOPED_SEARCH_MAX_BYTES / 3);
      folderResults.set("a", [line, line]);
      folderResults.set("b", [line, line]);

      const result = yield* files.searchContents({
        scope: { projectId },
        query: "x",
        limit: 100,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
      expect(result.matches.map((match) => match.path)).toEqual(["a/file-0.ts", "b/file-0.ts"]);
      expect(result.truncated).toBe(true);
    }),
  );

  it.effect("reports a folder whose search failed instead of showing no matches", () =>
    Effect.gen(function* () {
      const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
      yield* threeFolders;
      folderResults.set("a", ["a1"]);
      folderResults.set("b", "fail");

      const result = yield* files.searchEntries({ scope: { projectId }, query: "x", limit: 10 });
      expect(result.entries.map((entry) => entry.path)).toEqual(["a/a1"]);
      expect(result.folders?.map((folder) => [folder.label, folder.status])).toEqual([
        ["a", "ok"],
        ["b", "index-error"],
        ["c", "ok"],
      ]);
    }),
  );

  it.effect("searches only the folder a scope narrows to", () =>
    Effect.gen(function* () {
      const files = yield* WorkspaceFolderFiles.WorkspaceFolderFiles;
      const folders = yield* threeFolders;
      folderResults.set("b", ["b1"]);

      const result = yield* files.searchEntries({
        scope: { projectId, folderPath: folders[1]!.path },
        query: "x",
        limit: 10,
      });
      expect(searchedFolders).toEqual(["b"]);
      expect(result.entries.map((entry) => entry.path)).toEqual(["b/b1"]);
      expect(result.folders).toHaveLength(3);
    }),
  );
});
