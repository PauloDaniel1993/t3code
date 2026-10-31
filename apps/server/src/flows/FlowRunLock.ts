import type { FlowRunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class FlowRunLock extends Context.Service<
  FlowRunLock,
  {
    readonly withRunLock: <A, E, R>(
      id: FlowRunId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/flows/FlowRunLock") {}

export const layer = Layer.sync(FlowRunLock, () => {
  const locks = new Map<FlowRunId, { gate: Semaphore.Semaphore; users: number }>();
  return FlowRunLock.of({
    withRunLock: Effect.fn("FlowRunLock.withRunLock")(
      <A, E, R>(id: FlowRunId, effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const entry = locks.get(id) ?? { gate: Semaphore.makeUnsafe(1), users: 0 };
            entry.users++;
            locks.set(id, entry);
            return entry;
          }),
          (entry) => entry.gate.withPermits(1)(effect),
          (entry) =>
            Effect.sync(() => {
              if (--entry.users === 0) locks.delete(id);
            }),
        ),
    ),
  });
});
