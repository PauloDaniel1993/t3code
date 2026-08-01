import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WayfinderMaps from "./WayfinderMaps.ts";

const WorkspaceLayer = Layer.merge(
  NodeServices.layer,
  WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
);
const TestLayer = Layer.merge(
  WorkspaceLayer,
  WayfinderMaps.layer.pipe(Layer.provide(WorkspaceLayer)),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-wayfinder-worktree-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const mapMarkdown = (title: string) =>
  ["---", `title: ${title}`, "destination: Verify worktree path resolution.", "---"].join("\n");

const ticketMarkdown = (title: string, blockedBy: ReadonlyArray<number> = []) =>
  ["---", "type: task", `blocked_by: [${blockedBy.join(", ")}]`, "---", `# ${title}`].join("\n");

it.layer(TestLayer, { excludeTestServices: true })("WayfinderMaps worktree roots", (it) => {
  it.effect("resolves map and node paths against the requested worktree root", () =>
    Effect.gen(function* () {
      const maps = yield* WayfinderMaps.WayfinderMaps;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectWorkspaceRoot = yield* makeTempDir;
      const threadWorktreeRoot = yield* makeTempDir;

      yield* writeTextFile(
        projectWorkspaceRoot,
        ".plan/project/map.md",
        mapMarkdown("Project workspace map"),
      );
      yield* writeTextFile(
        projectWorkspaceRoot,
        ".plan/project/tickets/01-project.md",
        ticketMarkdown("Project workspace ticket"),
      );
      yield* writeTextFile(
        threadWorktreeRoot,
        ".plan/worktree/map.md",
        mapMarkdown("Worktree map"),
      );
      yield* writeTextFile(
        threadWorktreeRoot,
        ".plan/worktree/tickets/01-worktree-first.md",
        ticketMarkdown("Worktree ticket one"),
      );
      yield* writeTextFile(
        threadWorktreeRoot,
        ".plan/worktree/tickets/02-worktree-second.md",
        ticketMarkdown("Worktree ticket two", [1]),
      );

      const snapshot = yield* maps
        .stream(threadWorktreeRoot)
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));

      expect(snapshot.maps).toHaveLength(1);
      const map = snapshot.maps[0];
      if (map === undefined) {
        throw new Error("Expected the worktree map to be discovered.");
      }

      expect(map.title).toBe("Worktree map");
      const relativePaths = [map.mapRelativePath, ...map.nodes.map((node) => node.relativePath)];
      expect(relativePaths).toEqual([
        ".plan/worktree/map.md",
        ".plan/worktree/tickets/01-worktree-first.md",
        ".plan/worktree/tickets/02-worktree-second.md",
      ]);

      for (const relativePath of relativePaths) {
        expect(yield* fileSystem.exists(path.join(threadWorktreeRoot, relativePath))).toBe(true);
        expect(yield* fileSystem.exists(path.join(projectWorkspaceRoot, relativePath))).toBe(false);
      }
    }),
  );
});
