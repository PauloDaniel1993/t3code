import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  DATABASE_COMPACTION_JOURNAL_ID,
  DatabaseCompactionJournalRepository,
} from "../Services/DatabaseCompactionJournal.ts";
import { DatabaseCompactionJournalRepositoryLive } from "./DatabaseCompactionJournal.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const repositoryLayer = it.layer(
  Layer.mergeAll(
    DatabaseCompactionJournalRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

repositoryLayer("database compaction journal repository", (it) => {
  it.effect("persists resumable progress and a terminal outcome", () =>
    Effect.gen(function* () {
      const repository = yield* DatabaseCompactionJournalRepository;
      const baseJournal = {
        journalId: DATABASE_COMPACTION_JOURNAL_ID,
        safetyWatermark: 42,
        phase: "logical-compaction" as const,
        eventBatchCursor: 12,
        projectionBatchCursor: 4,
        eligibleEventCount: 20,
        processedEventCount: 12,
        skippedEventCount: 1,
        eligibleProjectionCount: 8,
        processedProjectionCount: 4,
        skippedProjectionCount: 2,
        logicalBytesReclaimed: 1_024,
        physicalBytesBefore: 8_192,
        physicalBytesAfter: null,
        terminalOutcome: null,
        startedAt: "2026-07-23T10:00:00.000Z",
        updatedAt: "2026-07-23T10:01:00.000Z",
      };

      yield* repository.upsert(baseJournal);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.get({ journalId: DATABASE_COMPACTION_JOURNAL_ID })),
        baseJournal,
      );

      const completedJournal = {
        ...baseJournal,
        phase: "completed" as const,
        eventBatchCursor: 20,
        projectionBatchCursor: 8,
        processedEventCount: 20,
        processedProjectionCount: 8,
        physicalBytesAfter: 4_096,
        terminalOutcome: {
          beforeBytes: 8_192,
          afterBytes: 4_096,
          reclaimedBytes: 4_096,
          completedAt: "2026-07-23T10:02:00.000Z",
          rollbackRetained: true,
        },
        updatedAt: "2026-07-23T10:02:00.000Z",
      };
      yield* repository.upsert(completedJournal);

      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.get({ journalId: DATABASE_COMPACTION_JOURNAL_ID })),
        completedJournal,
      );
    }),
  );
});
