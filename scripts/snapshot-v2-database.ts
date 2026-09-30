// @effect-diagnostics nodeBuiltinImport:off - Standalone read-only SQLite snapshot command.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { resolveCommandLinePath, resolveRealLocalPath } from "./lib/real-local-path.ts";

/**
 * Snapshot live V1 data without opening it for writes or replacing another snapshot. Returns the
 * temporary file it could not remove after publishing, if any; the snapshot itself is complete then.
 */
export function snapshotV2Database(
  source: string,
  destination: string,
  home = NodeOS.userInfo().homedir,
): { readonly leftoverPartial: string | undefined } {
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
      throw new Error(`Refusing snapshot destination ${target}, which is under ${protectedHome}.`);
    }
  }
  const database = new NodeSqlite.DatabaseSync(source, { readOnly: true });
  // Build beside the destination and link it into place on success, so a failure never leaves
  // a destination file behind. `link` fails with EEXIST rather than replacing an existing one.
  const partial = `${target}.${process.pid}.partial`;
  let reserved = false;
  const removePartial = () => {
    if (!reserved) return undefined;
    try {
      NodeFS.rmSync(partial, { force: true });
      return undefined;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };
  try {
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    // Reserve exclusively; VACUUM INTO accepts an empty file. The exclusive open succeeding is the
    // moment the file becomes this run's own, so record that before anything else can fail.
    const descriptor = NodeFS.openSync(partial, "wx");
    reserved = true;
    NodeFS.closeSync(descriptor);
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
  } catch (cause) {
    // Nothing after the link can throw, so every failure here is before publication.
    throw failure(cause, destination, partial, reserved, removePartial());
  } finally {
    database.close();
  }
  // Published: the destination is complete whether or not the temporary name can be removed.
  return { leftoverPartial: removePartial() === undefined ? undefined : partial };
}

/** Describe a failure before publication: nothing was written to the destination. */
function failure(
  cause: unknown,
  destination: string,
  partial: string,
  reserved: boolean,
  removeError: string | undefined,
) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const temporary = !reserved
    ? "No temporary file was created by this run."
    : removeError === undefined
      ? `Removed its own temporary file, ${partial}.`
      : `Could not remove its own temporary file, ${partial} (${removeError}); it can be deleted by hand.`;
  return new Error(
    `${reason}\nSnapshot failed. No snapshot was written to ${destination}. ${temporary}`,
    { cause },
  );
}
if (import.meta.main) {
  const [source, destination, extra] = process.argv.slice(2);
  if (!source || !destination || extra)
    throw new Error("Usage: node scripts/snapshot-v2-database.ts <source> <destination>");
  // A relative destination means relative to the current directory; name the full path from here on.
  const fullDestination = resolveCommandLinePath(destination);
  const { leftoverPartial } = snapshotV2Database(source, fullDestination);
  process.stdout.write(`Snapshot quick_check: ok\nSnapshot written to ${fullDestination}\n`);
  if (leftoverPartial)
    process.stderr.write(
      `Warning: the snapshot is complete, but the temporary file ${leftoverPartial} could not be removed. It can be deleted by hand.\n`,
    );
}
