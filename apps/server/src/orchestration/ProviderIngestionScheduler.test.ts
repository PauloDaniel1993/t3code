import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { expect } from "vite-plus/test";

import {
  makeProviderIngestionScheduler,
  type ScheduledProviderInput,
} from "./ProviderIngestionScheduler.ts";

interface TestInput {
  readonly id: string;
  readonly text: string;
}

const scheduled = (
  value: TestInput,
  options?: Partial<Omit<ScheduledProviderInput<TestInput>, "value">>,
): ScheduledProviderInput<TestInput> => ({
  value,
  laneKey: "thread-a",
  provider: "kimi",
  deliveryClass: "lossless",
  terminal: false,
  eventCreatedAtMs: 0,
  ...options,
});

const mergeTestInput = (current: TestInput, incoming: TestInput): TestInput | undefined =>
  current.id === incoming.id
    ? {
        ...current,
        text: current.text + incoming.text,
      }
    : undefined;

it.effect("round-robins ready provider lanes without losing per-lane order", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const processed = yield* Ref.make<Array<string>>([]);
    const scheduler = yield* makeProviderIngestionScheduler(
      {
        perLaneCapacity: 8,
        reservedLosslessCapacity: 2,
        merge: mergeTestInput,
      },
      (input) =>
        Effect.gen(function* () {
          if (input.id === "a0") {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          }
          yield* Ref.update(processed, (current) => [...current, input.id]);
        }),
    );

    yield* scheduler.enqueue(scheduled({ id: "a0", text: "" }));
    yield* Deferred.await(firstStarted);
    yield* scheduler.enqueue(scheduled({ id: "a1", text: "" }));
    yield* scheduler.enqueue(scheduled({ id: "a2", text: "" }));
    yield* scheduler.enqueue(
      scheduled({ id: "b1", text: "" }, { laneKey: "thread-b", provider: "codex" }),
    );
    yield* scheduler.enqueue(
      scheduled({ id: "b2", text: "" }, { laneKey: "thread-b", provider: "codex" }),
    );
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* scheduler.drain;

    expect(yield* Ref.get(processed)).toEqual(["a0", "a1", "b1", "a2", "b2"]);
  }).pipe(Effect.scoped),
);

it.effect(
  "reserves lossless capacity, replaces keyed progress, and backpressures at the hard cap",
  () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const processed = yield* Ref.make<Array<string>>([]);
      const scheduler = yield* makeProviderIngestionScheduler(
        {
          perLaneCapacity: 3,
          reservedLosslessCapacity: 1,
          merge: mergeTestInput,
        },
        (input) =>
          Effect.gen(function* () {
            if (input.id === "processing") {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            yield* Ref.update(processed, (current) => [...current, `${input.id}:${input.text}`]);
          }),
      );

      yield* scheduler.enqueue(scheduled({ id: "processing", text: "" }));
      yield* Deferred.await(firstStarted);
      yield* scheduler.enqueue(
        scheduled(
          { id: "tool-1", text: "old" },
          { deliveryClass: "replaceable", replacementKey: "tool-1" },
        ),
      );
      yield* scheduler.enqueue(
        scheduled(
          { id: "tool-2", text: "progress" },
          { deliveryClass: "replaceable", replacementKey: "tool-2" },
        ),
      );
      yield* scheduler.enqueue(
        scheduled(
          { id: "tool-1", text: "latest" },
          { deliveryClass: "replaceable", replacementKey: "tool-1" },
        ),
      );
      yield* scheduler.enqueue(scheduled({ id: "terminal", text: "" }, { terminal: true }));
      const blockedFiber = yield* scheduler
        .enqueue(scheduled({ id: "after-capacity", text: "" }))
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(blockedFiber.pollUnsafe()).toBeUndefined();
      expect((yield* scheduler.stats).pendingEnqueueCount).toBe(1);
      const drainFiber = yield* scheduler.drain.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(drainFiber.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(blockedFiber);
      yield* Fiber.join(drainFiber);

      const output = yield* Ref.get(processed);
      expect(output).toContain("tool-1:latest");
      expect(output).not.toContain("tool-1:old");
      expect(output.indexOf("tool-1:latest")).toBeLessThan(output.indexOf("terminal:"));
      expect((yield* scheduler.stats).coalescedCount).toBe(1);
      expect((yield* scheduler.stats).backpressureCount).toBe(1);
      expect((yield* scheduler.stats).pendingEnqueueCount).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("merges adjacent assistant deltas with exact reconstruction", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const processed = yield* Ref.make<Array<TestInput>>([]);
    const scheduler = yield* makeProviderIngestionScheduler(
      {
        perLaneCapacity: 8,
        reservedLosslessCapacity: 2,
        merge: mergeTestInput,
      },
      (input) =>
        Effect.gen(function* () {
          if (input.id === "processing") {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          }
          yield* Ref.update(processed, (current) => [...current, input]);
        }),
    );

    yield* scheduler.enqueue(scheduled({ id: "processing", text: "" }));
    yield* Deferred.await(firstStarted);
    for (const text of ["hello", " ", "world"]) {
      yield* scheduler.enqueue(
        scheduled(
          { id: "assistant", text },
          { deliveryClass: "mergeable", mergeKey: "assistant-1" },
        ),
      );
    }
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* scheduler.drain;

    expect((yield* Ref.get(processed)).filter((input) => input.id === "assistant")).toEqual([
      { id: "assistant", text: "hello world" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("keeps Codex terminal work responsive during a Kimi-style progress flood", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const processed = yield* Ref.make<Array<string>>([]);
    const scheduler = yield* makeProviderIngestionScheduler(
      {
        perLaneCapacity: 16,
        reservedLosslessCapacity: 4,
        merge: mergeTestInput,
      },
      (input) =>
        Effect.gen(function* () {
          if (input.id === "processing") {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          }
          yield* Ref.update(processed, (current) => [...current, input.id]);
        }),
    );

    yield* scheduler.enqueue(scheduled({ id: "processing", text: "" }));
    yield* Deferred.await(firstStarted);
    for (let index = 0; index < 50_000; index += 1) {
      yield* scheduler.enqueue(
        scheduled(
          { id: `kimi-${index}`, text: "" },
          {
            deliveryClass: "replaceable",
            replacementKey: "kimi-tool",
          },
        ),
      );
    }
    yield* scheduler.enqueue(
      scheduled(
        { id: "codex-terminal", text: "" },
        {
          laneKey: "thread-codex",
          provider: "codex",
          terminal: true,
        },
      ),
    );
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* scheduler.drain;

    const output = yield* Ref.get(processed);
    expect(output).toEqual(["processing", "kimi-49999", "codex-terminal"]);
    expect((yield* scheduler.stats).coalescedCount).toBe(49_999);
  }).pipe(Effect.scoped),
);

it.effect("interrupts an in-flight processor when the scheduler scope closes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const scheduler = yield* makeProviderIngestionScheduler(
          {
            perLaneCapacity: 4,
            reservedLosslessCapacity: 1,
            merge: mergeTestInput,
          },
          () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        );
        yield* scheduler.enqueue(scheduled({ id: "in-flight", text: "" }));
        yield* Deferred.await(started);
      }),
    );
    expect(true).toBe(true);
  }),
);
