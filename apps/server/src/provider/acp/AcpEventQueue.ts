import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { ProviderAdapterV2Event } from "../../orchestration-v2/ProviderAdapter.ts";

export interface AcpEventDelivery {
  readonly route: string;
  readonly replacementKey?: string;
  readonly barrier?: boolean;
}

export interface AcpEventQueue<A> {
  readonly offer: (event: A) => Effect.Effect<void>;
  readonly stream: Stream.Stream<A>;
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
          replacementKey = `node:${event.node.id}`;
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
          replacementKey = `item:${event.turnItem.id}`;
        break;
      case "message.updated":
        route = event.message.threadId;
        if (event.message.streaming) replacementKey = `message:${event.message.id}`;
        break;
      case "subagent.updated":
        route = event.subagent.threadId;
        if (["pending", "running", "waiting"].includes(event.subagent.status))
          replacementKey = `subagent:${event.subagent.id}`;
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

/**
 * Keeps FIFO within a thread, rotates between threads, and never suspends a producer.
 * Only superseded snapshots are shed. Distinct latest states and lossless events
 * can exceed any count target: a strict bound would require spooling or backpressure.
 */
export const makeAcpEventQueue = Effect.fnUntraced(function* <A>(options: {
  readonly classify: (event: A) => AcpEventDelivery;
}) {
  const wake = yield* Queue.dropping<void>(1);
  type Entry = { event: A; sequence: number; barrier?: boolean; key?: string };
  const routes = new Map<
    string,
    {
      pending: Array<Entry>;
      head: number;
      replacements: Map<string, Entry>;
    }
  >();
  const barriers: Array<number> = [];
  let sequence = 0;
  let deliveredSinceYield = 0;

  const offer = Effect.fnUntraced(function* (event: A) {
    const delivery = options.classify(event);
    const route = routes.get(delivery.route) ?? {
      pending: [],
      head: 0,
      replacements: new Map<string, Entry>(),
    };
    const replacementKey = delivery.replacementKey;
    if (replacementKey !== undefined) {
      const previous = route.replacements.get(replacementKey);
      if (previous !== undefined) {
        previous.event = event;
        return;
      }
    }
    // Ordinary lifecycle fences only its route; a turn terminal fences every route.
    if (replacementKey === undefined) route.replacements.clear();
    if (delivery.barrier === true)
      for (const pendingRoute of routes.values()) pendingRoute.replacements.clear();
    const entry: Entry = {
      event,
      sequence: ++sequence,
      ...(delivery.barrier === true ? { barrier: true } : {}),
      ...(replacementKey === undefined ? {} : { key: replacementKey }),
    };
    route.pending.push(entry);
    if (replacementKey !== undefined) route.replacements.set(replacementKey, entry);
    routes.set(delivery.route, route);
    if (delivery.barrier === true) barriers.push(sequence);
    yield* Queue.offer(wake, undefined);
  });

  const take = Effect.gen(function* () {
    while (true) {
      // A parent's terminal event closes the session subscription. Drain earlier
      // child events first, and hold post-terminal traffic behind that boundary.
      const first =
        barriers[0] === undefined
          ? routes.entries().next().value
          : [...routes.entries()].find(([, route]) => {
              const head = route.pending[route.head]!;
              if (barriers[0] === undefined) return true;
              if (head.sequence > barriers[0]) return false;
              return (
                !head.barrier ||
                ![...routes.values()].some(
                  (route) => route.pending[route.head]!.sequence < head.sequence,
                )
              );
            });
      if (first !== undefined) {
        const [routeId, route] = first;
        const next = route.pending[route.head++]!;
        if (next.key !== undefined && route.replacements.get(next.key) === next)
          route.replacements.delete(next.key);
        if (next.barrier) barriers.shift();
        routes.delete(routeId);
        if (route.head < route.pending.length) {
          // Amortize FIFO removal now that irreducible traffic can exceed a target.
          if (route.head >= 1024 && route.head * 2 >= route.pending.length) {
            route.pending = route.pending.slice(route.head);
            route.head = 0;
          }
          routes.set(routeId, route);
        }
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
