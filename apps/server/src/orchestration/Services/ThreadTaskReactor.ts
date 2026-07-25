/**
 * ThreadTaskReactor - task settlement and parent wake-up reactor interface.
 *
 * Watches task threads for settlement, records their results, and delivers
 * those results back into the parent thread by dispatching a turn start that
 * carries a `task-result` message.
 *
 * @module ThreadTaskReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ThreadTaskReactorShape {
  /**
   * Start reacting to orchestration domain events.
   *
   * Must be run in a scope so worker fibers are finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

export class ThreadTaskReactor extends Context.Service<ThreadTaskReactor, ThreadTaskReactorShape>()(
  "t3/orchestration/Services/ThreadTaskReactor",
) {}
