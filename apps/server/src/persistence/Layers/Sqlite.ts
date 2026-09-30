import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
// fork(ticket-28:ledger): the fork's own migration ledger and V1 preparation.
import { reconcileBaseMigrationLedger, runForkMigrations } from "../ForkMigrations.ts";
import TaskDeliveryIndex from "../ForkMigrations/011_TaskDeliveryIndex.ts";
import { initializeV2Database } from "../initializeV2Database.ts";
import { initializeIsolatedAttachments } from "../../attachmentIsolation.ts";
import { ServerConfig } from "../../config.ts";
import { initializeAttachmentReferenceIndex } from "../../orchestration-v2/AttachmentReferenceIndex.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    // fork(ticket-28:ledger): clear old fork ledger rows and bad project JSON before upstream's migrations.
    yield* reconcileBaseMigrationLedger();
    yield* runMigrations();
    // fork(ticket-28:ledger): fork migrations run after upstream's, in their own ledger.
    yield* runForkMigrations();
    // Ticket 32: restore the task delivery index after any upstream table rebuild.
    yield* TaskDeliveryIndex;
    // Ticket 36: the index is verified on every start, after the fork migrations.
    yield* initializeAttachmentReferenceIndex();
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    NodeSqliteClient.layer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    yield* initializeV2Database(config.dbPath);
    yield* initializeIsolatedAttachments(config);
    return makeSqlitePersistenceLive(config.dbPath);
  }),
);
