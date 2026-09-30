// @effect-diagnostics nodeBuiltinImport:off - Integration tests only open databases they create.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { createMaintenanceFixture } from "./DatabaseMaintenanceFixture.test-support.ts";
import {
  maintenanceJournalPath,
  maintenanceIncompleteSnapshotPath,
  maintenanceSnapshotPath,
  readMaintenanceJournal,
} from "./DatabaseMaintenanceJournal.ts";
import { checkDatabaseIntegrity, fingerprintDatabase } from "./DatabaseMaintenanceValidation.ts";
import {
  compactDatabase,
  databaseMaintenanceStatus,
  estimateDatabaseMaintenance,
  recoverDatabaseMaintenance,
} from "./DatabasePhysicalMaintenance.ts";

let databasePath: string;
let directory: string;
beforeEach(async () => {
  ({ databasePath, directory } = await createMaintenanceFixture());
});
afterEach(() => {
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

function readFingerprint(path = databasePath) {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    checkDatabaseIntegrity(database);
    return fingerprintDatabase(database);
  } finally {
    database.close();
  }
}

function leaveInterrupted(phase: "copying" | "copied" | "validated" | "rewriting" = "validated") {
  expect(() =>
    compactDatabase(
      { databasePath },
      {
        onPhase: (journal) => {
          if (journal.phase === phase) throw new Error("simulated failure");
        },
      },
    ),
  ).toThrow("simulated failure");
}

describe("physical maintenance", () => {
  it("shrinks the migrated V2 database, retains a validated snapshot and preserves all rows and schema", () => {
    const before = readFingerprint();
    const estimate = estimateDatabaseMaintenance(databasePath);
    expect(estimate.reclaimableBytes).toBeGreaterThan(3 * 1024 * 1024);
    const result = compactDatabase({ databasePath });
    expect(result.phase).toBe("completed");
    expect(result.afterBytes).toBeLessThan(estimate.databaseBytes);
    expect(readFingerprint()).toBe(before);
    expect(readFingerprint(result.snapshotPath)).toBe(before);
    expect(readMaintenanceJournal(databasePath)?.phase).toBe("completed");
    const db = new NodeSqlite.DatabaseSync(databasePath);
    try {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(db.prepare("SELECT * FROM database_compaction_journal").get()?.phase).toBe(
        "original-moved",
      );
      expect(db.prepare("SELECT count(*) AS count FROM effect_sql_migrations").get()?.count).toBe(
        56,
      );
    } finally {
      db.close();
    }
  });

  it("retains previous snapshots and archives their terminal journals on repeated runs", () => {
    const first = compactDatabase({ databasePath });
    const second = compactDatabase({ databasePath });
    expect(second.snapshotPath).not.toBe(first.snapshotPath);
    expect(readFingerprint(first.snapshotPath)).toBe(readFingerprint(second.snapshotPath));
    expect(JSON.parse(NodeFS.readFileSync(`${first.snapshotPath}.json`, "utf8")).runId).toBe(
      first.runId,
    );
  });

  it("reports each phase before work, elapsed times and measured validation estimates", () => {
    const events: import("./DatabaseMaintenanceProgress.ts").MaintenanceProgress[] = [];
    compactDatabase(
      { databasePath },
      {
        onProgress: (event) => {
          events.push(event);
          if (event.phase === "Copying snapshot" && event.state === "started") {
            expect(NodeFS.readdirSync(directory).some((file) => file.endsWith(".incomplete"))).toBe(
              false,
            );
          }
        },
      },
    );
    expect(events.filter((event) => event.state === "started").map((event) => event.phase)).toEqual(
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
    );
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]?.state).toBe("started");
      expect(events[index + 1]?.state).toBe("completed");
      expect(events[index + 1]?.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(
      events.find((event) => event.phase === "Validating rewritten database")?.estimatedMs,
    ).toBeGreaterThan(0);
  });

  it("keeps partial snapshots visibly incomplete, reports them on recovery and never offers them as backups", () => {
    const original = readFingerprint();
    expect(() =>
      compactDatabase(
        { databasePath },
        {
          onPhase: (journal, candidate) => {
            if (journal.phase !== "copying") return;
            expect(candidate.endsWith(".incomplete")).toBe(true);
            NodeFS.writeFileSync(candidate, "injected partial snapshot");
            throw new Error("injected copy failure");
          },
        },
      ),
    ).toThrow("injected copy failure");
    const journal = readMaintenanceJournal(databasePath)!;
    const incomplete = maintenanceIncompleteSnapshotPath(databasePath, journal);
    expect(NodeFS.existsSync(maintenanceSnapshotPath(databasePath, journal))).toBe(false);
    expect(databaseMaintenanceStatus(databasePath).incompleteSnapshots).toEqual([
      { path: incomplete, usable: false },
    ]);
    expect(estimateDatabaseMaintenance(databasePath).incompleteSnapshots).toEqual([
      { path: incomplete, usable: false },
    ]);
    // Also recover the old naming scheme / the rename-before-journal crash gap.
    const unvalidatedFinal = maintenanceSnapshotPath(databasePath, journal);
    NodeFS.renameSync(incomplete, unvalidatedFinal);
    expect(databaseMaintenanceStatus(databasePath).incompleteSnapshots).toEqual([
      { path: unvalidatedFinal, usable: false },
    ]);
    const recovered = recoverDatabaseMaintenance({ databasePath });
    expect(recovered).not.toHaveProperty("snapshotPath");
    expect(recovered.incompleteSnapshots).toEqual([{ path: incomplete, usable: false }]);
    expect(readFingerprint()).toBe(original);
    const completed = compactDatabase({ databasePath });
    expect(completed.incompleteSnapshots).toEqual([{ path: incomplete, usable: false }]);
    expect(NodeFS.existsSync(completed.snapshotPath)).toBe(true);
    expect(NodeFS.existsSync(`${completed.snapshotPath}.incomplete`)).toBe(false);
  });

  it("rereads the rewritten file on a fresh connection and gates a failed final check behind acknowledgement", () => {
    const marker = "unique-final-validation-marker-37";
    const db = new NodeSqlite.DatabaseSync(databasePath);
    db.prepare("UPDATE future_fork_table SET value=?").run(marker);
    db.close();
    const before = readFingerprint();
    expect(() =>
      compactDatabase(
        { databasePath },
        {
          onPhase: (journal) => {
            if (journal.phase !== "checking-result") return;
            // Change a stored value directly on disk while the writer still holds
            // its cached pages and exclusive lock. A same-connection scan misses it.
            const bytes = NodeFS.readFileSync(databasePath);
            const offset = bytes.indexOf(marker);
            expect(offset).toBeGreaterThan(0);
            const fd = NodeFS.openSync(databasePath, "r+");
            try {
              NodeFS.writeSync(fd, Buffer.from("X"), 0, 1, offset);
              NodeFS.fsyncSync(fd);
            } finally {
              NodeFS.closeSync(fd);
            }
          },
        },
      ),
    ).toThrow("rewritten database failed validation");
    const journal = readMaintenanceJournal(databasePath)!;
    expect(journal.failedPhase).toBe("checking-result");
    expect(readFingerprint(maintenanceSnapshotPath(databasePath, journal))).toBe(before);
    const laterWriter = new NodeSqlite.DatabaseSync(databasePath);
    laterWriter.exec(
      "INSERT INTO future_fork_table(id,value) VALUES(2,'committed after failed validation')",
    );
    laterWriter.close();
    const changed = readFingerprint();
    expect(changed).not.toBe(before);
    expect(() => recoverDatabaseMaintenance({ databasePath })).toThrow(
      "acknowledge-validation-failure",
    );
    expect(readMaintenanceJournal(databasePath)?.phase).toBe("failed");
    expect(() => compactDatabase({ databasePath })).toThrow("recover");
    expect(
      recoverDatabaseMaintenance({ databasePath, acknowledgeValidationFailure: true }).phase,
    ).toBe("recovered");
    expect(readMaintenanceJournal(databasePath)?.validationFailureAcknowledgedAt).toBeDefined();
    expect(readFingerprint()).toBe(changed);
    expect(compactDatabase({ databasePath }).phase).toBe("completed");
  });

  it("preserves DELETE journal mode and recovers safely without a WAL", () => {
    const db = new NodeSqlite.DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode=DELETE");
    db.close();
    const before = readFingerprint();
    compactDatabase({ databasePath });
    const after = new NodeSqlite.DatabaseSync(databasePath);
    try {
      expect(after.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
      expect(fingerprintDatabase(after)).toBe(before);
    } finally {
      after.close();
    }
  });

  it("refuses unsupported virtual tables and hard-linked database aliases", () => {
    const alias = NodePath.join(directory, "alias.sqlite");
    NodeFS.linkSync(databasePath, alias);
    expect(() => compactDatabase({ databasePath })).toThrow("aliases");
    NodeFS.unlinkSync(alias);
    const db = new NodeSqlite.DatabaseSync(databasePath);
    db.exec("CREATE VIRTUAL TABLE search USING fts5(text)");
    db.close();
    const before = NodeFS.readFileSync(databasePath);
    expect(() => compactDatabase({ databasePath })).toThrow("cannot validate");
    expect(NodeFS.readFileSync(databasePath)).toEqual(before);
  });

  it("refuses a missing database without creating it or opening the V1 database", () => {
    const missing = NodePath.join(directory, "missing.sqlite");
    expect(() => compactDatabase({ databasePath: missing })).toThrow();
    expect(NodeFS.existsSync(missing)).toBe(false);
    const db = new NodeSqlite.DatabaseSync(databasePath);
    db.exec("DELETE FROM effect_sql_migrations WHERE migration_id = 55");
    db.close();
    expect(() => compactDatabase({ databasePath })).toThrow("already migrated");
    expect(NodeFS.existsSync(maintenanceJournalPath(databasePath))).toBe(false);
  });

  it("refuses insufficient or indeterminate disk space before changing the source", () => {
    const bytes = NodeFS.readFileSync(databasePath);
    for (const available of [0, Number.NaN]) {
      expect(() => compactDatabase({ databasePath }, { availableBytes: () => available })).toThrow(
        "disk space",
      );
    }
    expect(NodeFS.readFileSync(databasePath)).toEqual(bytes);
    expect(NodeFS.existsSync(maintenanceJournalPath(databasePath))).toBe(false);
  });

  it("selects and checks the same volume for the database, snapshot and SQLite temporary files", () => {
    const estimate = estimateDatabaseMaintenance(databasePath);
    expect(estimate.sqliteTemporaryDirectory).toBe(directory);
    expect(estimate.snapshotDirectory).toBe(directory);
    expect(estimate.requiredFreeBytes).toBeGreaterThan(
      3 * estimate.databaseBytes + 64 * 1024 * 1024,
    );
    const checked: string[] = [];
    expect(() =>
      compactDatabase(
        { databasePath },
        {
          availableBytes: (selected) => {
            checked.push(selected);
            // Read the process-global setting on a separate, disposable connection.
            const probe = new NodeSqlite.DatabaseSync(":memory:");
            try {
              expect(probe.prepare("PRAGMA temp_store_directory").get()?.temp_store_directory).toBe(
                directory,
              );
            } finally {
              probe.close();
            }
            return estimate.requiredFreeBytes - 1;
          },
        },
      ),
    ).toThrow("disk space");
    expect(checked).toEqual([directory]);
    expect(NodeFS.existsSync(maintenanceJournalPath(databasePath))).toBe(false);
  });

  it.each(["wal", "delete"])(
    "refuses a live %s writer and preserves its committed and pending work",
    (mode) => {
      const writer = new NodeSqlite.DatabaseSync(databasePath);
      try {
        writer.exec(
          `PRAGMA journal_mode=${mode}; BEGIN IMMEDIATE; INSERT INTO future_fork_table (id, value) VALUES (2, 'pending')`,
        );
        expect(() => compactDatabase({ databasePath })).toThrow(/locked|busy/);
        writer.exec("COMMIT");
        expect(writer.prepare("SELECT value FROM future_fork_table WHERE id=2").get()?.value).toBe(
          "pending",
        );
        expect(NodeFS.existsSync(maintenanceJournalPath(databasePath))).toBe(false);
      } finally {
        writer.close();
      }
    },
  );

  it("refuses a pinned WAL reader and retains uncheckpointed committed data", () => {
    const writer = new NodeSqlite.DatabaseSync(databasePath);
    const reader = new NodeSqlite.DatabaseSync(databasePath);
    try {
      writer.exec(
        "PRAGMA wal_autocheckpoint=0; INSERT INTO future_fork_table (id,value) VALUES (2,'wal')",
      );
      reader.exec("BEGIN; SELECT * FROM future_fork_table");
      expect(() => compactDatabase({ databasePath })).toThrow(/locked|busy/);
      reader.exec("ROLLBACK");
    } finally {
      reader.close();
      writer.close();
    }
    const result = compactDatabase({ databasePath });
    expect(readFingerprint(result.snapshotPath)).toBe(readFingerprint());
  });

  it("blocks a new writer at every phase through completion", () => {
    compactDatabase(
      { databasePath },
      {
        onPhase: () => {
          const writer = new NodeSqlite.DatabaseSync(databasePath, { timeout: 0 });
          try {
            expect(() => writer.exec("INSERT INTO future_fork_table (id) VALUES (2)")).toThrow(
              /locked|busy/,
            );
          } finally {
            writer.close();
          }
        },
      },
    );
  });

  it("fails closed on live, malformed or inaccessible runtime state", () => {
    const statePath = NodePath.join(directory, "server-runtime.json");
    for (const state of [
      JSON.stringify({ pid: process.pid }),
      "{",
      "",
      JSON.stringify({ pid: -1 }),
    ]) {
      NodeFS.writeFileSync(statePath, state);
      expect(() => compactDatabase({ databasePath })).toThrow();
      expect(NodeFS.existsSync(maintenanceJournalPath(databasePath))).toBe(false);
    }
    NodeFS.unlinkSync(statePath);
    NodeFS.mkdirSync(statePath);
    expect(() => compactDatabase({ databasePath })).toThrow();
  });

  it("refuses a corrupt source or foreign-key violations", () => {
    const db = new NodeSqlite.DatabaseSync(databasePath);
    db.exec(
      "PRAGMA foreign_keys=OFF; CREATE TABLE child (parent_id INTEGER REFERENCES future_fork_table(id)); INSERT INTO child VALUES (123)",
    );
    db.close();
    expect(() => compactDatabase({ databasePath })).toThrow("foreign_key_check");
    NodeFS.writeFileSync(databasePath, "not sqlite");
    expect(() => compactDatabase({ databasePath })).toThrow();
  });

  it.each(["truncate", "change-data", "change-schema"])(
    "refuses a %s candidate before rewriting the original",
    (damage) => {
      const bytes = NodeFS.readFileSync(databasePath);
      expect(() =>
        compactDatabase(
          { databasePath },
          {
            onPhase: (journal, snapshot) => {
              if (journal.phase !== "copied") return;
              if (damage === "truncate") {
                NodeFS.truncateSync(snapshot, 128);
                return;
              }
              const candidate = new NodeSqlite.DatabaseSync(snapshot);
              candidate.exec(
                damage === "change-data"
                  ? "UPDATE future_fork_table SET value = X'00'"
                  : "DROP INDEX idx_scheduled_tasks_due",
              );
              candidate.close();
            },
          },
        ),
      ).toThrow();
      expect(NodeFS.readFileSync(databasePath)).toEqual(bytes);
      expect(readMaintenanceJournal(databasePath)?.phase).toBe("failed");
    },
  );

  it.each(["copying", "copied", "validated", "rewriting"] as const)(
    "records and recovers a failure at %s without deleting the source or snapshot",
    (phase) => {
      const before = readFingerprint();
      leaveInterrupted(phase);
      expect(() => compactDatabase({ databasePath })).toThrow("recover");
      expect(recoverDatabaseMaintenance({ databasePath })?.phase).toBe("recovered");
      expect(readFingerprint()).toBe(before);
      expect(compactDatabase({ databasePath }).phase).toBe("completed");
    },
  );

  it("never restores a stale snapshot over newly committed work", () => {
    leaveInterrupted();
    const db = new NodeSqlite.DatabaseSync(databasePath);
    db.exec("INSERT INTO future_fork_table (id,value) VALUES (2,'newer')");
    db.close();
    const current = readFingerprint();
    expect(recoverDatabaseMaintenance({ databasePath })?.recovery).toBe("changed");
    expect(readFingerprint()).toBe(current);
    expect(recoverDatabaseMaintenance({ databasePath })?.recovery).toBe("changed");
  });

  it("refuses recovery if a validated snapshot is missing or damaged", () => {
    leaveInterrupted();
    const journal = readMaintenanceJournal(databasePath)!;
    const snapshot = maintenanceSnapshotPath(databasePath, journal);
    const current = readFingerprint();
    NodeFS.writeFileSync(snapshot, "broken");
    expect(() => recoverDatabaseMaintenance({ databasePath })).toThrow();
    NodeFS.unlinkSync(snapshot);
    expect(() => recoverDatabaseMaintenance({ databasePath })).toThrow();
    expect(readFingerprint()).toBe(current);
  });

  it("refuses a torn or path-injecting journal without changing the database", () => {
    const current = readFingerprint();
    leaveInterrupted();
    const journal = readMaintenanceJournal(databasePath)!;
    for (const raw of [
      "{",
      JSON.stringify({ ...journal, runId: "../../elsewhere" }),
      JSON.stringify({ ...journal, phase: "rewriting", fingerprint: undefined }),
    ]) {
      NodeFS.writeFileSync(maintenanceJournalPath(databasePath), raw);
      expect(() => compactDatabase({ databasePath })).toThrow();
      expect(() => recoverDatabaseMaintenance({ databasePath })).toThrow();
    }
    expect(readFingerprint()).toBe(current);
  });

  it("detects altered rows in every populated V2 and fork table, including 64-bit integers and blobs", () => {
    const db = new NodeSqlite.DatabaseSync(databasePath);
    try {
      const expected = fingerprintDatabase(db);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
      let checked = 0;
      for (const { name } of tables) {
        if (name === "sqlite_sequence" || !db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get())
          continue;
        db.exec("SAVEPOINT tamper");
        db.exec(`DELETE FROM "${name}"`);
        expect(fingerprintDatabase(db), String(name)).not.toBe(expected);
        db.exec("ROLLBACK TO tamper; RELEASE tamper");
        checked++;
      }
      expect(checked).toBeGreaterThan(30);
      db.exec("UPDATE future_fork_table SET big = 9223372036854775806");
      expect(fingerprintDatabase(db)).not.toBe(expected);
    } finally {
      db.close();
    }
  });
});

async function interruptChild(phase: string, duringRewrite = false) {
  const moduleUrl = new URL("./DatabasePhysicalMaintenance.ts", import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { compactDatabase } from ${JSON.stringify(moduleUrl)};
    compactDatabase({databasePath: process.argv[1]}, {onPhase: (journal) => {
      if (journal.phase !== process.argv[2]) return;
      fs.writeSync(1, 'ready\\n');
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    }});
  `;
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "-e", script, databasePath, phase],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.stdout.once("error", reject);
  });
  let watcher: NodeFS.FSWatcher | undefined;
  let observedWalBytes = 0;
  try {
    await Promise.race([
      ready,
      exited.then(() => {
        throw new Error(`Maintenance child exited before receipt: ${stderr}`);
      }),
    ]);
    if (duringRewrite) {
      // The child waits for our acknowledgement before VACUUM. Kill only after
      // observing real WAL writes; no delay or polling guesses the crash point.
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          watcher = NodeFS.watch(directory, (_event, file) => {
            if (file !== "statev2.sqlite-wal") return;
            try {
              const size = NodeFS.statSync(`${databasePath}-wal`).size;
              if (size > 32) {
                observedWalBytes = size;
                child.kill("SIGKILL");
                resolve();
              }
            } catch (error) {
              reject(error);
            }
          });
          watcher.on("error", reject);
          child.stdin.write("g");
        }),
        exited.then(() => {
          throw new Error(`Child exited before WAL interruption: ${stderr}`);
        }),
      ]);
    } else {
      child.kill("SIGKILL");
    }
    await exited;
    return { observedWalBytes };
  } finally {
    watcher?.close();
    child.kill("SIGKILL");
    await exited;
  }
}

describe("process interruption", () => {
  it.each(["copying", "copied", "validated", "rewriting", "completed"])(
    "survives process death at the durable %s journal receipt",
    async (phase) => {
      const before = readFingerprint();
      await interruptChild(phase);
      expect(readMaintenanceJournal(databasePath)?.phase).toBe(phase);
      recoverDatabaseMaintenance({ databasePath });
      expect(readFingerprint()).toBe(before);
    },
  );

  it("recovers committed data after observing VACUUM WAL writes and requesting process death", async () => {
    const db = new NodeSqlite.DatabaseSync(databasePath);
    db.exec("INSERT INTO maintenance_space VALUES (3, zeroblob(33554432))");
    db.close();
    const before = readFingerprint();
    const interruption = await interruptChild("rewriting", true);
    // The OS may deliver termination after VACUUM commits. This proves recovery
    // after observed writes, not a deterministic mid-transaction interruption.
    expect(["rewriting", "checking-result", "completed"]).toContain(
      readMaintenanceJournal(databasePath)?.phase,
    );
    expect(interruption.observedWalBytes).toBeGreaterThan(32);
    recoverDatabaseMaintenance({ databasePath, acknowledgeValidationFailure: true });
    expect(readFingerprint()).toBe(before);
  });

  it("requires acknowledgement after death at the durable final-validation boundary", async () => {
    const before = readFingerprint();
    await interruptChild("checking-result");
    expect(readMaintenanceJournal(databasePath)?.phase).toBe("checking-result");
    expect(() => recoverDatabaseMaintenance({ databasePath })).toThrow(
      "Final validation failed or was interrupted",
    );
    expect(() => compactDatabase({ databasePath })).toThrow("recover");
    recoverDatabaseMaintenance({ databasePath, acknowledgeValidationFailure: true });
    expect(readFingerprint()).toBe(before);
  });
});
