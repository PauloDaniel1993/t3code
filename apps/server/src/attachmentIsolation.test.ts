// @effect-diagnostics nodeBuiltinImport:off - tests create symlinks within isolated fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import {
  AttachmentSeedSpace,
  initializeIsolatedAttachments,
  ATTACHMENT_SEED_REPORT_BATCH_SIZE,
  ATTACHMENT_SEED_REPORT_INTERVAL_MS,
} from "./attachmentIsolation.ts";
import { deriveServerPaths, ensureServerDirectories, ServerConfig } from "./config.ts";
import { layerConfig as persistenceLayer } from "./persistence/Layers/Sqlite.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeSeedReport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ completed: Schema.Array(Schema.String) })),
);

describe("V2 attachment isolation", () => {
  for (const count of [10, 1000]) {
    it.effect(
      `checkpoints ${count} seeded files in batches and writes a complete final report`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fs.makeTempDirectoryScoped();
          const source = path.join(stateDir, "attachments");
          const attachmentsDir = path.join(stateDir, "attachments-v2");
          yield* fs.makeDirectory(source);
          yield* Effect.forEach(
            Array.from({ length: count }, (_, i) => i),
            (i) => fs.writeFileString(path.join(source, `${i}.png`), "bytes"),
            { concurrency: 16, discard: true },
          );
          const reportPath = path.join(stateDir, ".attachments-v2-seed-report.json");
          const writes: Array<number> = [];
          let copies = 0;
          const timer = vi.spyOn(performance, "now").mockReturnValue(0);
          try {
            yield* initializeIsolatedAttachments({ stateDir, attachmentsDir }).pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                copyFile: (from, to) =>
                  fs.copyFile(from, to).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        copies++;
                      }),
                    ),
                  ),
                writeFileString: (file, data, options) => {
                  if (file === reportPath) writes.push(copies);
                  return fs.writeFileString(file, data, options);
                },
              }),
            );
          } finally {
            timer.mockRestore();
          }
          expect(copies).toBe(count);
          expect(writes).toEqual([
            ...Array.from(
              { length: Math.floor(count / ATTACHMENT_SEED_REPORT_BATCH_SIZE) },
              (_, i) => (i + 1) * ATTACHMENT_SEED_REPORT_BATCH_SIZE,
            ),
            count,
          ]);
          const report = yield* decodeSeedReport(yield* fs.readFileString(reportPath));
          expect(report.completed).toHaveLength(count);
          expect(yield* fs.exists(path.join(stateDir, ".attachments-v2-seeded"))).toBe(true);
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("checkpoints by elapsed time during a long seed before the batch limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const source = path.join(stateDir, "attachments");
      const attachmentsDir = path.join(stateDir, "attachments-v2");
      yield* fs.makeDirectory(source);
      for (const name of ["a.png", "b.png", "c.png"])
        yield* fs.writeFileString(path.join(source, name), "bytes");
      const writes: Array<number> = [];
      let copies = 0;
      let elapsed = 0;
      const timer = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      try {
        yield* initializeIsolatedAttachments({ stateDir, attachmentsDir }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            copyFile: (from, to) =>
              fs.copyFile(from, to).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    copies++;
                    elapsed += copies === 2 ? ATTACHMENT_SEED_REPORT_INTERVAL_MS : 1;
                  }),
                ),
              ),
            writeFileString: (file, data, options) => {
              if (file.endsWith(".attachments-v2-seed-report.json")) writes.push(copies);
              return fs.writeFileString(file, data, options);
            },
          }),
        );
      } finally {
        timer.mockRestore();
      }
      expect(writes).toEqual([2, 3]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "seeds at database initialization so configuration reads cannot freeze an earlier attachment snapshot",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const source = path.join(config.stateDir, "attachments");
        yield* fs.makeDirectory(source);
        yield* fs.writeFileString(path.join(source, "before-config.png"), "first");
        yield* ensureServerDirectories(config);
        expect(yield* fs.exists(path.join(config.stateDir, ".attachments-v2-seeded"))).toBe(false);
        yield* fs.writeFileString(path.join(source, "after-config.png"), "second");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT 1`;
          expect(
            yield* fs.readFileString(path.join(config.attachmentsDir, "before-config.png")),
          ).toBe("first");
          expect(
            yield* fs.readFileString(path.join(config.attachmentsDir, "after-config.png")),
          ).toBe("second");
        }).pipe(Effect.provide(persistenceLayer));
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-init-order-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
  it.effect.skipIf(!symlinksSupported)(
    "does not seed symlinks to files outside the legacy store",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-attachment-seed-symlink-",
        });
        const source = path.join(stateDir, "attachments");
        const attachmentsDir = path.join(stateDir, "attachments-v2");
        yield* fs.makeDirectory(source);
        yield* fs.makeDirectory(attachmentsDir);
        const outside = path.join(stateDir, "outside.png");
        yield* fs.writeFileString(outside, "outside");
        yield* Effect.promise(() => NodeFSP.symlink(outside, path.join(source, "escape.png")));
        yield* initializeIsolatedAttachments({ stateDir, attachmentsDir });
        expect(yield* fs.exists(path.join(attachmentsDir, "escape.png"))).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "publishes no partial final file or completion marker when copying fails, and retries safely",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-attachment-seed-failure-",
        });
        const source = path.join(stateDir, "attachments");
        const attachmentsDir = path.join(stateDir, "attachments-v2");
        yield* fs.makeDirectory(source);
        yield* fs.makeDirectory(attachmentsDir);
        yield* fs.writeFileString(path.join(source, "image.png"), "complete");
        yield* fs.writeFileString(path.join(source, "healthy.png"), "healthy");
        yield* initializeIsolatedAttachments({ stateDir, attachmentsDir }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            copyFile: (from, to) =>
              from.endsWith("image.png")
                ? fs
                    .writeFileString(to, "partial")
                    .pipe(Effect.andThen(fs.copyFile(path.join(source, "missing"), to)))
                : fs.copyFile(from, to),
          }),
        );
        expect(yield* fs.exists(path.join(attachmentsDir, "image.png"))).toBe(false);
        expect(yield* fs.exists(path.join(stateDir, ".attachments-v2-seeded"))).toBe(false);
        expect(
          (yield* fs.readDirectory(attachmentsDir)).filter((name) => name.endsWith(".part")),
        ).toEqual([]);
        expect(
          yield* fs.readFileString(path.join(stateDir, ".attachments-v2-seed-report.json")),
        ).toContain("missing");
        yield* fs.remove(path.join(attachmentsDir, "healthy.png"));
        yield* initializeIsolatedAttachments({ stateDir, attachmentsDir });
        expect(yield* fs.readFileString(path.join(attachmentsDir, "image.png"))).toBe("complete");
        expect(yield* fs.exists(path.join(attachmentsDir, "healthy.png"))).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  for (const failure of ["PermissionDenied", "NotFound"] as const) {
    it.effect(`starts with a ${failure} source file and records its reason`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const source = path.join(config.stateDir, "attachments");
        yield* fs.makeDirectory(source);
        const bad = path.join(source, "unavailable.png");
        yield* fs.writeFileString(bad, "unavailable");
        yield* fs.writeFileString(path.join(source, "healthy.png"), "healthy");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(yield* sql`SELECT 1 AS ready`).toEqual([{ ready: 1 }]);
        }).pipe(
          Effect.provide(persistenceLayer),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            copyFile: (from, to) =>
              from === bad
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: failure,
                      module: "FileSystem",
                      method: "copyFile",
                      pathOrDescriptor: from,
                    }),
                  )
                : fs.copyFile(from, to),
          }),
        );
        expect(yield* fs.readFileString(path.join(config.attachmentsDir, "healthy.png"))).toBe(
          "healthy",
        );
        const report = yield* fs.readFileString(
          path.join(config.stateDir, ".attachments-v2-seed-report.json"),
        );
        expect(report).toContain("unavailable.png");
        expect(report).toContain(failure);
        expect(yield* fs.exists(path.join(config.stateDir, ".attachments-v2-seeded"))).toBe(false);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-seed-unavailable-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
  }
  it.effect(
    "copies on a volume that refuses hard links and starts without copying when space is insufficient",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const source = path.join(stateDir, "attachments");
        const attachmentsDir = path.join(stateDir, "attachments-v2");
        yield* fs.makeDirectory(source);
        yield* fs.writeFileString(path.join(source, "file.png"), "bytes");
        yield* initializeIsolatedAttachments({ stateDir, attachmentsDir }).pipe(
          Effect.provideService(AttachmentSeedSpace, { availableBytes: () => Effect.succeed(0) }),
        );
        expect(yield* fs.readDirectory(attachmentsDir)).toEqual([]);
        expect(
          yield* fs.readFileString(path.join(stateDir, ".attachments-v2-seed-report.json")),
        ).toContain("Insufficient free space");
        yield* initializeIsolatedAttachments({ stateDir, attachmentsDir }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            link: () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "link",
                  description: "Volume refuses hard links",
                }),
              ),
          }),
        );
        expect(yield* fs.readFileString(path.join(attachmentsDir, "file.png"))).toBe("bytes");
        expect(yield* fs.exists(path.join(stateDir, ".attachments-v2-seeded"))).toBe(true);
        expect(
          (yield* fs.readDirectory(attachmentsDir)).filter((name) => name.endsWith(".part")),
        ).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "copies independent bytes so deleting on either side cannot remove the other's file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attachment-isolation-" });
        const paths = yield* deriveServerPaths(base, undefined);
        expect(paths.attachmentsDir).toBe(path.join(paths.stateDir, "attachments-v2"));
        const v1Directory = path.join(paths.stateDir, "attachments");
        yield* fs.makeDirectory(v1Directory, { recursive: true });
        const first = "thread-00000000-0000-4000-8000-000000000001.png";
        const second = "thread-00000000-0000-4000-8000-000000000002-pdf.pdf";
        yield* fs.writeFileString(path.join(v1Directory, first), "first");
        yield* fs.writeFileString(path.join(v1Directory, second), "second");
        yield* ensureServerDirectories(paths);
        yield* initializeIsolatedAttachments(paths);
        yield* fs.writeFileString(path.join(paths.attachmentsDir, first), "edited in V2");
        expect(yield* fs.readFileString(path.join(v1Directory, first))).toBe("first");
        yield* fs.remove(path.join(v1Directory, first));
        expect(yield* fs.readFileString(path.join(paths.attachmentsDir, first))).toBe(
          "edited in V2",
        );
        yield* fs.remove(path.join(paths.attachmentsDir, second));
        expect(yield* fs.readFileString(path.join(v1Directory, second))).toBe("second");
        yield* ensureServerDirectories(paths);
        yield* initializeIsolatedAttachments(paths);
        expect(yield* fs.exists(path.join(paths.attachmentsDir, second))).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps existing V2 files and skips staging files and directories when seeding", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attachment-seed-" });
      const attachmentsDir = path.join(stateDir, "attachments-v2");
      const source = path.join(stateDir, "attachments");
      yield* fs.makeDirectory(source);
      yield* fs.makeDirectory(attachmentsDir);
      yield* fs.writeFileString(path.join(source, "existing.png"), "legacy");
      yield* fs.writeFileString(path.join(attachmentsDir, "existing.png"), "V2");
      yield* fs.writeFileString(path.join(source, "upload.png.part"), "partial");
      yield* fs.makeDirectory(path.join(source, ".staging"));
      yield* fs.makeDirectory(path.join(source, "directory"));
      yield* initializeIsolatedAttachments({ stateDir, attachmentsDir });
      expect(yield* fs.readFileString(path.join(attachmentsDir, "existing.png"))).toBe("V2");
      expect(yield* fs.exists(path.join(attachmentsDir, "upload.png.part"))).toBe(false);
      expect(yield* fs.exists(path.join(attachmentsDir, ".staging"))).toBe(false);
      expect(yield* fs.exists(path.join(attachmentsDir, "directory"))).toBe(false);
      expect(yield* fs.exists(path.join(stateDir, ".attachments-v2-seeded"))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
