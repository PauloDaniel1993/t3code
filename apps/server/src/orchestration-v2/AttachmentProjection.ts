import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { applyWithAttachmentPruning } from "./AttachmentReferences.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { ProjectionStoreV2, ProjectionStoreApplyEventError } from "./ProjectionStore.ts";
import { EventSinkV2 } from "./EventSink.ts";

/** EventSink owns the transaction. Rebuilds use the base store and only rebuild the index. */
export const layer = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const base = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutboxV2;
    return ProjectionStoreV2.of({
      ...base,
      apply: (event) =>
        applyWithAttachmentPruning({ sequence: 0, commandId: null, event }, base.apply(event)).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(EffectOutboxV2, outbox),
          Effect.asVoid,
          Effect.mapError(
            (cause) => new ProjectionStoreApplyEventError({ eventType: event.type, cause }),
          ),
        ),
    });
  }),
);

/** Wake cleanup only after EventSink has committed, including its guarded write paths. */
export const sinkLayer = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const base = yield* EventSinkV2;
    const outbox = yield* EffectOutboxV2;
    const notify = (events: Parameters<typeof base.write>[0]["events"]) =>
      events.some(
        (event) =>
          event.type === "thread.deleted" ||
          (event.type === "message.updated" && !event.payload.streaming) ||
          (event.type === "turn-item.updated" &&
            (event.payload.type === "user_message" ||
              event.payload.type === "user_input_request" ||
              (event.payload.type === "assistant_message" && !event.payload.streaming))),
      )
        ? outbox.notifyAvailable(1)
        : Effect.void;
    return EventSinkV2.of({
      ...base,
      write: (input) => base.write(input).pipe(Effect.tap(() => notify(input.events))),
      writeWithEffects: (input) =>
        base.writeWithEffects(input).pipe(Effect.tap(() => notify(input.events))),
      writeIfRunCurrent: (input) =>
        base
          .writeIfRunCurrent(input)
          .pipe(Effect.tap((result) => (result.committed ? notify(input.events) : Effect.void))),
      writeIfProviderThreadOwner: (input) =>
        base
          .writeIfProviderThreadOwner(input)
          .pipe(Effect.tap((result) => (result.committed ? notify(input.events) : Effect.void))),
      commitCommand: (input) =>
        base
          .commitCommand(input)
          .pipe(Effect.tap((result) => (result.committed ? notify(input.events) : Effect.void))),
    });
  }),
);
