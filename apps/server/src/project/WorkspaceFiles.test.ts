import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import * as WorkspaceFiles from "./WorkspaceFiles.ts";

const TestLayer = WorkspaceFiles.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer)("WorkspaceFiles", (it) => {
  it.effect("reads a workspace file's folders relative to its directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* WorkspaceFiles.WorkspaceFiles;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-file-" });
      const filePath = path.join(root, "team.code-workspace");
      yield* fs.writeFileString(
        filePath,
        `{ "folders": [{ "path": "app" }, { "path": "../shared", "name": "Shared" }], }`,
      );

      expect(yield* files.read(filePath)).toEqual({
        filePath,
        folders: [
          { path: path.join(root, "app"), name: "app" },
          { path: path.resolve(root, "..", "shared"), name: "Shared" },
        ],
      });
    }),
  );

  it.effect("rejects missing files, folders named like workspace files and malformed files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* WorkspaceFiles.WorkspaceFiles;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-file-bad-" });
      const directory = path.join(root, "folder.code-workspace");
      yield* fs.makeDirectory(directory);
      const malformed = path.join(root, "broken.code-workspace");
      yield* fs.writeFileString(malformed, `{ "folders": [ `);

      const code = (filePath: string) =>
        files.read(filePath).pipe(
          Effect.flip,
          Effect.map((error) => [error.diagnostic.code, error.diagnostic.path]),
        );
      expect(yield* code(path.join(root, "gone.code-workspace"))).toEqual([
        "file-not-found",
        path.join(root, "gone.code-workspace"),
      ]);
      expect(yield* code(directory)).toEqual(["not-a-file", directory]);
      expect(yield* code(malformed)).toEqual(["malformed-jsonc", malformed]);
    }),
  );
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFiles watching", (it) => {
  it.effect("hints after its file changes, in any letter case", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* WorkspaceFiles.WorkspaceFiles;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-file-watch-" });
      yield* fs.writeFileString(path.join(root, "team.code-workspace"), `{ "folders": [] }`);
      // Linked under another spelling of its name, as a case-insensitive disk allows.
      const filePath = path.join(root, "Team.code-workspace");
      const projectId = ProjectId.make("project:watched");
      const hints = yield* Queue.unbounded<void>();

      assert.isTrue(yield* files.watch(projectId, filePath, Queue.offer(hints, undefined)));
      assert.isTrue(yield* files.isWatching(projectId, filePath));
      assert.isFalse(yield* files.isWatching(projectId, path.join(root, "other.code-workspace")));
      yield* fs.writeFileString(
        path.join(root, "team.code-workspace"),
        `{ "folders": [{ "path": "lib" }] }`,
      );
      yield* Queue.take(hints);

      yield* files.unwatch(projectId);
      assert.isFalse(yield* files.isWatching(projectId, filePath));
    }),
  );

  it.effect("stops, hinting once more, when its directory goes away", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* WorkspaceFiles.WorkspaceFiles;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-file-gone-" });
      const directory = path.join(root, ".vscode");
      yield* fs.makeDirectory(directory);
      const filePath = path.join(directory, "team.code-workspace");
      yield* fs.writeFileString(filePath, `{ "folders": [{ "path": ".." }] }`);
      const projectId = ProjectId.make("project:directory-gone");
      const hints = yield* Queue.unbounded<void>();
      assert.isTrue(yield* files.watch(projectId, filePath, Queue.offer(hints, undefined)));

      yield* fs.remove(directory, { recursive: true });
      // Each hint is a chance to read; the watch reports itself stopped by one of them.
      yield* Queue.take(hints).pipe(
        Effect.andThen(files.isWatching(projectId, filePath)),
        Effect.repeat({ until: (watching) => !watching }),
      );
      yield* files.unwatch(projectId);
    }),
  );

  it.effect("reports a file in a missing directory as not watched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* WorkspaceFiles.WorkspaceFiles;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-file-unwatched-" });
      const projectId = ProjectId.make("project:unwatched");
      const filePath = path.join(root, "gone", "team.code-workspace");

      assert.isFalse(yield* files.watch(projectId, filePath, Effect.void));
      assert.isFalse(yield* files.isWatching(projectId, filePath));
    }),
  );
});
