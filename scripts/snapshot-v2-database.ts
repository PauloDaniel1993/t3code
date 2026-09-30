// @effect-diagnostics nodeBuiltinImport:off - Standalone read-only SQLite snapshot command.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { resolveRealLocalPath } from "./lib/real-local-path.ts";

/** Snapshot live V1 data without opening it for writes or replacing another snapshot. */
export function snapshotV2Database(
  source: string,
  destination: string,
  home = NodeOS.userInfo().homedir,
): void {
  const roots = [home];
  const target = resolveRealLocalPath(destination, roots);
  for (const name of [".t3", ".t3.local"]) {
    const protectedHome = resolveRealLocalPath(NodePath.join(home, name), roots);
    const relative = NodePath.relative(protectedHome, target);
    if (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    ) {
      throw new Error(`Refusing snapshot destination under ${protectedHome}.`);
    }
  }
  const database = new NodeSqlite.DatabaseSync(source, { readOnly: true });
  // Build beside the destination and link it into place on success, so a failure never leaves
  // a destination file behind. `link` fails with EEXIST rather than replacing an existing one.
  const partial = `${target}.${process.pid}.partial`;
  try {
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    // Reserve exclusively; VACUUM INTO accepts an empty file. Only a file this call created is removed.
    NodeFS.closeSync(NodeFS.openSync(partial, "wx"));
    try {
      database.prepare("VACUUM INTO ?").run(partial);
      const snapshot = new NodeSqlite.DatabaseSync(partial, { readOnly: true });
      try {
        const rows = snapshot.prepare("PRAGMA quick_check").all();
        if (rows.length !== 1 || rows[0]?.quick_check !== "ok")
          throw new Error("Snapshot quick_check failed.");
      } finally {
        snapshot.close();
      }
      NodeFS.linkSync(partial, target);
    } finally {
      NodeFS.rmSync(partial, { force: true });
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${reason}\nSnapshot failed. Removed only its own temporary file, ${partial}; ${destination} was not created or changed.`,
      { cause },
    );
  } finally {
    database.close();
  }
}
if (import.meta.main) {
  const [source, destination, extra] = process.argv.slice(2);
  if (!source || !destination || extra)
    throw new Error("Usage: node scripts/snapshot-v2-database.ts <source> <destination>");
  snapshotV2Database(source, destination);
  process.stdout.write("Snapshot quick_check: ok\n");
}
