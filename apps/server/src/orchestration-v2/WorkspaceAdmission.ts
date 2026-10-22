import {
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  WorkspacePrimaryFolderUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { probeUnavailableFolderPaths } from "./RuntimePolicy.ts";

// Worktree primaries may be recreated at turn start. Plain workspace primaries
// must exist before admitting a run; secondary availability is frozen on it.
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return Effect.fn("WorkspaceAdmission.admit")(function* (thread: OrchestrationV2AppThread) {
    const [primary, ...others] = thread.workspaceFolders ?? [];
    if (primary?.path !== undefined && thread.worktreePath === null) {
      const exists = yield* fileSystem.stat(primary.path).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (!exists)
        return yield* new WorkspacePrimaryFolderUnavailableError({
          projectId: thread.projectId,
          folderPath: primary.path,
        });
    }
    if (others.length === 0) return {};
    const unavailableFolderPaths = yield* probeUnavailableFolderPaths(thread).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    return { unavailableFolderPaths } satisfies Pick<OrchestrationV2Run, "unavailableFolderPaths">;
  });
});
