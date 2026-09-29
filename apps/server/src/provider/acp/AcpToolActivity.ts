import type { ProviderAdapterV2Event } from "../../orchestration-v2/ProviderAdapter.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";
import { normalizeAcpToolActivity } from "./AcpToolActivityNormalizer.ts";
import { makeAcpToolProgressCoalescer } from "./AcpToolProgressCoalescer.ts";

/** Hold only captured projections; receipt-time bookkeeping stays in the adapter. */
export const makeAcpToolActivity = Effect.fnUntraced(function* <
  A extends { finalized: boolean },
>(options: {
  readonly activeTurn: Ref.Ref<A | null>;
  readonly permit: Semaphore.Semaphore;
  readonly scope: Scope.Scope;
}) {
  const wake = yield* Queue.dropping<void>(1);
  const byTurn = new WeakMap<
    A,
    ReturnType<typeof makeAcpToolProgressCoalescer<Effect.Effect<void>>>
  >();
  const progressForTurn = (context: A) => {
    let progress = byTurn.get(context);
    if (progress === undefined) {
      progress = makeAcpToolProgressCoalescer<Effect.Effect<void>>();
      byTurn.set(context, progress);
    }
    return progress;
  };
  const hold = Effect.fnUntraced(function* (
    context: A,
    key: string,
    status: string,
    projection: Effect.Effect<void>,
  ) {
    // Agent-terminal output can arrive while deferred finalization clears the turn.
    if (context.finalized) return false;
    if (progressForTurn(context).offer(key, projection, status, yield* Clock.currentTimeMillis))
      return false;
    yield* Queue.offer(wake, undefined);
    return true;
  });
  const flush = Effect.fnUntraced(function* (context: A, all = false) {
    for (const projection of progressForTurn(context).flush(yield* Clock.currentTimeMillis, all)) {
      yield* projection;
    }
  });
  yield* Effect.forever(
    Queue.take(wake).pipe(
      Effect.andThen(Effect.sleep("100 millis")),
      Effect.andThen(
        options.permit.withPermit(
          Effect.gen(function* () {
            const context = yield* Ref.get(options.activeTurn);
            if (context !== null && !context.finalized) yield* flush(context);
          }),
        ),
      ),
    ),
  ).pipe(Effect.forkIn(options.scope));
  const normalize = (event: ProviderAdapterV2Event): ProviderAdapterV2Event =>
    event.type === "turn_item.updated"
      ? { ...event, turnItem: normalizeAcpToolActivity(event.turnItem) }
      : event;
  return { hold, flush, normalize };
});
