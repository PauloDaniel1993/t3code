import type { ProviderSessionId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterEventStreamError,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
} from "./ProviderAdapter.ts";
import { sanitizeProviderEvent } from "./ProviderEventPayload.ts";

export const PROVIDER_EVENT_BACKLOG_MAX_ITEMS = 1_000;
export const PROVIDER_EVENT_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;

function replacementKey(event: ProviderAdapterV2Event): string | undefined {
  switch (event.type) {
    case "node.updated":
      // ACP emits a tool node before every tool snapshot. Preserve its first
      // position and every routing identity: routeProviderEvent only reads
      // threadId, runId and providerThreadId for nodes. A changed identity gets
      // a separate slot, so coalescing cannot remove a routing transition.
      return event.node.kind === "tool_call" && event.node.status === "running"
        ? JSON.stringify([
            event.type,
            event.driver,
            event.node.id,
            event.node.threadId,
            event.node.runId,
            event.node.providerThreadId,
            event.node.providerTurnId,
            event.node.parentNodeId,
            event.node.rootNodeId,
          ])
        : undefined;
    case "message.updated":
      return event.message.streaming
        ? JSON.stringify([
            event.type,
            event.driver,
            event.message.threadId,
            event.message.runId,
            event.message.id,
          ])
        : undefined;
    case "turn_item.updated":
      // Requests, subagent links and lifecycle items must retain every transition.
      switch (event.turnItem.type) {
        case "assistant_message":
        case "reasoning":
        case "command_execution":
        case "dynamic_tool":
        case "file_change":
        case "file_search":
        case "web_search":
          return event.turnItem.status === "running"
            ? JSON.stringify([
                event.type,
                event.driver,
                event.turnItem.threadId,
                event.turnItem.runId,
                event.turnItem.providerTurnId,
                event.turnItem.id,
              ])
            : undefined;
        default:
          return undefined;
      }
    default:
      // Provider-thread/turn events and non-tool nodes establish routing identity.
      return undefined;
  }
}

type Entry = { event: ProviderAdapterV2Event; bytes: number; key: string | undefined };
const sizes = new WeakMap<ProviderAdapterV2Event, number>();
function eventBytes(event: ProviderAdapterV2Event): number {
  const cached = sizes.get(event);
  if (cached !== undefined) return cached;
  const bytes = Buffer.byteLength(JSON.stringify(event));
  sizes.set(event, bytes);
  return bytes;
}

/** One non-blocking buffer per subscriber. Overflow fails this stream, never the session pump. */
export const makeProviderEventFlowStage = Effect.fnUntraced(function* (input: {
  readonly driver: ProviderAdapterV2Event["driver"];
  readonly providerSessionId: ProviderSessionId;
  readonly maxItems?: number;
  readonly maxBytes?: number;
}) {
  const maxItems = input.maxItems ?? PROVIDER_EVENT_BACKLOG_MAX_ITEMS;
  const maxBytes = input.maxBytes ?? PROVIDER_EVENT_BACKLOG_MAX_BYTES;
  const wake = yield* Queue.unbounded<void, Cause.Done | ProviderAdapterV2Error>();
  const pending = new Map<number, Entry>();
  const replaceable = new Map<string, Entry>();
  let nextId = 0;
  let bytes = 0;
  let inFlight: Entry | undefined;
  let ended = false;
  let failure: Cause.Cause<ProviderAdapterV2Error> | undefined;
  let notified = false;

  const notify = () => {
    if (notified) return;
    notified = true;
    Queue.offerUnsafe(wake, undefined);
  };
  const clear = () => {
    pending.clear();
    replaceable.clear();
    bytes = 0;
    inFlight = undefined;
  };
  const failNow = (cause: Cause.Cause<ProviderAdapterV2Error>) => {
    if (failure) return;
    failure = cause;
    ended = true;
    clear();
    Queue.failCauseUnsafe(wake, cause);
  };
  const offer = (raw: ProviderAdapterV2Event) =>
    Effect.sync(() => {
      if (ended) return;
      const event = sanitizeProviderEvent(raw);
      const key = replacementKey(event);
      const previous = key === undefined ? undefined : replaceable.get(key);
      const size = eventBytes(event);
      const nextBytes = bytes - (previous?.bytes ?? 0) + size;
      const nextItems = pending.size + (inFlight === undefined ? 0 : 1) + (previous ? 0 : 1);
      if (nextItems > maxItems || nextBytes > maxBytes) {
        failNow(
          Cause.fail(
            new ProviderAdapterEventStreamError({
              driver: input.driver,
              providerSessionId: input.providerSessionId,
              cause:
                "Provider event backlog exceeded its memory budget. Retry the turn to resume the provider conversation.",
            }),
          ),
        );
        return;
      }
      bytes = nextBytes;
      if (previous) {
        previous.event = event;
        previous.bytes = size;
      } else {
        const entry = { event, bytes: size, key };
        pending.set(nextId++, entry);
        if (key === undefined) {
          // A lossless event is an ordering fence for every entity.
          replaceable.clear();
        } else {
          replaceable.set(key, entry);
        }
      }
      notify();
    });
  const end = Effect.sync(() => {
    ended = true;
    notify();
  });
  const close = Effect.sync(() => {
    ended = true;
    clear();
    Queue.endUnsafe(wake);
  });
  const take = Effect.fnUntraced(function* () {
    if (inFlight) {
      bytes -= inFlight.bytes;
      inFlight = undefined;
    }
    while (true) {
      if (failure) return yield* Effect.failCause(failure);
      const first = pending.entries().next().value;
      if (first) {
        const [id, entry] = first;
        pending.delete(id);
        if (entry.key !== undefined && replaceable.get(entry.key) === entry)
          replaceable.delete(entry.key);
        inFlight = entry;
        return entry.event;
      }
      if (ended) return yield* Cause.done();
      yield* Queue.take(wake);
      notified = false;
    }
  });
  return {
    offer,
    fail: (cause: Cause.Cause<ProviderAdapterV2Error>) => Effect.sync(() => failNow(cause)),
    end,
    close,
    events: Stream.fromEffectRepeat(take()).pipe(Stream.ensuring(close)),
    usage: Effect.sync(() => ({ items: pending.size + (inFlight === undefined ? 0 : 1), bytes })),
  };
});

export type ProviderEventFlowStage = Effect.Success<ReturnType<typeof makeProviderEventFlowStage>>;
