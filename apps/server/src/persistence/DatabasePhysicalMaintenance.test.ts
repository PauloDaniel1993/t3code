// @effect-diagnostics nodeBuiltinImport:off - Physical SQLite tests exercise real files and sidecars.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import {
  createDatabaseCompactCandidate,
  databasePhysicalMaintenancePaths,
  DatabasePhysicalMaintenanceError,
  installValidatedDatabaseCandidate,
  markDatabaseReplacementReady,
  recoverDatabaseReplacement,
  runPreOpenDatabaseMaintenance,
  scheduleDatabasePhysicalMaintenance,
  validateDatabaseCompactCandidate,
} from "./DatabasePhysicalMaintenance.ts";

const withTempDatabase = (run: (databasePath: string) => void): void => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-db-maintenance-"));
  try {
    run(NodePath.join(directory, "state.sqlite"));
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

const createValidationDatabase = (databasePath: string): void => {
  const source = new NodeSqlite.DatabaseSync(databasePath);
  source.exec(`
    CREATE TABLE effect_sql_migrations (
      migration_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      deleted_at TEXT,
      archived_at TEXT
    );
    CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY);
    CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY,
      checkpoint_turn_count INTEGER
    );
    CREATE TABLE checkpoint_diff_blobs (thread_id TEXT);
    CREATE TABLE orchestration_command_receipts (
      command_id TEXT PRIMARY KEY,
      aggregate_kind TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      result_sequence INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE database_compaction_journal (
      journal_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL
    );
    INSERT INTO effect_sql_migrations VALUES (34, 'DatabaseCompactionJournal', '2026-07-23');
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (
      'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-07-23',
      'command-1', NULL, NULL, 'client', '{}', '{}'
    );
    INSERT INTO projection_state VALUES ('threads', 1, '2026-07-23');
    INSERT INTO projection_threads VALUES ('thread-1', NULL, NULL);
    INSERT INTO orchestration_command_receipts
      VALUES ('command-1', 'thread', 'thread-1', 1, 'accepted');
    INSERT INTO database_compaction_journal
      VALUES ('database-state-compaction-v1', 'awaiting-restart');
  `);
  source.close();
};

describe("pre-open database physical maintenance", () => {
  it("obtains exclusive ownership, checkpoints, and creates a sibling compact candidate", () =>
    withTempDatabase((databasePath) => {
      const source = new NodeSqlite.DatabaseSync(databasePath);
      source.exec("PRAGMA journal_mode = WAL");
      source.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      const insert = source.prepare("INSERT INTO records (value) VALUES (?)");
      for (let index = 0; index < 500; index += 1) {
        insert.run(`value-${index}-${"padding".repeat(100)}`);
      }
      source.close();
      const walPath = `${databasePath}-wal`;

      const result = createDatabaseCompactCandidate({
        databasePath,
        availableDiskBytes: Number.MAX_SAFE_INTEGER,
        safetyMarginBytes: 0,
      });
      const candidate = new NodeSqlite.DatabaseSync(result.paths.candidatePath, { readOnly: true });
      const count = candidate.prepare("SELECT COUNT(*) AS count FROM records").get() as {
        readonly count: number;
      };
      candidate.close();

      expect(result.walCheckpointed).toBe(true);
      expect(NodePath.dirname(result.paths.candidatePath)).toBe(NodePath.dirname(databasePath));
      expect(count.count).toBe(500);
      expect(result.candidateBytes).toBeGreaterThan(0);
      expect(!NodeFS.existsSync(walPath) || NodeFS.statSync(walPath).size === 0).toBe(true);
    }));

  it("refuses before opening SQLite when temporary disk is insufficient", () =>
    withTempDatabase((databasePath) => {
      const source = new NodeSqlite.DatabaseSync(databasePath);
      source.exec("CREATE TABLE records (id INTEGER PRIMARY KEY)");
      source.close();

      expect(() =>
        createDatabaseCompactCandidate({
          databasePath,
          availableDiskBytes: 0,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<DatabasePhysicalMaintenanceError>>({
          code: "insufficient-disk",
          availableBytes: 0,
        }),
      );
    }));

  it("refuses while another connection owns an active write transaction", () =>
    withTempDatabase((databasePath) => {
      const writer = new NodeSqlite.DatabaseSync(databasePath);
      writer.exec(`
        CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        BEGIN IMMEDIATE;
        INSERT INTO records (value) VALUES ('uncommitted');
      `);

      try {
        expect(() =>
          createDatabaseCompactCandidate({
            databasePath,
            availableDiskBytes: Number.MAX_SAFE_INTEGER,
            safetyMarginBytes: 0,
          }),
        ).toThrowError(
          expect.objectContaining<Partial<DatabasePhysicalMaintenanceError>>({
            code: "active-writer",
          }),
        );
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
    }));

  it("rejects corrupt compact candidates without replacing the active database", () =>
    withTempDatabase((databasePath) => {
      createValidationDatabase(databasePath);
      const compact = createDatabaseCompactCandidate({
        databasePath,
        availableDiskBytes: Number.MAX_SAFE_INTEGER,
        safetyMarginBytes: 0,
      });
      const sourceBytes = NodeFS.readFileSync(databasePath);
      NodeFS.writeFileSync(compact.paths.candidatePath, "not-a-sqlite-database", {
        encoding: "utf8",
        flag: "w",
      });

      expect(() =>
        validateDatabaseCompactCandidate({
          databasePath,
          candidatePath: compact.paths.candidatePath,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<DatabasePhysicalMaintenanceError>>({
          code: "candidate-corrupt",
        }),
      );
      expect(NodeFS.readFileSync(databasePath)).toEqual(sourceBytes);
    }));

  it("physically reclaims deleted pages and reports the verified size reduction", () =>
    withTempDatabase((databasePath) => {
      const source = new NodeSqlite.DatabaseSync(databasePath);
      source.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      const insert = source.prepare("INSERT INTO records (value) VALUES (?)");
      for (let index = 0; index < 2_000; index += 1) {
        insert.run(`${index}-${"reclaimable-padding".repeat(200)}`);
      }
      source.exec("DELETE FROM records WHERE id > 50");
      source.close();

      const result = createDatabaseCompactCandidate({
        databasePath,
        availableDiskBytes: Number.MAX_SAFE_INTEGER,
        safetyMarginBytes: 0,
      });
      expect(result.databaseBytes).toBe(NodeFS.statSync(databasePath).size);
      expect(result.candidateBytes).toBe(NodeFS.statSync(result.paths.candidatePath).size);
      expect(result.candidateBytes).toBeLessThan(result.databaseBytes / 2);
    }));

  it("validates SQLite and application invariants before replacement", () =>
    withTempDatabase((databasePath) => {
      createValidationDatabase(databasePath);

      const compact = createDatabaseCompactCandidate({
        databasePath,
        availableDiskBytes: Number.MAX_SAFE_INTEGER,
        safetyMarginBytes: 0,
      });
      const validation = validateDatabaseCompactCandidate({
        databasePath,
        candidatePath: compact.paths.candidatePath,
      });

      expect(validation.integrityCheck).toBe("ok");
      expect(validation.quickCheck).toBe("ok");
      expect(validation.source).toEqual(validation.candidate);

      const modifiedCandidate = new NodeSqlite.DatabaseSync(compact.paths.candidatePath);
      modifiedCandidate.exec(
        "UPDATE database_compaction_journal SET phase = 'failed' WHERE journal_id = 'database-state-compaction-v1'",
      );
      modifiedCandidate.close();
      expect(() =>
        validateDatabaseCompactCandidate({
          databasePath,
          candidatePath: compact.paths.candidatePath,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<DatabasePhysicalMaintenanceError>>({
          code: "invariant-mismatch",
        }),
      );
    }));

  it("atomically installs a validated candidate and retains rollback through readiness", () =>
    withTempDatabase((databasePath) => {
      createValidationDatabase(databasePath);
      createDatabaseCompactCandidate({
        databasePath,
        availableDiskBytes: Number.MAX_SAFE_INTEGER,
        safetyMarginBytes: 0,
      });

      const replacement = installValidatedDatabaseCandidate({ databasePath });
      expect(NodeFS.existsSync(replacement.paths.activePath)).toBe(true);
      expect(NodeFS.existsSync(replacement.paths.rollbackPath)).toBe(true);
      expect(NodeFS.existsSync(replacement.paths.candidatePath)).toBe(false);
      expect(NodeFS.existsSync(replacement.paths.statePath)).toBe(true);
      expect(recoverDatabaseReplacement(databasePath)).toBe("retained-installed-candidate");

      markDatabaseReplacementReady(databasePath);
      expect(NodeFS.existsSync(replacement.paths.statePath)).toBe(false);
      expect(NodeFS.existsSync(replacement.paths.rollbackPath)).toBe(false);
    }));

  it("honors a retained installed candidate when another request marker is present", () =>
    withTempDatabase((databasePath) => {
      createValidationDatabase(databasePath);
      createDatabaseCompactCandidate({
        databasePath,
        availableDiskBytes: Number.MAX_SAFE_INTEGER,
        safetyMarginBytes: 0,
      });
      const replacement = installValidatedDatabaseCandidate({ databasePath });
      scheduleDatabasePhysicalMaintenance(databasePath);

      const resumed = runPreOpenDatabaseMaintenance(databasePath);

      expect(resumed._tag).toBe("installed");
      expect(NodeFS.existsSync(replacement.paths.activePath)).toBe(true);
      expect(NodeFS.existsSync(replacement.paths.rollbackPath)).toBe(true);
      expect(NodeFS.existsSync(replacement.paths.requestPath)).toBe(false);
      expect(NodeFS.existsSync(replacement.paths.resultPath)).toBe(false);
    }));

  it("deterministically restores the original after partial or invalid replacement", () =>
    withTempDatabase((databasePath) => {
      createValidationDatabase(databasePath);
      const compact = createDatabaseCompactCandidate({
        databasePath,
        availableDiskBytes: Number.MAX_SAFE_INTEGER,
        safetyMarginBytes: 0,
      });
      const paths = databasePhysicalMaintenancePaths(databasePath);

      NodeFS.renameSync(paths.activePath, paths.rollbackPath);
      expect(recoverDatabaseReplacement(databasePath)).toBe("restored-original");
      expect(NodeFS.existsSync(paths.activePath)).toBe(true);
      expect(NodeFS.existsSync(paths.rollbackPath)).toBe(false);
      expect(NodeFS.existsSync(compact.paths.candidatePath)).toBe(false);

      createDatabaseCompactCandidate({
        databasePath,
        availableDiskBytes: Number.MAX_SAFE_INTEGER,
        safetyMarginBytes: 0,
      });
      installValidatedDatabaseCandidate({ databasePath });
      const invalid = new NodeSqlite.DatabaseSync(paths.activePath);
      invalid.exec(
        "UPDATE database_compaction_journal SET phase = 'failed' WHERE journal_id = 'database-state-compaction-v1'",
      );
      invalid.close();

      expect(recoverDatabaseReplacement(databasePath)).toBe("rolled-back-invalid-install");
      const restored = new NodeSqlite.DatabaseSync(paths.activePath, { readOnly: true });
      const journal = restored
        .prepare(
          "SELECT phase FROM database_compaction_journal WHERE journal_id = 'database-state-compaction-v1'",
        )
        .get() as { readonly phase: string };
      restored.close();
      expect(journal.phase).toBe("awaiting-restart");
    }));
});
