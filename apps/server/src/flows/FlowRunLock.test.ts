import { expect, it } from "@effect/vitest";
import { FlowRunId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FlowRunLock from "./FlowRunLock.ts";

it.effect("serializes one run while allowing other runs and releases interrupted holders", () =>
  Effect.gen(function* () {
    const lock = yield* FlowRunLock.FlowRunLock;
    const entered = yield* Deferred.make<void>();
    const queued = yield* Deferred.make<void>();
    const calls: string[] = [];
    const first = yield* lock
      .withRunLock(
        FlowRunId.make("a"),
        Effect.gen(function* () {
          calls.push("first");
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const second = yield* Effect.gen(function* () {
      yield* Deferred.succeed(queued, undefined);
      yield* lock.withRunLock(
        FlowRunId.make("a"),
        Effect.sync(() => calls.push("second")),
      );
    }).pipe(Effect.forkChild);
    yield* Deferred.await(queued);
    yield* lock.withRunLock(
      FlowRunId.make("b"),
      Effect.sync(() => calls.push("other")),
    );
    expect(calls).toEqual(["first", "other"]);
    yield* Fiber.interrupt(first);
    yield* Fiber.join(second);
    expect(calls).toEqual(["first", "other", "second"]);
  }).pipe(Effect.provide(FlowRunLock.layer)),
);
