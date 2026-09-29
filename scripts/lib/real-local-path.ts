// @effect-diagnostics nodeBuiltinImport:off - Synchronous filesystem identity checks before local install/profile selection.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

function existingRealPath(filePath: string): string {
  try {
    return NodeFS.realpathSync.native(filePath);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    const parent = NodePath.dirname(filePath);
    return parent === filePath
      ? filePath
      : NodePath.join(existingRealPath(parent), NodePath.basename(filePath));
  }
}

function directoryIdentity(filePath: string): string | undefined {
  try {
    const stat = NodeFS.statSync(filePath, { bigint: true });
    return stat.isDirectory() && stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : undefined;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

/** Junctions and local SMB shares compare as their real local paths, including missing children. */
export function resolveRealLocalPath(
  filePath: string,
  localRoots: ReadonlyArray<string> = [],
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Synchronous bootstrap/standalone installer boundary, before Effect layers.
  platform: NodeJS.Platform = NodeOS.platform(),
): string {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  // Filesystem aliases can only be resolved for the host platform.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Only the current OS can resolve its filesystem aliases.
  if (platform !== NodeOS.platform()) return path.resolve(filePath);
  const resolved = existingRealPath(path.resolve(filePath))
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
  if (platform !== "win32" || !resolved.startsWith("\\\\")) return resolved;

  // Verify the filesystem identity; a host name or a share name alone is not
  // evidence that a UNC path is local. Named shares can also match a known root.
  const adminShare = /^\\\\[^\\]+\\([a-z])\$(?:\\|$)/i.exec(resolved);
  const roots = [
    NodeOS.userInfo().homedir,
    ...localRoots,
    ...(adminShare ? [`${adminShare[1]}:\\`] : []),
  ];
  const localIdentities = new Map<string, string>();
  for (const root of roots) {
    let parent = existingRealPath(path.resolve(root));
    if (parent.startsWith("\\\\")) continue;
    while (true) {
      const identity = directoryIdentity(parent);
      if (identity !== undefined) localIdentities.set(identity, parent);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  let parent = resolved;
  while (true) {
    const identity = directoryIdentity(parent);
    const local = identity === undefined ? undefined : localIdentities.get(identity);
    if (local !== undefined) return path.join(local, path.relative(parent, resolved));
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  throw new Error(`Cannot verify the real local directory for ${filePath}. Use its local path.`);
}
