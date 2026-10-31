import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface Handler {
  readonly deleted: (id: ThreadId) => Effect.Effect<void>;
  readonly stop: (id: ThreadId) => Effect.Effect<void>;
  readonly continued: (id: ThreadId) => Effect.Effect<void>;
}
export class FlowLifecycle extends Context.Service<
  FlowLifecycle,
  {
    readonly register: (
      handler: Handler,
    ) => Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly deleted: Handler["deleted"];
    readonly stop: Handler["stop"];
    readonly continued: Handler["continued"];
  }
>()("t3/flows/FlowLifecycle") {}

export const layer = Layer.sync(FlowLifecycle, () => {
  let handler: Handler | undefined;
  return FlowLifecycle.of({
    register: Effect.fn("FlowLifecycle.register")((next) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          handler = next;
        }),
        () =>
          Effect.sync(() => {
            if (handler === next) handler = undefined;
          }),
      ).pipe(Effect.asVoid),
    ),
    deleted: Effect.fn("FlowLifecycle.deleted")((id) => handler?.deleted(id) ?? Effect.void),
    stop: Effect.fn("FlowLifecycle.stop")((id) => handler?.stop(id) ?? Effect.void),
    continued: Effect.fn("FlowLifecycle.continued")((id) => handler?.continued(id) ?? Effect.void),
  });
});
