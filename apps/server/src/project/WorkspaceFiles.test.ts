import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

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
