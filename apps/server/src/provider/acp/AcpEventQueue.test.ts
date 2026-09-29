import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { acpRuntimeEventDelivery, makeAcpEventQueue } from "./AcpEventQueue.ts";

interface Event {
  readonly route: string;
  readonly id: number;
  readonly key?: string;
  readonly barrier?: boolean;
}

const classify = (event: Event) => ({
  route: event.route,
  ...(event.key === undefined ? {} : { replacementKey: event.key }),
  ...(event.barrier === undefined ? {} : { barrier: event.barrier }),
});

describe("ACP bounded intake", () => {
  it.effect("does not move later progress across a lifecycle event", () =>
    Effect.gen(function* () {
      const queue = yield* makeAcpEventQueue<Event>({ classify });
      yield* queue.offer({ route: "child", id: 1, key: "tool" });
      yield* queue.offer({ route: "parent", id: 2, barrier: true });
      yield* queue.offer({ route: "child", id: 3, key: "tool" });
      assert.deepEqual(
        (yield* queue.stream.pipe(Stream.take(3), Stream.runCollect)).map((event) => event.id),
        [1, 2, 3],
      );
    }),
  );
  it.effect("drains earlier child events before a parent terminal and holds later traffic", () =>
    Effect.gen(function* () {
      const queue = yield* makeAcpEventQueue<Event>({ classify });
      for (const event of [
        { route: "parent", id: 1 },
        { route: "child", id: 2 },
        { route: "child", id: 3 },
        { route: "parent", id: 4, barrier: true },
        { route: "child", id: 5 },
      ])
        yield* queue.offer(event);
      assert.deepEqual(
        (yield* queue.stream.pipe(Stream.take(5), Stream.runCollect)).map((event) => event.id),
        [1, 2, 3, 4, 5],
      );
    }),
  );
  it("classifies runtime completion as lossless and in-progress tools as replaceable", () => {
    const toolCall = { toolCallId: "tool", data: {} };
    assert.equal(
      acpRuntimeEventDelivery({
        _tag: "ToolCallUpdated",
        toolCall: { ...toolCall, status: "inProgress" },
        rawPayload: undefined,
      }).replacementKey,
      "tool:tool:inProgress",
    );
    for (const status of ["completed", "failed"] as const) {
      assert.isUndefined(
        acpRuntimeEventDelivery({
          _tag: "ToolCallUpdated",
          toolCall: { ...toolCall, status },
          rawPayload: undefined,
        }).replacementKey,
      );
    }
    assert.isUndefined(
      acpRuntimeEventDelivery({ _tag: "AssistantItemCompleted", itemId: "assistant" })
        .replacementKey,
    );
  });
  it.effect("rotates threads without reordering each thread's lifecycle", () =>
    Effect.gen(function* () {
      const queue = yield* makeAcpEventQueue<Event>({ classify });
      for (const event of [
        { route: "busy", id: 1 },
        { route: "busy", id: 2 },
        { route: "busy", id: 3 },
        { route: "quiet", id: 4 },
        { route: "quiet", id: 5 },
      ])
        yield* queue.offer(event);
      assert.deepEqual(
        (yield* queue.stream.pipe(Stream.take(5), Stream.runCollect)).map((event) => event.id),
        [1, 4, 2, 5, 3],
      );
    }),
  );

  it.effect("replaces 50,000 updates and retains immediate tool and turn completion", () =>
    Effect.gen(function* () {
      const queue = yield* makeAcpEventQueue<Event>({ classify });
      for (let id = 0; id < 50_000; id++) yield* queue.offer({ route: "busy", id, key: "tool" });
      yield* queue.offer({ route: "busy", id: 50_000 });
      yield* queue.offer({ route: "busy", id: 50_001 });
      assert.deepEqual(
        (yield* queue.stream.pipe(Stream.take(3), Stream.runCollect)).map((event) => event.id),
        [49_999, 50_000, 50_001],
      );
    }),
  );

  it.effect("reserves lifecycle capacity when unique progress fills a thread", () =>
    Effect.gen(function* () {
      const queue = yield* makeAcpEventQueue<Event>({
        classify,
        capacity: 8,
        routeCapacity: 6,
        reservedCapacity: 2,
      });
      for (let id = 0; id < 100; id++) yield* queue.offer({ route: "busy", id, key: String(id) });
      yield* queue.offer({ route: "busy", id: 100 });
      yield* queue.offer({ route: "busy", id: 101 });
      yield* queue.offer({ route: "quiet", id: 102 });
      const events = yield* queue.stream.pipe(Stream.take(7), Stream.runCollect);
      assert.equal(events[1]!.id, 102);
      assert.deepEqual(
        events.filter((event) => event.route === "busy").map((event) => event.id),
        [0, 1, 2, 3, 100, 101],
      );
    }),
  );

  it.effect("reports lossless overload once without blocking the producer", () =>
    Effect.gen(function* () {
      let failures = 0;
      const queue = yield* makeAcpEventQueue<Event>({
        classify,
        capacity: 4,
        routeCapacity: 3,
        reservedCapacity: 1,
        onOverflow: () =>
          Effect.sync(() => {
            failures += 1;
          }),
      });
      for (let id = 0; id < 20; id++) yield* queue.offer({ route: "busy", id });
      const exit = yield* queue.stream.pipe(Stream.runCollect, Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(failures, 1);
    }),
  );
});
