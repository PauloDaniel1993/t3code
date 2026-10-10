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
  it.effect("hints after its file changes, until unwatched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* WorkspaceFiles.WorkspaceFiles;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-file-watch-" });
      const filePath = path.join(root, "team.code-workspace");
      yield* fs.writeFileString(filePath, `{ "folders": [{ "path": "app" }] }`);
      const projectId = ProjectId.make("project:watched");
      const hints = yield* Queue.unbounded<void>();

      assert.isTrue(yield* files.watch(projectId, filePath, Queue.offer(hints, undefined)));
      assert.isTrue(yield* files.isWatching(projectId));
      yield* fs.writeFileString(path.join(root, "other.txt"), "unrelated");
      yield* fs.writeFileString(filePath, `{ "folders": [{ "path": "lib" }] }`);
      yield* Queue.take(hints);

      yield* files.unwatch(projectId);
      assert.isFalse(yield* files.isWatching(projectId));
    }),
  );

  it.effect("reports a file in a missing directory as not watched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* WorkspaceFiles.WorkspaceFiles;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-file-unwatched-" });
      const projectId = ProjectId.make("project:unwatched");

      assert.isFalse(
        yield* files.watch(projectId, path.join(root, "gone", "team.code-workspace"), Effect.void),
      );
      assert.isFalse(yield* files.isWatching(projectId));
    }),
  );
});
