import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ProviderAdapterV2Event } from "../../orchestration-v2/ProviderAdapter.ts";
import type { AcpSessionRuntimeEvent } from "./AcpSessionRuntime.ts";

export class AcpIntakeOverflow extends Schema.TaggedError<AcpIntakeOverflow>()(
  "AcpIntakeOverflow",
  { detail: Schema.String },
) {}

export interface AcpEventDelivery {
  readonly route: string;
  readonly replacementKey?: string;
  readonly barrier?: boolean;
}

export interface AcpEventQueue<A> {
  readonly offer: (event: A) => Effect.Effect<void>;
  readonly stream: Stream.Stream<A, AcpIntakeOverflow>;
}

export function acpRuntimeEventDelivery(event: AcpSessionRuntimeEvent): AcpEventDelivery {
  const replacementKey =
    event._tag === "ToolCallUpdated" &&
    event.toolCall.status !== "completed" &&
    event.toolCall.status !== "failed"
      ? `tool:${event.toolCall.toolCallId}:${event.toolCall.status}`
      : event._tag === "UsageUpdated" ||
          event._tag === "SessionInfoUpdated" ||
          event._tag === "ConfigOptionsUpdated"
        ? event._tag
        : undefined;
  return {
    route: "runtime",
    ...(replacementKey === undefined ? {} : { replacementKey }),
    ...(event._tag === "EventStreamBarrier" ? { barrier: true } : {}),
  };
}

export function makeAcpProviderEventDelivery(fallbackRoute: string) {
  const providerThreads = new Map<string, string>();
  return (event: ProviderAdapterV2Event): AcpEventDelivery => {
    let route = fallbackRoute;
    let replacementKey: string | undefined;
    switch (event.type) {
      case "app_thread.created":
        route = event.appThread.id;
        break;
      case "provider_thread.updated":
        route = event.providerThread.appThreadId ?? fallbackRoute;
        providerThreads.set(event.providerThread.id, route);
        if (providerThreads.size > 512)
          providerThreads.delete(providerThreads.keys().next().value!);
        break;
      case "provider_turn.updated":
        route =
          event.threadId ??
          providerThreads.get(event.providerTurn.providerThreadId) ??
          fallbackRoute;
        break;
      case "turn.terminal":
        route = providerThreads.get(event.providerThreadId) ?? fallbackRoute;
        break;
      case "node.updated":
        route = event.node.threadId;
        if (["pending", "running", "waiting"].includes(event.node.status))
          replacementKey = `node:${event.node.id}:${event.node.status}`;
        break;
      case "turn_item.updated":
        route = event.turnItem.threadId;
        if (
          [
            "command_execution",
            "dynamic_tool",
            "file_change",
            "file_search",
            "web_search",
            "assistant_message",
            "reasoning",
          ].includes(event.turnItem.type) &&
          ["pending", "running", "waiting"].includes(event.turnItem.status)
        )
          replacementKey = `item:${event.turnItem.id}:${event.turnItem.status}`;
        break;
      case "message.updated":
        route = event.message.threadId;
        if (event.message.streaming) replacementKey = `message:${event.message.id}`;
        break;
      case "subagent.updated":
        route = event.subagent.threadId;
        if (["pending", "running", "waiting"].includes(event.subagent.status))
          replacementKey = `subagent:${event.subagent.id}:${event.subagent.status}`;
        break;
      case "runtime_request.updated":
        route = event.threadId ?? fallbackRoute;
        break;
      case "plan.updated":
        route = event.plan.threadId;
        break;
    }
    return {
      route,
      ...(replacementKey === undefined ? {} : { replacementKey }),
      ...(event.type === "turn.terminal" ? { barrier: true } : {}),
    };
  };
}

/** Keeps FIFO within a thread, rotates between threads, and never suspends a producer. */
export const makeAcpEventQueue = Effect.fnUntraced(function* <A>(options: {
  readonly classify: (event: A) => AcpEventDelivery;
  readonly capacity?: number;
  readonly routeCapacity?: number;
  readonly reservedCapacity?: number;
  readonly onOverflow?: (error: AcpIntakeOverflow) => Effect.Effect<void>;
}) {
  const capacity = options.capacity ?? 512;
  const routeCapacity = options.routeCapacity ?? 256;
  const reserve = options.reservedCapacity ?? 64;
  const wake = yield* Queue.dropping<void>(1);
  const routes = new Map<
    string,
    Array<{ event: A; sequence: number; barrier?: boolean; key?: string }>
  >();
  const barriers: Array<number> = [];
  let sequence = 0;
  let replacementEpoch = 0;
  let size = 0;
  let deliveredSinceYield = 0;
  let failure: AcpIntakeOverflow | undefined;

  const offer = Effect.fnUntraced(function* (event: A) {
    if (failure !== undefined) return;
    const delivery = options.classify(event);
    const pending = routes.get(delivery.route) ?? [];
    const replacementKey =
      delivery.replacementKey === undefined
        ? undefined
        : `${replacementEpoch}:${delivery.replacementKey}`;
    if (replacementKey !== undefined) {
      const previous = pending.find((entry) => entry.key === replacementKey);
      if (previous !== undefined) {
        previous.event = event;
        return;
      }
      if (size >= capacity - reserve || pending.length >= routeCapacity - reserve) return;
    } else if (size >= capacity || pending.length >= routeCapacity) {
      // Lossless overflow is a session failure, never a silently dropped completion.
      failure = new AcpIntakeOverflow({ detail: "ACP lossless event intake capacity exhausted" });
      routes.clear();
      barriers.length = 0;
      size = 0;
      yield* Queue.offer(wake, undefined);
      yield* options.onOverflow?.(failure) ?? Effect.void;
      return;
    }
    // A lifecycle event fences replacement, including progress on child routes.
    if (replacementKey === undefined) replacementEpoch += 1;
    pending.push({
      event,
      sequence: ++sequence,
      ...(delivery.barrier === true ? { barrier: true } : {}),
      ...(replacementKey === undefined ? {} : { key: replacementKey }),
    });
    routes.set(delivery.route, pending);
    if (delivery.barrier === true) barriers.push(sequence);
    size += 1;
    yield* Queue.offer(wake, undefined);
  });

  const take = Effect.gen(function* () {
    while (true) {
      if (failure !== undefined) return yield* failure;
      // A parent's terminal event closes the session subscription. Drain earlier
      // child events first, and hold post-terminal traffic behind that boundary.
      const first =
        barriers[0] === undefined
          ? routes.entries().next().value
          : [...routes.entries()].find(([, pending]) => {
              const head = pending[0]!;
              if (barriers[0] === undefined) return true;
              if (head.sequence > barriers[0]) return false;
              return (
                !head.barrier ||
                ![...routes.values()].some((route) => route[0]!.sequence < head.sequence)
              );
            });
      if (first !== undefined) {
        const [route, pending] = first;
        const next = pending.shift()!;
        if (next.barrier) barriers.shift();
        routes.delete(route);
        if (pending.length > 0) routes.set(route, pending);
        size -= 1;
        // Yield during floods, while short lifecycle bursts drain together.
        if (++deliveredSinceYield === 32) {
          deliveredSinceYield = 0;
          yield* Effect.yieldNow;
        }
        return next.event;
      }
      deliveredSinceYield = 0;
      yield* Queue.take(wake);
    }
  });
  return { offer, stream: Stream.fromEffectRepeat(take) } satisfies AcpEventQueue<A>;
});
