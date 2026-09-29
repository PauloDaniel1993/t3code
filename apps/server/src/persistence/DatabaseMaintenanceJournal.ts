// @effect-diagnostics nodeBuiltinImport:off - Offline maintenance owns durable filesystem state.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export const MaintenanceJournal = Schema.Struct({
  version: Schema.Literal(2),
  runId: Schema.String,
  phase: Schema.Literals([
    "copying",
    "copied",
    "validated",
    "rewriting",
    "checking-result",
    "completed",
    "failed",
    "recovered",
  ]),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  beforeBytes: Schema.Number,
  afterBytes: Schema.optional(Schema.Number),
  fingerprint: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  failedPhase: Schema.optional(Schema.String),
  validationFailureAcknowledgedAt: Schema.optional(Schema.String),
  recovery: Schema.optional(Schema.Literals(["unchanged", "changed", "unvalidated"])),
});
export type MaintenanceJournal = typeof MaintenanceJournal.Type;
const decodeJournal = Schema.decodeSync(Schema.fromJsonString(MaintenanceJournal));

export const maintenanceJournalPath = (databasePath: string) =>
  `${databasePath}.maintenance-v2.json`;

export const maintenanceSnapshotPath = (databasePath: string, journal: MaintenanceJournal) => {
  // Never let an edited journal direct recovery outside this database's directory.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(journal.runId)) {
    throw new Error("Invalid database maintenance run ID.");
  }
  return `${databasePath}.maintenance-v2-${journal.runId}.sqlite`;
};

export const maintenanceIncompleteSnapshotPath = (
  databasePath: string,
  journal: MaintenanceJournal,
) => `${maintenanceSnapshotPath(databasePath, journal)}.incomplete`;

/** Include orphaned partial files and old, never-validated snapshots in status reports. */
export function incompleteMaintenanceSnapshots(databasePath: string, journal?: MaintenanceJournal) {
  const directory = NodePath.dirname(databasePath);
  const prefix = `${NodePath.basename(databasePath)}.maintenance-v2-`;
  const paths = NodeFS.readdirSync(directory)
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        /^[0-9a-f-]{36}\.sqlite\.incomplete$/.test(name.slice(prefix.length)),
    )
    .map((name) => NodePath.join(directory, name));
  if (journal && !journal.fingerprint) {
    const legacy = maintenanceSnapshotPath(databasePath, journal);
    if (NodeFS.existsSync(legacy)) paths.push(legacy);
  }
  return paths.map((path) => ({ path, usable: false as const }));
}

export function syncFile(path: string): void {
  const fd = NodeFS.openSync(path, "r+");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

export function syncDirectory(path: string): void {
  // Windows has no directory fsync through Node. Database durability belongs to
  // SQLite; an older journal can only require another inspection, never a restore.
  if (HostProcessPlatform.defaultValue() === "win32") return;
  const fd = NodeFS.openSync(NodePath.dirname(path), "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

export function readMaintenanceJournal(databasePath: string): MaintenanceJournal | undefined {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(maintenanceJournalPath(databasePath), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const journal = decodeJournal(raw);
  maintenanceSnapshotPath(databasePath, journal);
  if (
    (journal.fingerprint !== undefined && !/^[0-9a-f]{64}$/.test(journal.fingerprint)) ||
    (["validated", "rewriting", "checking-result", "completed"].includes(journal.phase) &&
      !journal.fingerprint)
  ) {
    throw new Error("Invalid database maintenance validation record.");
  }
  return journal;
}

function writeJournal(path: string, journal: MaintenanceJournal): void {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const fd = NodeFS.openSync(temporary, "wx", 0o600);
  try {
    NodeFS.writeFileSync(fd, `${JSON.stringify(journal)}\n`);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeFS.renameSync(temporary, path);
  syncDirectory(path);
}

/** Caller holds the database's exclusive SQLite lock for every journal mutation. */
export function writeMaintenanceJournal(databasePath: string, journal: MaintenanceJournal): void {
  writeJournal(maintenanceJournalPath(databasePath), journal);
}

export function archiveMaintenanceJournal(databasePath: string, journal: MaintenanceJournal): void {
  writeJournal(`${maintenanceSnapshotPath(databasePath, journal)}.json`, journal);
}
