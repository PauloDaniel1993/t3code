import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as WorkspaceFolderResolver from "./WorkspaceFolderResolver.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const result = yield* processRunner.run({ command: "git", args: ["-C", cwd, ...args] });
    if (result.code !== 0) return yield* Effect.die(new Error(result.stderr));
  }).pipe(Effect.provide(ProcessRunner.layer));

const TestLayer = WorkspaceFolderResolver.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer)("WorkspaceFolderResolver", (it) => {
  it.effect("tells missing folders, files and other folders apart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolver = yield* WorkspaceFolderResolver.WorkspaceFolderResolver;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-folder-probe-" });
      const file = path.join(root, "notes.md");
      yield* fs.writeFileString(file, "notes");

      expect(yield* resolver.probe(path.join(root, "gone"), { vcs: true })).toEqual({
        path: path.join(root, "gone"),
        availability: "unavailable",
        unavailableReason: "missing",
      });
      expect((yield* resolver.probe(file, { vcs: true })).unavailableReason).toBe("not-directory");
      expect(yield* resolver.probe(root, { vcs: false })).toEqual({
        path: root,
        availability: "available",
      });
      expect((yield* resolver.probe(root, { vcs: true })).vcs).toBeNull();
    }),
  );

  it.effect("finds the checkout of a folder, its place in it, and the repository it shares", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolver = yield* WorkspaceFolderResolver.WorkspaceFolderResolver;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-folder-checkout-" });
      const repo = path.join(root, "repo");
      const subfolder = path.join(repo, "packages", "app");
      yield* fs.makeDirectory(subfolder, { recursive: true });
      yield* fs.writeFileString(path.join(subfolder, "index.ts"), "export {};\n");
      yield* git(repo, ["init", "--initial-branch=main"]);
      yield* git(repo, ["-c", "user.email=t3@example.com", "-c", "user.name=T3", "add", "."]);
      yield* git(repo, [
        "-c",
        "user.email=t3@example.com",
        "-c",
        "user.name=T3",
        "commit",
        "-m",
        "init",
      ]);
      const worktree = path.join(root, "worktree");
      yield* git(repo, ["worktree", "add", "-b", "feature", worktree]);

      const atRoot = yield* resolver.probe(repo, { vcs: true });
      const inside = yield* resolver.probe(subfolder, { vcs: true });
      const inWorktree = yield* resolver.probe(path.join(worktree, "packages"), { vcs: true });
      const realRepo = yield* fs.realPath(repo);

      expect(atRoot.vcs).toMatchObject({ checkoutRoot: realRepo, checkoutPrefix: "" });
      expect(inside.vcs).toMatchObject({ checkoutRoot: realRepo, checkoutPrefix: "packages/app" });
      expect(inWorktree.vcs).toMatchObject({
        checkoutRoot: yield* fs.realPath(worktree),
        checkoutPrefix: "packages",
      });
      // Checkouts of one repository share its git directory.
      expect(inWorktree.vcs?.commonDir).toBe(atRoot.vcs?.commonDir);
      expect(inside.vcs?.commonDir).toBe(atRoot.vcs?.commonDir);
    }),
  );
});
