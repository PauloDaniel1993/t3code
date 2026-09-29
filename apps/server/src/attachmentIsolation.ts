// @effect-diagnostics nodeBuiltinImport:off - unique staging names do not add config service dependencies.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { normalizeAttachmentRelativePath } from "./attachmentPaths.ts";

class AttachmentSeedError extends Schema.TaggedError<AttachmentSeedError>()("AttachmentSeedError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return String(this.cause);
  }
}
const reportSchema = Schema.fromJsonString(
  Schema.Struct({
    completed: Schema.Array(Schema.String),
    skipped: Schema.Array(Schema.Struct({ file: Schema.String, reason: Schema.String })),
  }),
);
const encodeReport = Schema.encodeSync(reportSchema);
const decodeReport = Schema.decodeUnknownEffect(reportSchema);
export const ATTACHMENT_SEED_REPORT_BATCH_SIZE = 256;
export const ATTACHMENT_SEED_REPORT_INTERVAL_MS = 5_000;

export class AttachmentSeedSpace extends Context.Reference<{
  readonly availableBytes: (directory: string) => Effect.Effect<number, AttachmentSeedError>;
}>("t3/AttachmentSeedSpace", {
  defaultValue: () => ({
    availableBytes: (directory) =>
      Effect.tryPromise({
        try: async () => {
          const info = await NodeFSP.statfs(directory);
          return info.bavail * info.bsize;
        },
        catch: (cause) => new AttachmentSeedError({ cause }),
      }),
  }),
}) {}

/** Seed once with independent bytes: V1's cleanup queue cannot see V2's files. */
export const initializeIsolatedAttachments = Effect.fn("initializeIsolatedAttachments")(
  function* (input: { readonly stateDir: string; readonly attachmentsDir: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(input.attachmentsDir, { recursive: true });
    const marker = path.join(input.stateDir, ".attachments-v2-seeded");
    if (yield* fs.exists(marker)) return;
    const reportPath = path.join(input.stateDir, ".attachments-v2-seed-report.json");
    const completed = new Set<string>();
    if (yield* fs.exists(reportPath)) {
      const previous = yield* fs.readFileString(reportPath);
      const report = yield* decodeReport(previous).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Cannot read attachment seed report; startup continues", {
            reportPath,
            error,
          }).pipe(Effect.as(null)),
        ),
      );
      if (report === null) return;
      for (const file of report.completed) completed.add(file);
    }
    const skipped: Array<{ file: string; reason: string }> = [];
    let outcomesSinceReport = 0;
    let lastReportAt = performance.now();
    const saveReport = Effect.fnUntraced(function* () {
      yield* fs
        .writeFileString(reportPath, encodeReport({ completed: Array.from(completed), skipped }))
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Cannot write attachment seed report", { reportPath, error }),
          ),
        );
      outcomesSinceReport = 0;
      lastReportAt = performance.now();
    });
    // Checkpoint long passes; save the final report before startup can prune.
    const checkpointReport = Effect.fnUntraced(function* () {
      outcomesSinceReport++;
      if (
        outcomesSinceReport >= ATTACHMENT_SEED_REPORT_BATCH_SIZE ||
        performance.now() - lastReportAt >= ATTACHMENT_SEED_REPORT_INTERVAL_MS
      )
        yield* saveReport();
    });
    const record = (file: string, reason: string) =>
      Effect.gen(function* () {
        skipped.push({ file, reason });
        yield* Effect.logWarning("V2 attachment seed skipped", { file, reason, reportPath });
        yield* checkpointReport();
      });
    const source = path.join(input.stateDir, "attachments");
    const seed = Effect.gen(function* () {
      if (yield* fs.exists(source)) {
        const sourceRoot = yield* fs.realPath(source);
        const files: Array<{ from: string; to: string; size: number }> = [];
        for (const entry of yield* fs.readDirectory(source)) {
          if (entry.startsWith(".") || entry.endsWith(".part")) continue;
          const normalized = normalizeAttachmentRelativePath(entry);
          if (normalized !== entry || normalized.includes("/")) continue;
          const from = path.join(sourceRoot, entry);
          if (completed.has(from)) continue;
          yield* Effect.gen(function* () {
            if ((yield* fs.realPath(from)) !== from)
              return yield* record(from, "Symbolic link is not copied");
            const info = yield* fs.stat(from);
            if (info.type !== "File") return;
            const to = path.join(input.attachmentsDir, entry);
            if (!(yield* fs.exists(to))) files.push({ from, to, size: Number(info.size) });
            else {
              completed.add(from);
              yield* checkpointReport();
            }
          }).pipe(Effect.catch((error) => record(from, String(error))));
        }
        const space = yield* AttachmentSeedSpace;
        const available = yield* space.availableBytes(input.attachmentsDir);
        // A fallback publish temporarily holds a second private copy of the largest file.
        const required =
          files.reduce((total, file) => total + file.size, 0) +
          files.reduce((largest, file) => Math.max(largest, file.size), 0);
        if (available < required) {
          for (const file of files)
            yield* record(
              file.from,
              `Insufficient free space: need ${required} bytes, available ${available}`,
            );
          return;
        }
        yield* Effect.forEach(
          files,
          Effect.fnUntraced(function* ({ from, to }) {
            if (yield* fs.exists(to)) {
              completed.add(from);
              yield* checkpointReport();
              return;
            }
            const temporary = `${to}.${NodeCrypto.randomUUID()}.part`;
            yield* Effect.gen(function* () {
              yield* fs.copyFile(from, temporary);
              // Both operations publish exclusively and only inside the private V2 store.
              yield* fs.link(temporary, to).pipe(
                Effect.catch((error) =>
                  error.reason._tag === "AlreadyExists"
                    ? Effect.void
                    : Effect.tryPromise({
                        try: () => NodeFSP.copyFile(temporary, to, NodeFS.constants.COPYFILE_EXCL),
                        catch: (cause) => new AttachmentSeedError({ cause }),
                      }).pipe(
                        Effect.catchIf(
                          (error) =>
                            error.cause instanceof Error &&
                            "code" in error.cause &&
                            error.cause.code === "EEXIST",
                          () => Effect.void,
                        ),
                      ),
                ),
              );
              completed.add(from);
              yield* checkpointReport();
            }).pipe(
              Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
              Effect.catch((error) => record(from, String(error))),
            );
          }),
          { concurrency: 1, discard: true },
        );
      }
    });
    yield* seed.pipe(Effect.catch((error) => record(source, String(error))));
    yield* saveReport();
    // No reseeding on restart: that would resurrect attachments V2 already pruned.
    if (skipped.length === 0) yield* fs.writeFileString(marker, "1\n");
  },
  Effect.catch((error) =>
    Effect.logWarning("V2 attachment seed could not complete; startup continues", { error }),
  ),
);
