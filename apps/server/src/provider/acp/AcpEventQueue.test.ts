import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { OrchestrationV2TurnItem, ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "../../orchestration-v2/ProviderAdapter.ts";
import { makeAcpEventQueue, makeAcpProviderEventDelivery } from "./AcpEventQueue.ts";

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

describe("ACP fair coalescing intake", () => {
  it.effect("keeps the latest status when a tool returns from waiting to running", () =>
    Effect.gen(function* () {
      const queue = yield* makeAcpEventQueue<ProviderAdapterV2Event>({
        classify: makeAcpProviderEventDelivery("thread"),
      });
      for (const [id, status, title] of [
        ["tool", "running", "first"],
        ["tool", "waiting", "second"],
        ["tool", "running", "last"],
        ["marker", "completed", "marker"],
      ]) {
        const turnItem = yield* Schema.decodeUnknownEffect(OrchestrationV2TurnItem)({
          id,
          status,
          title,
          threadId: "thread",
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe(0),
          type: "dynamic_tool",
          toolName: "tool",
          input: {},
        });
        yield* queue.offer({
          type: "turn_item.updated",
          driver: ProviderDriverKind.make("acpRegistry"),
          turnItem,
        });
      }
      const events = yield* queue.stream.pipe(
        Stream.takeUntil(
          (event) => event.type === "turn_item.updated" && event.turnItem.id === "marker",
        ),
        Stream.runCollect,
      );
      const snapshots = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.id === "tool" ? [event.turnItem] : [],
      );
      assert.equal(snapshots.at(-1)?.status, "running");
      assert.equal(snapshots.at(-1)?.title, "last");
    }),
  );
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

  it.effect(
    "delivers the review probe's queued completion and final message through saturation",
    () =>
      Effect.gen(function* () {
        const queue = yield* makeAcpEventQueue<Event>({ classify });
        // IDs 1 and 2 represent the already accepted tool completion and final reply.
        for (let id = 1; id < 12; id++) yield* queue.offer({ route: "thread", id });
        const delivered: Array<number> = [];
        const exit = yield* queue.stream.pipe(
          Stream.take(11),
          Stream.tap((event) => Effect.sync(() => delivered.push(event.id))),
          Stream.runDrain,
          Effect.exit,
        );
        assert.deepEqual(
          delivered,
          Array.from({ length: 11 }, (_, index) => index + 1),
        );
        assert.isTrue(Exit.isSuccess(exit));
      }),
  );

  it.effect("keeps every distinct tool's last progress and all irreducible lifecycle events", () =>
    Effect.gen(function* () {
      const queue = yield* makeAcpEventQueue<Event>({ classify });
      for (let id = 0; id < 600; id++) yield* queue.offer({ route: "thread", id, key: String(id) });
      for (let id = 600; id < 1200; id++) yield* queue.offer({ route: "thread", id });
      const delivered: Array<number> = [];
      const exit = yield* queue.stream.pipe(
        Stream.take(1200),
        Stream.tap((event) => Effect.sync(() => delivered.push(event.id))),
        Stream.runDrain,
        Effect.exit,
      );
      assert.deepEqual(
        delivered,
        Array.from({ length: 1200 }, (_, index) => index),
      );
      assert.isTrue(Exit.isSuccess(exit));
    }),
  );

  it.effect("coalesces root progress across an unrelated child's lifecycle", () =>
    Effect.gen(function* () {
      const queue = yield* makeAcpEventQueue<Event>({ classify });
      yield* queue.offer({ route: "root", id: 1, key: "tool" });
      yield* queue.offer({ route: "child", id: 2 });
      yield* queue.offer({ route: "root", id: 3, key: "tool" });
      const delivered = yield* queue.stream.pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(
        delivered.map((event) => event.id),
        [3, 2],
      );
    }),
  );

  it.effect("drains 50,000 irreducible events in order without failing or shedding them", () =>
    Effect.gen(function* () {
      const queue = yield* makeAcpEventQueue<Event>({ classify });
      for (let id = 0; id < 50_000; id++) yield* queue.offer({ route: "thread", id });
      let expected = 0;
      yield* queue.stream.pipe(
        Stream.take(50_000),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            assert.equal(event.id, expected++);
          }),
        ),
      );
      assert.equal(expected, 50_000);
    }),
  );
});
