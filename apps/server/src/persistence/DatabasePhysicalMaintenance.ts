// @effect-diagnostics nodeBuiltinImport:off - This is an offline, synchronous SQLite boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  type MaintenanceJournal,
  archiveMaintenanceJournal,
  incompleteMaintenanceSnapshots,
  maintenanceIncompleteSnapshotPath,
  maintenanceSnapshotPath,
  readMaintenanceJournal,
  syncDirectory,
  syncFile,
  writeMaintenanceJournal,
} from "./DatabaseMaintenanceJournal.ts";
import {
  checkDatabaseIntegrity,
  fingerprintDatabase,
  requireV2Database,
} from "./DatabaseMaintenanceValidation.ts";
import {
  withMaintenanceReadOnlyDatabase,
  withMaintenanceTemporaryDirectory,
} from "./DatabaseMaintenanceSqlite.ts";
import { maintenanceProgress, type MaintenanceProgress } from "./DatabaseMaintenanceProgress.ts";

const SAFETY_MARGIN_BYTES = 64 * 1024 * 1024;
const terminalPhases = new Set<MaintenanceJournal["phase"]>(["completed", "recovered"]);
const timestamp = () => DateTime.formatIso(DateTime.nowUnsafe());
const decodeRuntimeState = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
);

export interface MaintenanceOptions {
  readonly databasePath: string;
  /** Optional persisted runtime state, checked strictly before opening SQLite. */
  readonly serverRuntimeStatePath?: string;
}

/** Progress for CLI callers, plus failure injection/receipts for fixture tests. */
export interface MaintenanceHooks {
  readonly onProgress?: (progress: MaintenanceProgress) => void;
  readonly onPhase?: (journal: MaintenanceJournal, snapshotPath: string) => void;
  readonly availableBytes?: (directory: string) => number;
}

function existingDatabasePath(path: string): string {
  const resolved = NodePath.resolve(path);
  const stat = NodeFS.lstatSync(resolved);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(
      "Maintenance requires a regular database file with no symlink or hardlink aliases.",
    );
  }
  return NodeFS.realpathSync(resolved);
}

function ensureServerStopped(path: string): void {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  // Runtime state is an extra early guard. SQLite's retained exclusive lock is
  // the authority, including when the state file is absent or a server restarts.
  const state = decodeRuntimeState(raw);
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0) {
    throw new Error("Cannot prove the server is stopped: invalid runtime state.");
  }
  try {
    process.kill(state.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw new Error("Cannot prove the server is stopped.", { cause: error });
  }
  throw new Error("Stop the T3 server before database maintenance.");
}

function checkpoint(database: NodeSqlite.DatabaseSync): void {
  const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (result?.busy !== 0 || result.log !== result.checkpointed) {
    throw new Error("The WAL could not be checkpointed completely.");
  }
}

function scalar(database: NodeSqlite.DatabaseSync, pragma: string): number {
  const value = database.prepare(`PRAGMA ${pragma}`).get()?.[pragma];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid SQLite ${pragma}.`);
  }
  return value;
}

function availableDiskBytes(directory: string): number {
  const stat = NodeFS.statfsSync(directory);
  return stat.bavail * stat.bsize;
}

function diskRequirement(database: NodeSqlite.DatabaseSync, path: string, hooks: MaintenanceHooks) {
  const pageSize = scalar(database, "page_size");
  const pageCount = scalar(database, "page_count");
  const databaseBytes = pageCount * pageSize;
  const directory = NodePath.dirname(path);
  return {
    databaseBytes,
    reclaimableBytes: scalar(database, "freelist_count") * pageSize,
    reclaimableBytesBasis:
      "Existing free pages only; no history is deleted. Page packing may change the actual saving.",
    // Snapshot + temporary VACUUM database + journal/WAL, including frame overhead.
    requiredFreeBytes: 3 * databaseBytes + pageCount * 32 + SAFETY_MARGIN_BYTES,
    availableBytes: (hooks.availableBytes ?? availableDiskBytes)(directory),
    snapshotDirectory: directory,
    sqliteTemporaryDirectory: directory,
  };
}

function withExclusiveDatabase<A>(
  options: MaintenanceOptions,
  run: (db: NodeSqlite.DatabaseSync, path: string) => A,
  preflight: (db: NodeSqlite.DatabaseSync, path: string) => void,
  progress: ReturnType<typeof maintenanceProgress>,
): A {
  const path = existingDatabasePath(options.databasePath);
  ensureServerStopped(
    options.serverRuntimeStatePath ?? NodePath.join(NodePath.dirname(path), "server-runtime.json"),
  );
  return withMaintenanceTemporaryDirectory(NodePath.dirname(path), () => {
    progress.run("Read-only preflight", () =>
      withMaintenanceReadOnlyDatabase(path, (database) => {
        requireV2Database(database);
        const mode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
        if (mode !== "wal" && mode !== "delete" && mode !== "truncate" && mode !== "persist") {
          throw new Error("Maintenance requires a durable SQLite journal mode.");
        }
        preflight(database, path);
      }),
    );
    progress.run("Checking source integrity", () =>
      withMaintenanceReadOnlyDatabase(path, checkDatabaseIntegrity),
    );
    const database = new NodeSqlite.DatabaseSync(path, { timeout: 0 });
    try {
      progress.run("Acquiring exclusive lock", () =>
        database.exec(
          "PRAGMA locking_mode = EXCLUSIVE; PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; BEGIN EXCLUSIVE; COMMIT;",
        ),
      );
      // locking_mode=EXCLUSIVE retains the lock after COMMIT, across VACUUM INTO,
      // validation, VACUUM and checkpoints, until this connection is closed.
      // Recheck under the authoritative lock in case the file changed after preflight.
      withMaintenanceReadOnlyDatabase(path, requireV2Database);
      return run(database, path);
    } finally {
      database.close();
    }
  });
}

function validatedFingerprint(database: NodeSqlite.DatabaseSync): string {
  checkDatabaseIntegrity(database);
  return fingerprintDatabase(database);
}

function snapshotFingerprint(snapshot: string): string {
  return withMaintenanceReadOnlyDatabase(snapshot, validatedFingerprint);
}

export function estimateDatabaseMaintenance(databasePath: string) {
  const path = existingDatabasePath(databasePath);
  return withMaintenanceReadOnlyDatabase(path, (database) => {
    requireV2Database(database);
    return {
      databasePath: path,
      ...diskRequirement(database, path, {}),
      incompleteSnapshots: incompleteMaintenanceSnapshots(path, readMaintenanceJournal(path)),
    };
  });
}

export function databaseMaintenanceStatus(databasePath: string) {
  const path = existingDatabasePath(databasePath);
  withMaintenanceReadOnlyDatabase(path, requireV2Database);
  const journal = readMaintenanceJournal(path);
  return {
    ...(journal ?? { phase: "none" }),
    incompleteSnapshots: incompleteMaintenanceSnapshots(path, journal),
  };
}

/**
 * Retain a validated VACUUM INTO recovery snapshot, then reclaim physical space
 * using SQLite's own atomic rewrite. Never rename/unlink the live database, WAL
 * or SHM: on Windows a file swap requires dropping SQLite's lock, allowing a new
 * writer between validation and replacement. VACUUM uses SQLite's journal and
 * survives interruption without a startup hook or a guessed rollback.
 * https://sqlite.org/lang_vacuum.html#how_vacuum_works
 */
export function compactDatabase(options: MaintenanceOptions, hooks: MaintenanceHooks = {}) {
  const progress = maintenanceProgress(
    [
      "Read-only preflight",
      "Checking source integrity",
      "Acquiring exclusive lock",
      "Fingerprinting source",
      "Copying snapshot",
      "Validating snapshot",
      "Rewriting database",
      "Checkpointing WAL",
      "Validating rewritten database",
      "Publishing result",
    ],
    hooks.onProgress,
  );
  const preflight = (database: NodeSqlite.DatabaseSync, path: string) => {
    const previous = readMaintenanceJournal(path);
    if (previous && !terminalPhases.has(previous.phase)) {
      throw new Error(
        `Unfinished maintenance requires \`maintenance recover\` before another compact. Unusable snapshots: ${JSON.stringify(incompleteMaintenanceSnapshots(path, previous))}`,
      );
    }
    const { requiredFreeBytes: requiredBytes, availableBytes: available } = diskRequirement(
      database,
      path,
      hooks,
    );
    if (!Number.isSafeInteger(available) || available < requiredBytes) {
      throw new Error(
        `Insufficient disk space in ${NodePath.dirname(path)} (database, snapshot and SQLite temporary files): need ${requiredBytes} free bytes; available ${available}.`,
      );
    }
  };
  return withExclusiveDatabase(
    options,
    (database, path) => {
      const previous = readMaintenanceJournal(path);
      const beforeBytes = scalar(database, "page_count") * scalar(database, "page_size");
      // Keep previous terminal results alongside their retained recovery snapshots.
      if (previous) {
        archiveMaintenanceJournal(path, previous);
      }
      const now = timestamp();
      let journal: MaintenanceJournal = {
        version: 2,
        runId: NodeCrypto.randomUUID(),
        phase: "copying",
        startedAt: now,
        updatedAt: now,
        beforeBytes,
      };
      const snapshot = maintenanceSnapshotPath(path, journal);
      const incomplete = maintenanceIncompleteSnapshotPath(path, journal);
      const advance = (phase: MaintenanceJournal["phase"]) => {
        journal = { ...journal, phase, updatedAt: timestamp() };
        writeMaintenanceJournal(path, journal);
        hooks.onPhase?.(journal, journal.fingerprint ? snapshot : incomplete);
      };
      try {
        advance("copying");
        const fingerprint = progress.run("Fingerprinting source", () =>
          fingerprintDatabase(database),
        );
        progress.run("Copying snapshot", () => {
          database.prepare("VACUUM INTO ?").run(incomplete);
          syncFile(incomplete);
          syncDirectory(incomplete);
        });
        advance("copied");
        progress.run(
          "Validating snapshot",
          () => {
            if (snapshotFingerprint(incomplete) !== fingerprint) {
              throw new Error("The compact snapshot does not match the complete source database.");
            }
            NodeFS.renameSync(incomplete, snapshot);
            syncDirectory(snapshot);
          },
          progress.validationEstimate(),
        );
        journal = { ...journal, fingerprint };
        advance("validated");
        // No destructive SQL, checkpoint, or physical rewrite happens before the
        // snapshot passes integrity, foreign-key and full-content validation.
        advance("rewriting");
        progress.run("Rewriting database", () => database.exec("VACUUM main"));
        progress.run("Checkpointing WAL", () => checkpoint(database));
        // Durable before checking: even a crash or a failed failure-journal write
        // must require explicit acknowledgement, never silently bless current data.
        advance("checking-result");
        progress.run(
          "Validating rewritten database",
          () => {
            if (snapshotFingerprint(path) !== fingerprint) {
              throw new Error(
                "The rewritten database failed validation; retain the recovery snapshot.",
              );
            }
          },
          progress.validationEstimate(),
        );
        journal = { ...journal, afterBytes: NodeFS.statSync(path).size };
        progress.run("Publishing result", () => advance("completed"));
        return {
          ...journal,
          snapshotPath: snapshot,
          incompleteSnapshots: incompleteMaintenanceSnapshots(path, journal),
        };
      } catch (cause) {
        journal = {
          ...journal,
          failedPhase: journal.phase,
          phase: "failed",
          updatedAt: timestamp(),
          error: String(cause),
        };
        // If the disk is full, the previous durable phase still forces inspection.
        try {
          writeMaintenanceJournal(path, journal);
        } catch {
          // Never hide the original failure or delete a snapshot on this path.
        }
        throw cause;
      }
    },
    preflight,
    progress,
  );
}

/**
 * Read-only eligibility must succeed before SQLite can recover/write the original.
 * A saved snapshot is never installed: the original may contain newer committed work.
 * Ambiguous/corrupt databases or missing validated snapshots fail closed.
 */
export function recoverDatabaseMaintenance(
  options: MaintenanceOptions & { readonly acknowledgeValidationFailure?: boolean },
  hooks: MaintenanceHooks = {},
) {
  const progress = maintenanceProgress(
    [
      "Read-only preflight",
      "Checking source integrity",
      "Acquiring exclusive lock",
      "Fingerprinting source",
      "Checkpointing WAL",
      "Publishing result",
    ],
    hooks.onProgress,
  );
  const requiresAcknowledgement = (journal: MaintenanceJournal) =>
    !journal.validationFailureAcknowledgedAt &&
    (journal.phase === "checking-result" ||
      journal.failedPhase === "checking-result" ||
      // Journals written before failure stages were recorded still fail closed.
      (journal.phase === "failed" &&
        journal.error?.includes("rewritten database failed validation")));
  const report = (path: string, journal: MaintenanceJournal) => ({
    ...journal,
    ...(journal.fingerprint ? { snapshotPath: maintenanceSnapshotPath(path, journal) } : {}),
    incompleteSnapshots: incompleteMaintenanceSnapshots(path, journal),
  });
  return withExclusiveDatabase(
    options,
    (database, path) => {
      const journal = readMaintenanceJournal(path);
      if (!journal)
        return {
          incompleteSnapshots: incompleteMaintenanceSnapshots(path),
          phase: "none" as const,
          recovery: undefined,
        };
      // Older runs (or death between rename and journal publication) may have
      // given an unvalidated file a final name. Keep it visibly unusable even
      // after this journal is archived by a later compaction.
      if (!journal.fingerprint) {
        const legacy = maintenanceSnapshotPath(path, journal);
        if (NodeFS.existsSync(legacy)) {
          const incomplete = maintenanceIncompleteSnapshotPath(path, journal);
          if (NodeFS.existsSync(incomplete)) {
            throw new Error(
              `Both unvalidated snapshots exist; inspect ${legacy} and ${incomplete}.`,
            );
          }
          NodeFS.renameSync(legacy, incomplete);
          syncDirectory(incomplete);
        }
      }
      if (terminalPhases.has(journal.phase)) return report(path, journal);
      const current = progress.run("Fingerprinting source", () => fingerprintDatabase(database));
      let recovery: MaintenanceJournal["recovery"] = "unvalidated";
      if (journal.fingerprint !== undefined) {
        recovery = current === journal.fingerprint ? "unchanged" : "changed";
      }
      progress.run("Checkpointing WAL", () => checkpoint(database));
      const recovered: MaintenanceJournal = {
        ...journal,
        phase: "recovered",
        recovery,
        updatedAt: timestamp(),
        afterBytes: NodeFS.statSync(path).size,
        ...(requiresAcknowledgement(journal)
          ? { validationFailureAcknowledgedAt: timestamp() }
          : {}),
      };
      progress.run("Publishing result", () => writeMaintenanceJournal(path, recovered));
      return report(path, recovered);
    },
    (_database, path) => {
      const journal = readMaintenanceJournal(path);
      if (journal && requiresAcknowledgement(journal) && !options.acknowledgeValidationFailure) {
        throw new Error(
          `Final validation failed or was interrupted. Keep the validated snapshot at ${maintenanceSnapshotPath(path, journal)} and inspect the current data. Another compaction is blocked until you explicitly run maintenance recover --acknowledge-validation-failure --database ${JSON.stringify(path)}. This accepts current data; it does not restore the snapshot.`,
        );
      }
      if (
        journal?.fingerprint &&
        !terminalPhases.has(journal.phase) &&
        snapshotFingerprint(maintenanceSnapshotPath(path, journal)) !== journal.fingerprint
      ) {
        throw new Error(
          "The validated recovery snapshot is missing or changed; manual inspection is required.",
        );
      }
    },
    progress,
  );
}
