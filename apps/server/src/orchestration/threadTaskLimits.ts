/**
 * Where the per-parent task caps come from at runtime.
 *
 * The caps are enforced in two places — the decider (authoritative, and the
 * only check on the user-initiated path) and the `tasks` MCP toolkit (so an
 * agent gets a structured rejection instead of a dispatch failure). Both read
 * this reference, so there is one answer to "how many tasks may this thread
 * run".
 *
 * It holds an `Effect` rather than a plain value because settings are editable
 * while the server runs: the effect is re-run per command, so a change in the
 * settings panel takes hold on the next `task_create` without a restart. The
 * default resolves to the built-in caps, which is what the CLI and tests get
 * when no server settings layer is in scope.
 */
import { DEFAULT_THREAD_TASK_LIMITS, resolveThreadTaskLimits } from "@t3tools/contracts";
import type { ThreadTaskLimits } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";

export const ThreadTaskLimitsSource = Context.Reference<Effect.Effect<ThreadTaskLimits>>(
  "@t3tools/server/orchestration/ThreadTaskLimitsSource",
  {
    defaultValue: () => Effect.succeed(DEFAULT_THREAD_TASK_LIMITS),
  },
);

export const ThreadTaskLimitsSourceLive = Layer.effect(
  ThreadTaskLimitsSource,
  Effect.map(ServerSettingsService, (serverSettingsService) =>
    serverSettingsService.getSettings.pipe(
      Effect.map((settings) =>
        resolveThreadTaskLimits({
          maxRunning: settings.threadTaskMaxRunning,
          maxTotal: settings.threadTaskMaxTotal,
        }),
      ),
      // An unreadable settings file must not make task creation impossible;
      // the built-in caps are a working answer.
      Effect.orElseSucceed(() => DEFAULT_THREAD_TASK_LIMITS),
    ),
  ),
);
