import { MessageId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments: ReadonlyArray<ChatAttachment> = [
        {
          type: "image",
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
        {
          type: "document",
          id: "thread-preserve-attachments-att-2",
          name: "reference.pdf",
          mimeType: "application/pdf",
          sizeBytes: 7,
        },
        {
          type: "file",
          id: "thread-preserve-attachments-att-3",
          name: "notes.ts",
          mimeType: "text/plain",
          sizeBytes: 9,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );
});

layer("ProjectionThreadMessageRepository message source", (it) => {
  it.effect("round-trips authorship and leaves older rows without one", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-message-source");
      const createdAt = "2026-07-25T12:00:00.000Z";

      yield* repository.upsert({
        messageId: MessageId.make("message-woken"),
        threadId,
        turnId: null,
        role: "user",
        source: "task-result",
        text: "Task finished.",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      // A row written before the column existed carries no source at all.
      yield* repository.upsert({
        messageId: MessageId.make("message-typed"),
        threadId,
        turnId: null,
        role: "user",
        text: "What changed?",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      const rows = yield* repository.listByThreadId({ threadId });
      const byId = new Map(rows.map((row) => [row.messageId as string, row]));
      assert.equal(byId.get("message-woken")?.source, "task-result");
      assert.equal(byId.get("message-typed")?.source, undefined);
    }),
  );

  it.effect("keeps authorship when a later upsert omits it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-message-source-streaming");
      const messageId = MessageId.make("message-streamed");
      const createdAt = "2026-07-25T12:00:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        source: "provider",
        text: "partial",
        isStreaming: true,
        createdAt,
        updatedAt: createdAt,
      });
      // The terminal write of a streamed message need not repeat the source;
      // erasing it here would make the message look like something the user
      // typed on the next read.
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "complete",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-07-25T12:00:01.000Z",
      });

      const row = yield* repository.getByMessageId({ messageId });
      assert.equal(Option.getOrNull(row)?.source, "provider");
      assert.equal(Option.getOrNull(row)?.text, "complete");
    }),
  );
});
