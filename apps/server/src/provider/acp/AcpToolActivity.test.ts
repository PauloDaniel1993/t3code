import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { makeAcpToolActivity } from "./AcpToolActivity.ts";

it.effect("delivers late terminal output immediately after a turn is finalized", () =>
  Effect.gen(function* () {
    const context = { finalized: false };
    const activity = yield* makeAcpToolActivity({
      activeTurn: yield* Ref.make<typeof context | null>(context),
      permit: yield* Semaphore.make(1),
      scope: yield* Effect.scope,
    });
    const delivered: string[] = [];
    const emit = Effect.fnUntraced(function* (text: string) {
      const projection = Effect.sync(() => {
        delivered.push(text);
      });
      if (!(yield* activity.hold(context, "root:terminal", "running", projection)))
        yield* projection;
    });
    yield* emit("first chunk");
    yield* emit("last chunk before finalize");
    assert.deepEqual(delivered, ["first chunk"]);
    yield* activity.flush(context, true);
    context.finalized = true;
    yield* emit("late chunk after finalize");
    assert.deepEqual(delivered, [
      "first chunk",
      "last chunk before finalize",
      "late chunk after finalize",
    ]);
    yield* activity.flush(context, true);
    assert.equal(delivered.length, 3);
  }).pipe(Effect.scoped),
);
