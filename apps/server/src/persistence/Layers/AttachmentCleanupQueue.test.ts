import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { AttachmentCleanupQueueRepository } from "../Services/AttachmentCleanupQueue.ts";
import { AttachmentCleanupQueueRepositoryLive } from "./AttachmentCleanupQueue.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  AttachmentCleanupQueueRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("AttachmentCleanupQueueRepository", (it) => {
  it.effect("deduplicates intents and persists retry state until completion", () =>
    Effect.gen(function* () {
      const repository = yield* AttachmentCleanupQueueRepository;
      const input = {
        operation: "delete-path" as const,
        threadId: ThreadId.make("thread-cleanup-queue"),
        relativePath: "thread-cleanup-queue-00000000-0000-4000-8000-000000000001.txt",
        createdAt: "2026-01-01T00:00:00.000Z",
      };

      yield* repository.enqueue(input);
      yield* repository.enqueue(input);

      const pending = yield* repository.listPending({ limit: 10 });
      assert.equal(pending.length, 1);
      const intent = pending[0];
      if (!intent) {
        return yield* Effect.die("Expected an attachment cleanup intent.");
      }
      assert.equal(intent.attemptCount, 0);

      const failure = yield* repository.recordFailure({
        id: intent.id,
        attemptedAt: "2026-01-01T00:00:01.000Z",
        error: "locked",
      });
      assert.deepEqual(Option.getOrNull(failure), { attemptCount: 1 });

      const retried = yield* repository.listPending({ limit: 10 });
      assert.equal(retried[0]?.attemptCount, 1);
      assert.equal(retried[0]?.lastError, "locked");

      yield* repository.markSucceeded({ id: intent.id });
      assert.deepEqual(yield* repository.listPending({ limit: 10 }), []);
    }),
  );
});
