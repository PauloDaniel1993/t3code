import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import { isPathWithin } from "@t3tools/shared/workspaceFolders";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { makeCheckoutLeaseKeys } from "./checkoutLease.ts";
import type * as ServerConfig from "../config.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type { WorktreeRecreateError, WorktreeSetService } from "./WorktreeSetService.ts";

type RecreationThread = Pick<
  OrchestrationV2AppThread,
  "id" | "projectId" | "branch" | "worktreePath" | "workspaceFolders" | "worktrees"
>;

type RecreateMissing = WorktreeSetService["Service"]["recreateMissing"];

/** Only server-managed locations may be recreated from a persisted thread binding. */
export const makeManagedWorktreeRecreation: Effect.Effect<
  (
    thread: RecreationThread,
    recreateMissing: RecreateMissing,
  ) => Effect.Effect<void, WorktreeRecreateError>,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
> = Effect.gen(function* () {
  const path = yield* Path.Path;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const { canonicalPath } = yield* makeCheckoutLeaseKeys;
  // Set members can sit below a session anchor; reject symlinks that escape it.
  const isManagedSetMember = Effect.fn("WorktreeSetService.isManagedSetMember")(function* (
    target: string,
  ) {
    if (!path.isAbsolute(target) || path.resolve(target) !== target) return false;
    for (let anchor = target; path.dirname(anchor) !== anchor; anchor = path.dirname(anchor)) {
      if (!(yield* isManagedWorktreePath(anchor))) continue;
      return isPathWithin(yield* canonicalPath(anchor), yield* canonicalPath(target));
    }
    return false;
  });
  return Effect.fn("WorktreeSetService.recreateMissingManaged")(function* (
    thread: RecreationThread,
    recreateMissing: WorktreeSetService["Service"]["recreateMissing"],
  ) {
    if (thread.worktrees === undefined) {
      if (thread.worktreePath !== null && (yield* isManagedWorktreePath(thread.worktreePath))) {
        yield* recreateMissing(thread);
      }
      return;
    }
    yield* recreateMissing({
      ...thread,
      worktrees: yield* Effect.filter(thread.worktrees, (member) =>
        isManagedSetMember(member.path),
      ),
    });
  });
});
