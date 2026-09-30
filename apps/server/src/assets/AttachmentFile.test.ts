import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { hasExactAttachmentFileName } from "./AttachmentFile.ts";

it.effect("accepts stored casing and refuses case aliases and missing files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const file = path.join(root, "Stored-id.png");
    yield* fs.writeFile(file, new Uint8Array([1]));
    expect(yield* hasExactAttachmentFileName(file)).toBe(true);
    expect(yield* hasExactAttachmentFileName(path.join(root, "stored-ID.png"))).toBe(false);
    expect(yield* hasExactAttachmentFileName(path.join(root, "absent.png"))).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
