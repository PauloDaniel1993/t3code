import {
  ChatAttachment,
  EventId,
  TurnItemId,
  ThreadId,
  OrchestrationV2TurnItem,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { recordForkImportWarning } from "../../persistence/ForkImportDiagnostics.ts";

export const forkLegacyMessageRoles = ["user", "assistant", "reasoning"] as const;

interface MessageRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly role: "user" | "assistant" | "reasoning";
  readonly source: string | null;
  readonly text: string;
  readonly attachments_json: string | null;
  readonly is_streaming: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ordinal: number;
}

const decodeSource = Schema.decodeUnknownOption(
  OrchestrationV2TurnItem.members[0].fields.legacyMessageSource,
);
const decodeArray = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
const decodeAttachment = Schema.decodeUnknownOption(ChatAttachment);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeForkLegacyMessageEvents = Effect.fn("makeForkLegacyMessageEvents")(function* <
  Row extends MessageRow,
>(
  conversationEvents: (
    row: Row & { readonly role: "user" | "assistant" },
  ) => ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const sql = yield* SqlClient.SqlClient;
  return (row: Row) =>
    forkLegacyMessageEvents(row, conversationEvents).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
});

/** Wrap upstream's conversation mapping without copying or refactoring it. */
export const forkLegacyMessageEvents = Effect.fn("forkLegacyMessageEvents")(function* <
  Row extends MessageRow,
>(
  row: Row,
  conversationEvents: (
    row: Row & { readonly role: "user" | "assistant" },
  ) => ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const source = Option.getOrUndefined(decodeSource(row.source));
  if (row.source !== null && source === undefined) {
    yield* recordForkImportWarning(
      row.message_id,
      "source",
      "Unknown message source; retained raw value and used role-derived authorship.",
      row.source,
    );
  }
  const createdBy =
    source === "task-result" || source === "system"
      ? "system"
      : source === "provider"
        ? "agent"
        : source === "user" || row.role === "user"
          ? "user"
          : "agent";
  const creationSource = source === "provider" ? "provider" : "server";
  const threadId = ThreadId.make(row.thread_id);
  const updatedAt = DateTime.makeUnsafe(row.updated_at);
  if (row.role === "reasoning") {
    return [
      {
        id: EventId.make(`migration:v1:turn-item:${row.message_id}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: updatedAt,
        payload: {
          id: TurnItemId.make(`migration:v1:turn-item:${row.message_id}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: row.ordinal,
          status: row.is_streaming === 1 ? "interrupted" : "completed",
          title: null,
          startedAt: DateTime.makeUnsafe(row.created_at),
          completedAt: updatedAt,
          updatedAt,
          type: "reasoning",
          text: row.text,
          streaming: false,
          ...(source === undefined ? {} : { legacyMessageSource: source }),
        },
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
  }
  const attachments: ChatAttachment[] = [];
  if (row.attachments_json !== null) {
    const entries = decodeArray(row.attachments_json);
    if (Option.isNone(entries)) {
      yield* recordForkImportWarning(
        row.message_id,
        "attachments_json",
        "Invalid attachment array; retained raw value.",
        row.attachments_json,
      );
    } else {
      for (const [index, entry] of entries.value.entries()) {
        const normalized =
          Predicate.isObject(entry) && entry.type === "document"
            ? { ...entry, type: "file" }
            : entry;
        const decoded = decodeAttachment(normalized);
        if (Option.isSome(decoded)) attachments.push(decoded.value);
        else
          yield* recordForkImportWarning(
            row.message_id,
            `attachments_json[${index}]`,
            "Invalid attachment entry; skipped only this entry.",
            yield* encodeJson(entry),
          );
      }
    }
  }
  return conversationEvents({
    ...row,
    role: row.role,
    attachments_json: yield* encodeJson(attachments),
  }).map((event): OrchestrationV2DomainEvent => {
    if (event.type === "message.updated")
      return { ...event, payload: { ...event.payload, createdBy, creationSource } };
    if (event.type !== "turn-item.updated") return event;
    return {
      ...event,
      payload: {
        ...event.payload,
        ...(source === undefined ? {} : { legacyMessageSource: source }),
        ...(event.payload.type === "user_message" ? { createdBy, creationSource } : {}),
      },
    };
  });
});
