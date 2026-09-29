// @effect-diagnostics nodeBuiltinImport:off - unique staging names do not add config service dependencies.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { normalizeAttachmentRelativePath } from "./attachmentPaths.ts";

/** Seed once with independent bytes: V1's cleanup queue cannot see V2's files. */
export const initializeIsolatedAttachments = Effect.fn("initializeIsolatedAttachments")(
  function* (input: { readonly stateDir: string; readonly attachmentsDir: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(input.attachmentsDir, { recursive: true });
    const marker = path.join(input.stateDir, ".attachments-v2-seeded");
    if (yield* fs.exists(marker)) return;
    const source = path.join(input.stateDir, "attachments");
    if (yield* fs.exists(source)) {
      const sourceRoot = yield* fs.realPath(source);
      yield* Effect.forEach(
        yield* fs.readDirectory(source),
        Effect.fnUntraced(function* (entry) {
          if (entry.startsWith(".") || entry.endsWith(".part")) return;
          const normalized = normalizeAttachmentRelativePath(entry);
          if (normalized !== entry || normalized.includes("/")) return;
          const from = path.join(sourceRoot, entry);
          // Never follow a symlink into another directory or back into the live install.
          if ((yield* fs.realPath(from)) !== from || (yield* fs.stat(from)).type !== "File") {
            return;
          }
          const to = path.join(input.attachmentsDir, entry);
          if (yield* fs.exists(to)) return;
          const temporary = `${to}.${NodeCrypto.randomUUID()}.part`;
          yield* fs.copyFile(from, temporary);
          // Publish without replacing a file another V2 initializer already copied.
          // This link is wholly inside the private store, never back to V1's bytes.
          yield* fs.link(temporary, to).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "AlreadyExists",
              () => Effect.void,
            ),
            Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          );
        }),
        { concurrency: 4, discard: true },
      );
    }
    // No reseeding on restart: that would resurrect attachments V2 already pruned.
    yield* fs.writeFileString(marker, "1\n");
  },
);
