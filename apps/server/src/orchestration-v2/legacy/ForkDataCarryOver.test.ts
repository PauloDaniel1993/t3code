import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EventSinkV2, EventSinkWriteError } from "../EventSink.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
} from "../ProjectionStore.ts";
import { ProjectionMaintenanceV2 } from "../ProjectionMaintenance.ts";
import { LegacyV1ThreadImporter, layer as importerLayer } from "./LegacyV1ThreadImporter.ts";
import { assertForkTaskLinksRepaired, repairForkTaskLinks } from "./ForkTaskLinkRepair.ts";

import { TestLayer, stamp, seedThreads } from "./ForkDataCarryOver.testkit.ts";

it.effect(
  "carries source tags and reasoning through previews, lazy hydration, replay and compaction",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter;
      const projections = yield* ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      yield* seedThreads([
        ["root", null],
        ["child", "root"],
        ["grandchild", "child"],
      ]);
      yield* sql`UPDATE projection_threads SET archived_at = ${stamp}, deleted_at = ${stamp} WHERE thread_id = 'root'`;
      const sources = [null, "user", "provider", "system", "task-result"] as const;
      for (let index = 0; index < 123; index++) {
        const role = index % 3 === 2 ? "reasoning" : index % 3 === 1 ? "assistant" : "user";
        yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, source, is_streaming, created_at, updated_at)
        VALUES (${`m${String(index).padStart(3, "0")}`}, 'child', ${role}, ${`text ${index}`},
          ${sources[index % sources.length] ?? null}, ${index === 122 ? 1 : 0}, ${stamp}, ${stamp})`;
      }
      yield* importer.reconcileShells;
      assert.equal((yield* Effect.exit(maintenance.compactEventStore))._tag, "Failure");
      assert.deepEqual(yield* repairForkTaskLinks(), { repairedThreadCount: 2 });
      const preview = yield* projections.getThreadProjection(ThreadId.make("child"));
      assert.equal(preview.turnItems.find((item) => item.type === "reasoning")?.ordinal, 123);
      const actualSink = yield* EventSinkV2;
      let batches = 0;
      const interruptedHydration = Effect.gen(function* () {
        return yield* (yield* LegacyV1ThreadImporter).ensureTranscript(ThreadId.make("child"));
      }).pipe(
        Effect.provide(Layer.fresh(importerLayer)),
        Effect.provideService(EventSinkV2, {
          ...actualSink,
          write: (input) =>
            ++batches === 2
              ? Effect.fail(
                  new EventSinkWriteError({
                    eventCount: input.events.length,
                    cause: "injected batch failure",
                  }),
                )
              : actualSink.write(input),
        }),
      );
      assert.equal((yield* Effect.exit(interruptedHydration))._tag, "Failure");
      assert.equal(
        (yield* sql<{ transcript_imported_at: string | null }>`SELECT transcript_imported_at
      FROM orchestration_v2_legacy_imports WHERE thread_id = 'child'`)[0]?.transcript_imported_at,
        null,
      );
      yield* importer.ensureTranscript(ThreadId.make("child"));
      const projection = yield* projections.getThreadProjection(ThreadId.make("child"));
      assert.lengthOf(projection.messages, 82);
      assert.lengthOf(projection.turnItems, 124); // Transcript plus the grandchild's native task item.
      for (let index = 0; index < 123; index++) {
        const item = projection.turnItems.find((entry) => entry.ordinal === index + 1)!;
        assert.equal(item.legacyMessageSource, sources[index % sources.length] ?? undefined);
        assert.equal("text" in item ? item.text : null, `text ${index}`);
        assert.equal(
          "messageId" in item ? item.messageId : item.id.replace("migration:v1:turn-item:", ""),
          `m${String(index).padStart(3, "0")}`,
        );
        if (item.type === "user_message") {
          const source = sources[index % sources.length];
          assert.equal(
            item.createdBy,
            source === "task-result" || source === "system"
              ? "system"
              : source === "provider"
                ? "agent"
                : "user",
          );
        }
      }
      assert.equal(
        projection.turnItems.find((item) => item.ordinal === 123)?.status,
        "interrupted",
      );
      assert.deepEqual(projection.thread.lineage, {
        parentThreadId: ThreadId.make("root"),
        rootThreadId: ThreadId.make("root"),
        relationshipToParent: "subagent",
      });
      assert.equal(projection.thread.creationSource, "mcp");
      assert.deepEqual((yield* projections.getThread(ThreadId.make("grandchild"))).lineage, {
        parentThreadId: ThreadId.make("child"),
        rootThreadId: ThreadId.make("root"),
        relationshipToParent: "subagent",
      });
      const eventCount = (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_events`)[0]?.count;
      yield* importer.reconcileShells;
      yield* importer.ensureTranscript(ThreadId.make("child"));
      assert.deepEqual(yield* repairForkTaskLinks(), { repairedThreadCount: 0 });
      assert.equal(
        (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_events`)[0]
          ?.count,
        eventCount,
      );
      yield* repairForkTaskLinks();
      yield* maintenance.compactEventStore;
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* importer.reconcileShells;
      const replayed = yield* projections.getThreadProjection(ThreadId.make("child"));
      assert.deepEqual(replayed.messages, projection.messages);
      assert.deepEqual(replayed.turnItems, projection.turnItems);
      assert.deepEqual(replayed.thread.lineage, projection.thread.lineage);
      assert.equal(replayed.thread.title, projection.thread.title);
      assert.deepEqual(replayed.subagents, projection.subagents);
      assert.equal(
        (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM projection_thread_messages`)[0]
          ?.count,
        123,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "resumes an interrupted link repair without duplicate events or premature compaction",
  () =>
    Effect.gen(function* () {
      yield* seedThreads([
        ["root", null],
        ["child", "root"],
        ["second", "root"],
      ]);
      yield* (yield* LegacyV1ThreadImporter).reconcileShells;
      const actual = yield* EventSinkV2;
      let attempts = 0;
      const interrupted = repairForkTaskLinks().pipe(
        Effect.provideService(EventSinkV2, {
          ...actual,
          commitCommand: (input) =>
            ++attempts === 2
              ? Effect.fail(
                  new EventSinkWriteError({ eventCount: 1, cause: "injected interruption" }),
                )
              : actual.commitCommand(input),
        }),
      );
      assert.equal((yield* Effect.exit(interrupted))._tag, "Failure");
      const maintenance = yield* ProjectionMaintenanceV2;
      assert.equal((yield* Effect.exit(maintenance.compactEventStore))._tag, "Failure");
      assert.deepEqual(yield* repairForkTaskLinks(), { repairedThreadCount: 1 });
      assert.deepEqual(yield* repairForkTaskLinks(), { repairedThreadCount: 0 });
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_command_receipts
      WHERE command_type = 'fork.legacy-task-links.repair-v2'`)[0]?.count,
        2,
      );
      yield* maintenance.compactEventStore;
    }).pipe(Effect.provide(TestLayer)),
);

for (const [name, parents] of [
  ["missing parent", [["child", "missing"]]],
  [
    "cycle",
    [
      ["child", "other"],
      ["other", "child"],
    ],
  ],
] as const) {
  it.effect(`quarantines ${name} while importing unrelated history`, () =>
    Effect.gen(function* () {
      yield* seedThreads([...parents, ["root", null], ["valid", "root"]]);
      const importer = yield* LegacyV1ThreadImporter;
      yield* importer.reconcileShells;
      yield* repairForkTaskLinks();
      yield* importer.importPendingTranscripts;
      assert.equal(yield* importer.pendingThreadCount, 0);
      const projections = yield* ProjectionStoreV2;
      assert.equal(
        (yield* projections.getThread(ThreadId.make("valid"))).lineage.parentThreadId,
        "root",
      );
      assert.equal(
        (yield* projections.getThread(ThreadId.make("child"))).lineage.parentThreadId,
        null,
      );
      const sql = yield* SqlClient.SqlClient;
      const warnings = yield* sql<{
        entity_id: string;
        reason: string;
      }>`SELECT entity_id, reason FROM fork_v1_import_warnings WHERE field = 'parent_thread_id'`;
      assert.equal(warnings[0]?.entity_id, "child");
      assert.include(warnings[0]?.reason ?? "", name);
      yield* repairForkTaskLinks();
      yield* (yield* ProjectionMaintenanceV2).compactEventStore;
    }).pipe(Effect.provide(TestLayer)),
  );
}

it.effect("keeps valid attachments beside a malformed entry and maps document PDFs to files", () =>
  Effect.gen(function* () {
    yield* seedThreads([["root", null]]);
    const sql = yield* SqlClient.SqlClient;
    const pdf = {
      type: "document",
      id: "pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12,
    };
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at)
      VALUES ('attachment-message', 'root', 'user', 'read these', ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([pdf, { type: "image" }])}, 0, ${stamp}, ${stamp})`;
    const importer = yield* LegacyV1ThreadImporter;
    yield* importer.reconcileShells;
    yield* importer.ensureTranscript(ThreadId.make("root"));
    const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(ThreadId.make("root"));
    assert.deepEqual(projection.messages[0]?.attachments, [{ ...pdf, type: "file" }]);
    const warnings = yield* sql<{
      entity_id: string;
      field: string;
    }>`SELECT entity_id, field FROM fork_v1_import_warnings`;
    assert.deepEqual(warnings, [{ entity_id: "attachment-message", field: "attachments_json[1]" }]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("records missing shells without creating them and permits later hydration", () =>
  Effect.gen(function* () {
    yield* seedThreads([
      ["root", null],
      ["child", "root"],
    ]);
    assert.deepEqual(yield* repairForkTaskLinks(), { repairedThreadCount: 0 });
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
      0,
    );
    const importer = yield* LegacyV1ThreadImporter;
    yield* importer.reconcileShells;
    yield* repairForkTaskLinks();
    yield* importer.ensureTranscript(ThreadId.make("child"));
    assert.equal(yield* importer.pendingThreadCount, 1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("retries a database error and clears a skip warning once the link is repaired", () =>
  Effect.gen(function* () {
    yield* seedThreads([
      ["root", null],
      ["child", "root"],
    ]);
    yield* (yield* LegacyV1ThreadImporter).reconcileShells;
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStoreV2;
    const child = ThreadId.make("child");
    const readingChildFails = (
      error: ProjectionStoreReadError | ProjectionStoreThreadNotFoundError,
    ) =>
      repairForkTaskLinks().pipe(
        Effect.provideService(ProjectionStoreV2, {
          ...projections,
          getThread: (id) => (id === child ? Effect.fail(error) : projections.getThread(id)),
        }),
      );
    const childWarnings = sql`SELECT reason FROM fork_v1_import_warnings
      WHERE entity_id = 'child' AND field = 'parent_thread_id'`;
    // A database error may pass: fail the phase, record nothing, keep compaction closed.
    const busy = yield* Effect.flip(sql`SELECT * FROM missing_table_for_busy_database`);
    const failed = yield* Effect.exit(
      readingChildFails(new ProjectionStoreReadError({ threadId: child, cause: busy })),
    );
    assert.equal(failed._tag, "Failure");
    assert.lengthOf(yield* childWarnings, 0);
    assert.equal((yield* Effect.exit(assertForkTaskLinksRepaired()))._tag, "Failure");
    // A missing shell is a lasting condition: warn, and let compaction account for it.
    yield* readingChildFails(new ProjectionStoreThreadNotFoundError({ threadId: child }));
    assert.lengthOf(yield* childWarnings, 1);
    yield* assertForkTaskLinksRepaired();
    // Once the shell reads, the link is repaired and the warning no longer applies.
    assert.deepEqual(yield* repairForkTaskLinks(), { repairedThreadCount: 1 });
    assert.lengthOf(yield* childWarnings, 0);
    assert.equal((yield* projections.getThread(child)).lineage.parentThreadId, "root");
    yield* assertForkTaskLinksRepaired();
  }).pipe(Effect.provide(TestLayer)),
);
