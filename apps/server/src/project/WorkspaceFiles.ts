import { WorkspaceFileDiagnostic, type WorkspaceFolderEntry } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { expandHomePathWith } from "../pathExpansion.ts";
import { parseWorkspaceFile } from "./workspaceFileDefinition.ts";

// VS Code workspace files are a few kilobytes; anything far larger is not one.
const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;

/** A workspace file's folders, read from its normalized server path. */
export interface WorkspaceFileDefinition {
  /** The file's normalized server path, which identifies the link. */
  readonly filePath: string;
  /** In file order, deduplicated; the first is a local path. */
  readonly folders: ReadonlyArray<WorkspaceFolderEntry>;
}

export class WorkspaceFileReadError extends Schema.TaggedError<WorkspaceFileReadError>()(
  "WorkspaceFileReadError",
  { diagnostic: WorkspaceFileDiagnostic },
) {
  override get message(): string {
    return this.diagnostic.message;
  }
}

export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  {
    /**
     * Read a workspace file chosen explicitly as one. A directory is not a
     * workspace file whatever its name: callers choose file mode only for files.
     */
    readonly read: (
      filePath: string,
    ) => Effect.Effect<WorkspaceFileDefinition, WorkspaceFileReadError>;
  }
>()("t3/project/WorkspaceFiles") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;

  const read: WorkspaceFiles["Service"]["read"] = Effect.fn("WorkspaceFiles.read")(
    function* (requestedPath) {
      const filePath = path.resolve(expandHomePathWith(requestedPath.trim(), path));
      const fail = (diagnostic: Omit<WorkspaceFileDiagnostic, "path">) =>
        Effect.fail(new WorkspaceFileReadError({ diagnostic: { ...diagnostic, path: filePath } }));
      const unreadable = () =>
        fail({ code: "unreadable", message: `Can't read the workspace file ${filePath}.` });

      const stat = yield* fileSystem
        .stat(filePath)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? fail({ code: "file-not-found", message: `Workspace file not found: ${filePath}` })
              : unreadable(),
          ),
        );
      if (stat.type !== "File") {
        return yield* fail({
          code: "not-a-file",
          message: `${filePath} is not a file. Choose a .code-workspace file.`,
        });
      }
      if (Number(stat.size) > MAX_WORKSPACE_FILE_BYTES) {
        return yield* fail({
          code: "unreadable",
          message: `The workspace file ${filePath} is too large to be a workspace file.`,
        });
      }
      const text = yield* fileSystem.readFileString(filePath).pipe(Effect.catch(unreadable));
      const folders = parseWorkspaceFile({ text, filePath, platform });
      if (Result.isFailure(folders)) {
        return yield* new WorkspaceFileReadError({ diagnostic: folders.failure });
      }
      return { filePath, folders: folders.success };
    },
  );

  return WorkspaceFiles.of({ read });
});

export const layer = Layer.effect(WorkspaceFiles, make);
