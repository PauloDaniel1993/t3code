/**
 * One non-blocking lane per run, routed before retention. Only superseded
 * in-progress snapshots are replaced; finals, errors, requests, routing changes
 * and each entity's last state remain ordered and lossless. 1,000 entries/8 MiB
 * are pressure targets, not correctness-breaking hard caps: an irreducible tail
 * of distinct entities or finals is retained even above them. Pressure never
 * fails a run or leaves an unobserved native turn running. A finite hard bound
 * on arbitrary lossless traffic would require disk spooling or backpressure.
 * Provider failure seals admission and drains accepted events before failing;
 * explicit close/shutdown discards the tail. No extra queue or flush timer.
 */
import type { ProviderSessionId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ProviderAdapterV2Error, ProviderAdapterV2Event } from "./ProviderAdapter.ts";
import { sanitizeProviderEvent } from "./ProviderEventPayload.ts";

export const PROVIDER_EVENT_BACKLOG_MAX_ITEMS = 1_000;
export const PROVIDER_EVENT_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;

function replacementKey(event: ProviderAdapterV2Event): string | undefined {
  switch (event.type) {
    case "node.updated":
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
      return undefined;
  }
}
type Entry = { event: ProviderAdapterV2Event; key: string | undefined };
const sizes = new WeakMap<ProviderAdapterV2Event, number>();
function eventBytes(event: ProviderAdapterV2Event): number {
  const cached = sizes.get(event);
  if (cached !== undefined) return cached;
  const bytes = Buffer.byteLength(JSON.stringify(event));
  sizes.set(event, bytes);
  return bytes;
}

export const makeProviderEventFlowStage = Effect.fnUntraced(function* (input: {
  readonly driver: ProviderAdapterV2Event["driver"];
  readonly providerSessionId: ProviderSessionId;
  readonly maxItems?: number;
  readonly maxBytes?: number;
}) {
  const wake = yield* Queue.unbounded<void, Cause.Done>();
  const pending = new Map<number, Entry>();
  const replaceable = new Map<string, Entry>();
  let admit: (event: ProviderAdapterV2Event) => boolean = () => true;
  let nextId = 0;
  let lookupReady = false;
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
    inFlight = undefined;
    lookupReady = false;
  };
  const offer = (raw: ProviderAdapterV2Event) =>
    Effect.sync(() => {
      if (ended || !admit(raw)) return;
      const event = sanitizeProviderEvent(raw);
      if (pending.size === 0) lookupReady = false;
      // A consumer keeping up never needs a replacement key or JSON byte count.
      // Materialize lookup only when another snapshot is actually waiting.
      if (pending.size > 0 && !lookupReady) {
        for (const entry of pending.values()) {
          entry.key = replacementKey(entry.event);
          if (entry.key === undefined) replaceable.clear();
          else replaceable.set(entry.key, entry);
        }
        lookupReady = true;
      }
      const key = pending.size === 0 ? undefined : replacementKey(event);
      const previous = key === undefined ? undefined : replaceable.get(key);
      if (previous) previous.event = event;
      else {
        const entry = { event, key };
        pending.set(nextId++, entry);
        if (key === undefined) replaceable.clear();
        else replaceable.set(key, entry);
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
    inFlight = undefined;
    while (true) {
      const first = pending.entries().next().value;
      if (first) {
        const [id, entry] = first;
        pending.delete(id);
        if (entry.key !== undefined && replaceable.get(entry.key) === entry)
          replaceable.delete(entry.key);
        if (pending.size === 0) lookupReady = false;
        inFlight = entry;
        return entry.event;
      }
      if (failure) return yield* Effect.failCause(failure);
      if (ended) return yield* Cause.done();
      yield* Queue.take(wake);
      notified = false;
    }
  });
  return {
    offer,
    fail: (cause: Cause.Cause<ProviderAdapterV2Error>) =>
      Effect.sync(() => {
        if (ended) return;
        ended = true;
        failure = cause;
        notify();
      }),
    end,
    close,
    // Configure before startTurn. Re-route the small pre-configuration tail too,
    // since inherited-background discovery may yield while the session is busy.
    filter: (predicate: (event: ProviderAdapterV2Event) => boolean) =>
      Effect.sync(() => {
        admit = predicate;
        lookupReady = true;
        replaceable.clear();
        for (const [id, entry] of pending) {
          if (!admit(entry.event)) {
            pending.delete(id);
            continue;
          }
          entry.key = replacementKey(entry.event);
          if (entry.key === undefined) replaceable.clear();
          else replaceable.set(entry.key, entry);
        }
      }),
    events: Stream.fromEffectRepeat(take()).pipe(Stream.ensuring(close)),
    budget: {
      items: input.maxItems ?? PROVIDER_EVENT_BACKLOG_MAX_ITEMS,
      bytes: input.maxBytes ?? PROVIDER_EVENT_BACKLOG_MAX_BYTES,
    },
    // Serialization is diagnostic work only, never on the no-pressure pump path.
    usage: Effect.sync(() => ({
      items: pending.size + (inFlight === undefined ? 0 : 1),
      bytes: [...pending.values(), ...(inFlight === undefined ? [] : [inFlight])].reduce(
        (total, entry) => total + eventBytes(entry.event),
        0,
      ),
    })),
  };
});
export type ProviderEventFlowStage = Effect.Success<ReturnType<typeof makeProviderEventFlowStage>>;
