// @effect-diagnostics nodeBuiltinImport:off - Pre-open SQLite maintenance is an intentional synchronous Node boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import type { DatabaseMaintenanceFailureCode } from "@t3tools/contracts";

export const DATABASE_MAINTENANCE_CANDIDATE_SUFFIX = ".compact-candidate";
export const DATABASE_MAINTENANCE_ROLLBACK_SUFFIX = ".compact-rollback";
export const DATABASE_MAINTENANCE_STATE_SUFFIX = ".compact-state";
export const DATABASE_MAINTENANCE_REQUEST_SUFFIX = ".compact-requested";
export const DATABASE_MAINTENANCE_RESULT_SUFFIX = ".compact-result";
export const DATABASE_MAINTENANCE_SAFETY_MARGIN_BYTES = 64 * 1024 * 1024;

export interface DatabasePhysicalMaintenancePaths {
  readonly activePath: string;
  readonly candidatePath: string;
  readonly rollbackPath: string;
  readonly statePath: string;
  readonly requestPath: string;
  readonly resultPath: string;
}

export interface CreateDatabaseCompactCandidateOptions {
  readonly databasePath: string;
  readonly availableDiskBytes?: number;
  readonly safetyMarginBytes?: number;
}

export interface DatabaseCompactCandidateResult {
  readonly paths: DatabasePhysicalMaintenancePaths;
  readonly databaseBytes: number;
  readonly candidateBytes: number;
  readonly requiredDiskBytes: number;
  readonly availableDiskBytes: number;
  readonly walCheckpointed: true;
}

export interface DatabaseApplicationInvariants {
  readonly migrationHash: string;
  readonly eventCount: number;
  readonly maxSequence: number;
  readonly streamCount: number;
  readonly streamHeadHash: string;
  readonly projectionWatermarkCount: number;
  readonly projectionWatermarkHash: string;
  readonly lifecycleHash: string;
  readonly threadProjectionHash: string;
  readonly messageEventCount: number;
  readonly messageProjectionCount: number;
  readonly checkpointProjectionCount: number;
  readonly checkpointBlobCount: number;
  readonly commandReceiptCount: number;
  readonly commandReceiptHash: string;
  readonly compactionJournalHash: string;
}

export interface DatabaseCompactCandidateValidation {
  readonly source: DatabaseApplicationInvariants;
  readonly candidate: DatabaseApplicationInvariants;
  readonly integrityCheck: "ok";
  readonly quickCheck: "ok";
  readonly foreignKeyViolationCount: 0;
}

export type DatabaseReplacementRecoveryAction =
  | "none"
  | "discarded-stale-candidate"
  | "restored-original"
  | "retained-installed-candidate"
  | "rolled-back-invalid-install";

export interface DatabaseReplacementResult {
  readonly paths: DatabasePhysicalMaintenancePaths;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly rollbackRetained: true;
}

export interface DatabasePreOpenMaintenanceFailure {
  readonly _tag: "failure";
  readonly code: DatabaseMaintenanceFailureCode;
  readonly requiredBytes: number | undefined;
  readonly availableBytes: number | undefined;
}

export type DatabasePreOpenMaintenanceResult =
  | { readonly _tag: "none"; readonly recovery: DatabaseReplacementRecoveryAction }
  | { readonly _tag: "installed"; readonly replacement: DatabaseReplacementResult }
  | DatabasePreOpenMaintenanceFailure;

export class DatabasePhysicalMaintenanceError extends Error {
  readonly code: DatabaseMaintenanceFailureCode;
  readonly requiredBytes: number | undefined;
  readonly availableBytes: number | undefined;

  constructor(input: {
    readonly code: DatabaseMaintenanceFailureCode;
    readonly message: string;
    readonly requiredBytes?: number;
    readonly availableBytes?: number;
  }) {
    super(input.message);
    this.name = "DatabasePhysicalMaintenanceError";
    this.code = input.code;
    this.requiredBytes = input.requiredBytes;
    this.availableBytes = input.availableBytes;
  }
}

export const databasePhysicalMaintenancePaths = (
  databasePath: string,
): DatabasePhysicalMaintenancePaths => ({
  activePath: databasePath,
  candidatePath: `${databasePath}${DATABASE_MAINTENANCE_CANDIDATE_SUFFIX}`,
  rollbackPath: `${databasePath}${DATABASE_MAINTENANCE_ROLLBACK_SUFFIX}`,
  statePath: `${databasePath}${DATABASE_MAINTENANCE_STATE_SUFFIX}`,
  requestPath: `${databasePath}${DATABASE_MAINTENANCE_REQUEST_SUFFIX}`,
  resultPath: `${databasePath}${DATABASE_MAINTENANCE_RESULT_SUFFIX}`,
});

const numericFileSystemValue = (value: number | bigint): number =>
  typeof value === "bigint" ? Number(value) : value;

export const availableDiskBytesForPath = (databasePath: string): number => {
  const stats = NodeFS.statfsSync(NodePath.dirname(databasePath));
  return numericFileSystemValue(stats.bavail) * numericFileSystemValue(stats.bsize);
};

const fsyncFile = (path: string): void => {
  const descriptor = NodeFS.openSync(path, "r+");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
};

const fsyncParentDirectory = (path: string): void => {
  // Windows does not expose directory handles with fsync semantics. On
  // platforms that do, persist rename/unlink directory entries as well as
  // the file contents.
  if (NodePath.sep === "\\") {
    return;
  }
  const descriptor = NodeFS.openSync(NodePath.dirname(path), "r");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
};

type DatabaseReplacementPhase = "validated" | "original-moved" | "candidate-installed";

const readReplacementPhase = (path: string): DatabaseReplacementPhase | undefined => {
  if (!NodeFS.existsSync(path)) {
    return undefined;
  }
  const phase = NodeFS.readFileSync(path, "utf8").trim();
  return phase === "validated" || phase === "original-moved" || phase === "candidate-installed"
    ? phase
    : undefined;
};

const writeReplacementPhase = (path: string, phase: DatabaseReplacementPhase): void => {
  NodeFS.writeFileSync(path, `${phase}\n`, { encoding: "utf8", flag: "w" });
  fsyncFile(path);
  fsyncParentDirectory(path);
};

const removeIfPresent = (path: string): void => {
  if (NodeFS.existsSync(path)) {
    NodeFS.unlinkSync(path);
    fsyncParentDirectory(path);
  }
};

const maintenanceFailureCodes = new Set<DatabaseMaintenanceFailureCode>([
  "active-work",
  "active-writer",
  "insufficient-disk",
  "checkpoint-failed",
  "candidate-create-failed",
  "candidate-corrupt",
  "invariant-mismatch",
  "swap-failed",
  "rollback-failed",
  "startup-validation-failed",
  "unknown",
]);

const writePreOpenFailure = (path: string, failure: DatabasePreOpenMaintenanceFailure): void => {
  NodeFS.writeFileSync(
    path,
    [
      failure.code,
      failure.requiredBytes === undefined ? "" : String(failure.requiredBytes),
      failure.availableBytes === undefined ? "" : String(failure.availableBytes),
    ].join("\t"),
    { encoding: "utf8", flag: "w" },
  );
  fsyncFile(path);
  fsyncParentDirectory(path);
};

export const readDatabasePreOpenMaintenanceFailure = (
  databasePath: string,
): DatabasePreOpenMaintenanceFailure | undefined => {
  const { resultPath } = databasePhysicalMaintenancePaths(databasePath);
  if (!NodeFS.existsSync(resultPath)) {
    return undefined;
  }
  const [rawCode, rawRequired, rawAvailable] = NodeFS.readFileSync(resultPath, "utf8").split("\t");
  const code =
    rawCode !== undefined && maintenanceFailureCodes.has(rawCode as DatabaseMaintenanceFailureCode)
      ? (rawCode as DatabaseMaintenanceFailureCode)
      : "unknown";
  const requiredBytes =
    rawRequired !== undefined && rawRequired.trim().length > 0
      ? Number.parseInt(rawRequired, 10)
      : undefined;
  const availableBytes =
    rawAvailable !== undefined && rawAvailable.trim().length > 0
      ? Number.parseInt(rawAvailable, 10)
      : undefined;
  return {
    _tag: "failure",
    code,
    requiredBytes:
      requiredBytes !== undefined && Number.isFinite(requiredBytes) ? requiredBytes : undefined,
    availableBytes:
      availableBytes !== undefined && Number.isFinite(availableBytes) ? availableBytes : undefined,
  };
};

export const clearDatabasePreOpenMaintenanceFailure = (databasePath: string): void => {
  removeIfPresent(databasePhysicalMaintenancePaths(databasePath).resultPath);
};

export const scheduleDatabasePhysicalMaintenance = (databasePath: string): void => {
  const { requestPath } = databasePhysicalMaintenancePaths(databasePath);
  NodeFS.writeFileSync(requestPath, "authorized\n", { encoding: "utf8", flag: "w" });
  fsyncFile(requestPath);
  fsyncParentDirectory(requestPath);
};

const sqliteErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const isBusySqliteError = (cause: unknown): boolean => {
  const code = sqliteErrorCode(cause);
  return code === "ERR_SQLITE_ERROR" && String(cause).includes("database is locked");
};

const encodeHashValue = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `s${Buffer.byteLength(value, "utf8")}:${value}`;
  }
  if (typeof value === "number") {
    return `n:${String(value)}`;
  }
  if (typeof value === "bigint") {
    return `b:${String(value)}`;
  }
  if (value instanceof Uint8Array) {
    return `x:${NodeCrypto.createHash("sha256").update(value).digest("hex")}`;
  }
  return `u:${String(value)}`;
};

const hashQuery = (database: NodeSqlite.DatabaseSync, query: string): string => {
  const hash = NodeCrypto.createHash("sha256");
  for (const row of database.prepare(query).iterate() as Iterable<Record<string, unknown>>) {
    for (const key of Object.keys(row).toSorted()) {
      hash.update(`${encodeHashValue(key)}=${encodeHashValue(row[key])};`);
    }
    hash.update("\n");
  }
  return hash.digest("hex");
};

const scalarNumber = (database: NodeSqlite.DatabaseSync, query: string, key: string): number => {
  const row = database.prepare(query).get() as Record<string, unknown> | undefined;
  const value = row?.[key];
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
};

const readDatabaseApplicationInvariants = (
  database: NodeSqlite.DatabaseSync,
): DatabaseApplicationInvariants => {
  const maxSequence = scalarNumber(
    database,
    "SELECT COALESCE(MAX(sequence), 0) AS value FROM orchestration_events",
    "value",
  );
  const invalidStreamCount = scalarNumber(
    database,
    `
      SELECT COUNT(*) AS value
      FROM (
        SELECT aggregate_kind, stream_id
        FROM orchestration_events
        GROUP BY aggregate_kind, stream_id
        HAVING MIN(stream_version) <> 0 OR COUNT(*) <> MAX(stream_version) + 1
      )
    `,
    "value",
  );
  const invalidProjectionWatermarkCount = scalarNumber(
    database,
    `SELECT COUNT(*) AS value FROM projection_state WHERE last_applied_sequence > ${maxSequence}`,
    "value",
  );
  const invalidReceiptCount = scalarNumber(
    database,
    `SELECT COUNT(*) AS value FROM orchestration_command_receipts WHERE result_sequence > ${maxSequence}`,
    "value",
  );
  if (invalidStreamCount > 0 || invalidProjectionWatermarkCount > 0 || invalidReceiptCount > 0) {
    throw new DatabasePhysicalMaintenanceError({
      code: "invariant-mismatch",
      message: "The database violates event or projection sequence invariants.",
    });
  }

  return {
    migrationHash: hashQuery(database, "SELECT * FROM effect_sql_migrations ORDER BY 1, 2"),
    eventCount: scalarNumber(
      database,
      "SELECT COUNT(*) AS value FROM orchestration_events",
      "value",
    ),
    maxSequence,
    streamCount: scalarNumber(
      database,
      `
        SELECT COUNT(*) AS value
        FROM (
          SELECT aggregate_kind, stream_id
          FROM orchestration_events
          GROUP BY aggregate_kind, stream_id
        )
      `,
      "value",
    ),
    streamHeadHash: hashQuery(
      database,
      `
        SELECT
          aggregate_kind,
          stream_id,
          MAX(stream_version) AS head_version,
          MAX(sequence) AS head_sequence,
          COUNT(*) AS event_count
        FROM orchestration_events
        GROUP BY aggregate_kind, stream_id
        ORDER BY aggregate_kind, stream_id
      `,
    ),
    projectionWatermarkCount: scalarNumber(
      database,
      "SELECT COUNT(*) AS value FROM projection_state",
      "value",
    ),
    projectionWatermarkHash: hashQuery(
      database,
      `
        SELECT projector, last_applied_sequence
        FROM projection_state
        ORDER BY projector
      `,
    ),
    lifecycleHash: hashQuery(
      database,
      `
        SELECT event_type, COUNT(*) AS event_count
        FROM orchestration_events
        WHERE event_type IN (
          'project.created',
          'project.deleted',
          'thread.created',
          'thread.deleted',
          'thread.archived',
          'thread.unarchived',
          'thread.turn-start-requested',
          'thread.turn-interrupt-requested',
          'thread.session-stop-requested',
          'thread.session-set',
          'thread.reverted'
        )
        GROUP BY event_type
        ORDER BY event_type
      `,
    ),
    threadProjectionHash: hashQuery(
      database,
      `
        SELECT
          COUNT(*) AS thread_count,
          SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active_count,
          SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_count
        FROM projection_threads
      `,
    ),
    messageEventCount: scalarNumber(
      database,
      `
        SELECT COUNT(*) AS value
        FROM orchestration_events
        WHERE event_type = 'thread.message-sent'
      `,
      "value",
    ),
    messageProjectionCount: scalarNumber(
      database,
      "SELECT COUNT(*) AS value FROM projection_thread_messages",
      "value",
    ),
    checkpointProjectionCount: scalarNumber(
      database,
      `
        SELECT COUNT(*) AS value
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
      `,
      "value",
    ),
    checkpointBlobCount: scalarNumber(
      database,
      "SELECT COUNT(*) AS value FROM checkpoint_diff_blobs",
      "value",
    ),
    commandReceiptCount: scalarNumber(
      database,
      "SELECT COUNT(*) AS value FROM orchestration_command_receipts",
      "value",
    ),
    commandReceiptHash: hashQuery(
      database,
      `
        SELECT command_id, aggregate_kind, aggregate_id, result_sequence, status
        FROM orchestration_command_receipts
        ORDER BY command_id
      `,
    ),
    compactionJournalHash: hashQuery(
      database,
      "SELECT * FROM database_compaction_journal ORDER BY journal_id",
    ),
  };
};

const checkResult = (database: NodeSqlite.DatabaseSync, pragma: string, key: string): string => {
  const rows = database.prepare(pragma).all() as ReadonlyArray<Record<string, unknown>>;
  return rows.length === 1 && rows[0]?.[key] === "ok" ? "ok" : "failed";
};

const openReadOnlyDatabase = (path: string): NodeSqlite.DatabaseSync => {
  try {
    return new NodeSqlite.DatabaseSync(path, { readOnly: true });
  } catch {
    throw new DatabasePhysicalMaintenanceError({
      code: "candidate-corrupt",
      message: "The compact database candidate could not be opened for validation.",
    });
  }
};

export const validateDatabaseCompactCandidate = (options: {
  readonly databasePath: string;
  readonly candidatePath?: string;
}): DatabaseCompactCandidateValidation => {
  const candidatePath =
    options.candidatePath ?? databasePhysicalMaintenancePaths(options.databasePath).candidatePath;
  const source = openReadOnlyDatabase(options.databasePath);
  let candidate: NodeSqlite.DatabaseSync | undefined;
  try {
    candidate = openReadOnlyDatabase(candidatePath);
    const quickCheck = checkResult(candidate, "PRAGMA quick_check", "quick_check");
    const integrityCheck = checkResult(candidate, "PRAGMA integrity_check", "integrity_check");
    const foreignKeyViolationCount = candidate.prepare("PRAGMA foreign_key_check").all().length;
    if (quickCheck !== "ok" || integrityCheck !== "ok" || foreignKeyViolationCount > 0) {
      throw new DatabasePhysicalMaintenanceError({
        code: "candidate-corrupt",
        message: "The compact database candidate failed SQLite integrity validation.",
      });
    }

    const sourceInvariants = readDatabaseApplicationInvariants(source);
    const candidateInvariants = readDatabaseApplicationInvariants(candidate);
    for (const key of Object.keys(sourceInvariants) as Array<keyof DatabaseApplicationInvariants>) {
      if (sourceInvariants[key] !== candidateInvariants[key]) {
        throw new DatabasePhysicalMaintenanceError({
          code: "invariant-mismatch",
          message: "The compact database candidate does not match required application invariants.",
        });
      }
    }

    return {
      source: sourceInvariants,
      candidate: candidateInvariants,
      integrityCheck: "ok",
      quickCheck: "ok",
      foreignKeyViolationCount: 0,
    };
  } catch (cause) {
    if (cause instanceof DatabasePhysicalMaintenanceError) {
      throw cause;
    }
    throw new DatabasePhysicalMaintenanceError({
      code: "candidate-corrupt",
      message: "The compact database candidate could not be read during validation.",
    });
  } finally {
    candidate?.close();
    source.close();
  }
};

const restoreRollbackAsActive = (
  paths: DatabasePhysicalMaintenancePaths,
  preserveInvalidActive: boolean,
): void => {
  if (!NodeFS.existsSync(paths.rollbackPath)) {
    throw new DatabasePhysicalMaintenanceError({
      code: "rollback-failed",
      message: "The original database rollback copy is unavailable.",
    });
  }
  if (NodeFS.existsSync(paths.activePath)) {
    if (preserveInvalidActive) {
      removeIfPresent(paths.candidatePath);
      NodeFS.renameSync(paths.activePath, paths.candidatePath);
      fsyncParentDirectory(paths.activePath);
    } else {
      removeIfPresent(paths.activePath);
    }
  }
  NodeFS.renameSync(paths.rollbackPath, paths.activePath);
  fsyncFile(paths.activePath);
  fsyncParentDirectory(paths.activePath);
  removeIfPresent(paths.statePath);
};

export const installValidatedDatabaseCandidate = (options: {
  readonly databasePath: string;
}): DatabaseReplacementResult => {
  const paths = databasePhysicalMaintenancePaths(options.databasePath);
  validateDatabaseCompactCandidate({
    databasePath: paths.activePath,
    candidatePath: paths.candidatePath,
  });
  if (NodeFS.existsSync(paths.rollbackPath)) {
    throw new DatabasePhysicalMaintenanceError({
      code: "swap-failed",
      message: "A retained rollback copy must be resolved before another replacement.",
    });
  }

  const beforeBytes = NodeFS.statSync(paths.activePath).size;
  const afterBytes = NodeFS.statSync(paths.candidatePath).size;
  let originalMoved = false;
  let candidateInstalled = false;
  try {
    writeReplacementPhase(paths.statePath, "validated");
    NodeFS.renameSync(paths.activePath, paths.rollbackPath);
    fsyncParentDirectory(paths.activePath);
    originalMoved = true;
    writeReplacementPhase(paths.statePath, "original-moved");
    NodeFS.renameSync(paths.candidatePath, paths.activePath);
    candidateInstalled = true;
    fsyncFile(paths.activePath);
    fsyncParentDirectory(paths.activePath);
    writeReplacementPhase(paths.statePath, "candidate-installed");
    return {
      paths,
      beforeBytes,
      afterBytes,
      rollbackRetained: true,
    };
  } catch {
    try {
      if (originalMoved) {
        if (candidateInstalled && NodeFS.existsSync(paths.activePath)) {
          removeIfPresent(paths.candidatePath);
          NodeFS.renameSync(paths.activePath, paths.candidatePath);
          fsyncParentDirectory(paths.activePath);
        }
        if (!NodeFS.existsSync(paths.activePath) && NodeFS.existsSync(paths.rollbackPath)) {
          NodeFS.renameSync(paths.rollbackPath, paths.activePath);
          fsyncFile(paths.activePath);
          fsyncParentDirectory(paths.activePath);
        }
      }
      removeIfPresent(paths.statePath);
    } catch {
      throw new DatabasePhysicalMaintenanceError({
        code: "rollback-failed",
        message: "The original database could not be restored after a replacement failure.",
      });
    }
    throw new DatabasePhysicalMaintenanceError({
      code: "swap-failed",
      message: "The compact database candidate could not be installed.",
    });
  }
};

export const recoverDatabaseReplacement = (
  databasePath: string,
): DatabaseReplacementRecoveryAction => {
  const paths = databasePhysicalMaintenancePaths(databasePath);
  const phase = readReplacementPhase(paths.statePath);
  const activeExists = NodeFS.existsSync(paths.activePath);
  const candidateExists = NodeFS.existsSync(paths.candidatePath);
  const rollbackExists = NodeFS.existsSync(paths.rollbackPath);

  if (!activeExists && rollbackExists) {
    restoreRollbackAsActive(paths, false);
    removeIfPresent(paths.candidatePath);
    return "restored-original";
  }
  if (!activeExists) {
    return "none";
  }

  if (rollbackExists) {
    if (phase === "candidate-installed") {
      try {
        validateDatabaseCompactCandidate({
          databasePath: paths.rollbackPath,
          candidatePath: paths.activePath,
        });
        removeIfPresent(paths.candidatePath);
        return "retained-installed-candidate";
      } catch {
        restoreRollbackAsActive(paths, true);
        return "rolled-back-invalid-install";
      }
    }
    restoreRollbackAsActive(paths, true);
    return "restored-original";
  }

  if (candidateExists) {
    removeIfPresent(paths.candidatePath);
    removeIfPresent(paths.statePath);
    return "discarded-stale-candidate";
  }
  removeIfPresent(paths.statePath);
  return "none";
};

export const markDatabaseReplacementReady = (databasePath: string): void => {
  const paths = databasePhysicalMaintenancePaths(databasePath);
  if (
    readReplacementPhase(paths.statePath) === "candidate-installed" &&
    NodeFS.existsSync(paths.activePath) &&
    NodeFS.existsSync(paths.rollbackPath)
  ) {
    removeIfPresent(paths.rollbackPath);
    removeIfPresent(paths.statePath);
  }
};

export const databaseReplacementPendingReadiness = (
  databasePath: string,
):
  | {
      readonly beforeBytes: number;
      readonly afterBytes: number;
      readonly rollbackRetained: true;
    }
  | undefined => {
  const paths = databasePhysicalMaintenancePaths(databasePath);
  if (
    readReplacementPhase(paths.statePath) !== "candidate-installed" ||
    !NodeFS.existsSync(paths.activePath) ||
    !NodeFS.existsSync(paths.rollbackPath)
  ) {
    return undefined;
  }
  return {
    beforeBytes: NodeFS.statSync(paths.rollbackPath).size,
    afterBytes: NodeFS.statSync(paths.activePath).size,
    rollbackRetained: true,
  };
};

export const runPreOpenDatabaseMaintenance = (
  databasePath: string,
): DatabasePreOpenMaintenanceResult => {
  const paths = databasePhysicalMaintenancePaths(databasePath);
  const recovery = recoverDatabaseReplacement(databasePath);
  if (!NodeFS.existsSync(paths.requestPath)) {
    return { _tag: "none", recovery };
  }

  try {
    if (recovery === "retained-installed-candidate") {
      const pending = databaseReplacementPendingReadiness(databasePath);
      if (pending !== undefined) {
        clearDatabasePreOpenMaintenanceFailure(databasePath);
        removeIfPresent(paths.requestPath);
        return {
          _tag: "installed",
          replacement: {
            paths,
            beforeBytes: pending.beforeBytes,
            afterBytes: pending.afterBytes,
            rollbackRetained: true,
          },
        };
      }
    }
    if (NodeFS.existsSync(paths.rollbackPath) && !NodeFS.existsSync(paths.statePath)) {
      removeIfPresent(paths.rollbackPath);
    }
    clearDatabasePreOpenMaintenanceFailure(databasePath);
    createDatabaseCompactCandidate({ databasePath });
    const replacement = installValidatedDatabaseCandidate({ databasePath });
    removeIfPresent(paths.requestPath);
    return { _tag: "installed", replacement };
  } catch (cause) {
    const error =
      cause instanceof DatabasePhysicalMaintenanceError
        ? cause
        : new DatabasePhysicalMaintenanceError({
            code: "unknown",
            message: "Database maintenance failed before server startup.",
          });
    recoverDatabaseReplacement(databasePath);
    removeIfPresent(paths.requestPath);
    const failure = {
      _tag: "failure",
      code: error.code,
      requiredBytes: error.requiredBytes,
      availableBytes: error.availableBytes,
    } satisfies DatabasePreOpenMaintenanceFailure;
    writePreOpenFailure(paths.resultPath, failure);
    return failure;
  }
};

export const createDatabaseCompactCandidate = (
  options: CreateDatabaseCompactCandidateOptions,
): DatabaseCompactCandidateResult => {
  const paths = databasePhysicalMaintenancePaths(options.databasePath);
  if (!NodeFS.existsSync(paths.activePath)) {
    throw new DatabasePhysicalMaintenanceError({
      code: "candidate-create-failed",
      message: "The active database does not exist.",
    });
  }
  if (NodeFS.existsSync(paths.candidatePath)) {
    throw new DatabasePhysicalMaintenanceError({
      code: "candidate-create-failed",
      message: "A previous compact candidate requires recovery before maintenance can continue.",
    });
  }

  const databaseBytes = NodeFS.statSync(paths.activePath).size;
  const requiredDiskBytes =
    databaseBytes + (options.safetyMarginBytes ?? DATABASE_MAINTENANCE_SAFETY_MARGIN_BYTES);
  const availableDiskBytes =
    options.availableDiskBytes ?? availableDiskBytesForPath(paths.activePath);
  if (availableDiskBytes < requiredDiskBytes) {
    throw new DatabasePhysicalMaintenanceError({
      code: "insufficient-disk",
      message: "Not enough temporary disk space to create a compact database copy.",
      requiredBytes: requiredDiskBytes,
      availableBytes: availableDiskBytes,
    });
  }

  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(paths.activePath, { timeout: 0 });
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("PRAGMA locking_mode = EXCLUSIVE");
    database.exec("BEGIN EXCLUSIVE");
    database.exec("COMMIT");

    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { readonly busy?: number; readonly checkpointed?: number; readonly log?: number }
      | undefined;
    if (checkpoint?.busy !== undefined && checkpoint.busy !== 0) {
      throw new DatabasePhysicalMaintenanceError({
        code: "checkpoint-failed",
        message: "The database WAL could not be checkpointed exclusively.",
      });
    }

    database.prepare("VACUUM INTO ?").run(paths.candidatePath);
    database.close();
    database = undefined;
    fsyncFile(paths.candidatePath);
    const candidateBytes = NodeFS.statSync(paths.candidatePath).size;
    return {
      paths,
      databaseBytes,
      candidateBytes,
      requiredDiskBytes,
      availableDiskBytes,
      walCheckpointed: true,
    };
  } catch (cause) {
    removeIfPresent(paths.candidatePath);
    if (cause instanceof DatabasePhysicalMaintenanceError) {
      throw cause;
    }
    if (isBusySqliteError(cause)) {
      throw new DatabasePhysicalMaintenanceError({
        code: "active-writer",
        message: "The database is still owned by an active writer.",
      });
    }
    throw new DatabasePhysicalMaintenanceError({
      code: "candidate-create-failed",
      message: "The compact database candidate could not be created.",
    });
  } finally {
    database?.close();
  }
};
