import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { copyDesktopArtifacts } from "./copy-desktop-artifacts.ts";

it.effect("publishes the complete unpacked app for installation and replaces stale files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-local-artifacts-" });
    const stageDistDir = path.join(fixture, "stage");
    const outputDir = path.join(fixture, "output");
    yield* fs.makeDirectory(path.join(stageDistDir, "win-unpacked", "resources"), {
      recursive: true,
    });
    yield* fs.writeFileString(
      path.join(stageDistDir, "win-unpacked", "resources", "server.asar"),
      "fixture",
    );
    yield* fs.makeDirectory(path.join(outputDir, "win-unpacked"), { recursive: true });
    yield* fs.writeFileString(path.join(outputDir, "win-unpacked", "stale.txt"), "stale");
    const result = yield* copyDesktopArtifacts({ stageDistDir, outputDir, target: "dir" });
    assert.isTrue(result.copiedDirectory);
    yield* fs.remove(stageDistDir, { recursive: true });
    assert.equal(
      yield* fs.readFileString(path.join(outputDir, "win-unpacked", "resources", "server.asar")),
      "fixture",
    );
    assert.isFalse(yield* fs.exists(path.join(outputDir, "win-unpacked", "stale.txt")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("continues to publish only files for normal release targets", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-release-artifacts-" });
    const stageDistDir = path.join(fixture, "stage");
    const outputDir = path.join(fixture, "output");
    yield* fs.makeDirectory(path.join(stageDistDir, "win-unpacked"), { recursive: true });
    yield* fs.writeFileString(path.join(stageDistDir, "installer.exe"), "fixture");
    const result = yield* copyDesktopArtifacts({ stageDistDir, outputDir, target: "nsis" });
    assert.isFalse(result.copiedDirectory);
    assert.equal(yield* fs.readFileString(path.join(outputDir, "installer.exe")), "fixture");
    assert.isFalse(yield* fs.exists(path.join(outputDir, "win-unpacked")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
