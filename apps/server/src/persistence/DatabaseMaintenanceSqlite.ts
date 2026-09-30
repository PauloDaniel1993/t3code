// @effect-diagnostics nodeBuiltinImport:off - Offline maintenance owns its SQLite connections.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

/**
 * Read without checkpointing or touching WAL/SHM, including a crashed writer's WAL.
 * A normal readOnly connection can still create or update SHM. The no-lock VFS
 * plus EXCLUSIVE mode instead builds a private WAL index in memory. Never use
 * this connection for writes. Preflight is advisory until the real lock is held;
 * final validation uses it while that lock prevents any concurrent changes.
 * https://sqlite.org/wal.html#use_of_wal_without_shared_memory
 */
export function withMaintenanceReadOnlyDatabase<A>(
  path: string,
  run: (database: NodeSqlite.DatabaseSync) => A,
): A {
  const uri = NodeURL.pathToFileURL(path);
  uri.searchParams.set("mode", "ro");
  uri.searchParams.set(
    "vfs",
    HostProcessPlatform.defaultValue() === "win32" ? "win32-none" : "unix-none",
  );
  const database = new NodeSqlite.DatabaseSync(uri.href, { readOnly: true, timeout: 0 });
  try {
    // This must precede the first access to the database, even journal_mode.
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN");
    return run(database);
  } finally {
    database.close();
  }
}

/**
 * Only the stopped-server, synchronous CLI calls this. SQLite's temporary-folder
 * override is process-global: configure it before opening any source connection,
 * verify support (some builds omit it), and restore it after all handles close.
 * This avoids guessing Windows GetTempPath versus TEMP/TMP or Unix VFS fallbacks.
 */
export function withMaintenanceTemporaryDirectory<A>(directory: string, run: () => A): A {
  const control = new NodeSqlite.DatabaseSync(":memory:");
  const previous = control.prepare("PRAGMA temp_store_directory").get()?.temp_store_directory;
  const setDirectory = (value: string) =>
    control.exec(`PRAGMA temp_store_directory = '${value.replaceAll("'", "''")}'`);
  try {
    setDirectory(directory);
    const selected = control.prepare("PRAGMA temp_store_directory").get()?.temp_store_directory;
    if (
      typeof selected !== "string" ||
      NodePath.resolve(selected) !== NodePath.resolve(directory)
    ) {
      throw new Error("SQLite cannot select the checked temporary directory; maintenance refused.");
    }
    return run();
  } finally {
    try {
      setDirectory(typeof previous === "string" ? previous : "");
    } finally {
      control.close();
    }
  }
}
