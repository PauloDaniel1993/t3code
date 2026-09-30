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
    if (parent === filePath) throw cause;
    return NodePath.join(existingRealPath(parent), NodePath.basename(filePath));
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

/**
 * For commands a person runs at a prompt: a relative option, argument or environment value means
 * relative to the current directory, so make it a full path before the guard sees it. Only
 * `resolveRealLocalPath` decides whether that full path is acceptable; it stays strict so nothing
 * inside the app can pass it a relative path. Spellings that are not plainly relative (`/`
 * separators, `C:name`, `\name`, `\\?\`) are returned unchanged for the guard to refuse.
 */
export function resolveCommandLinePath(
  value: string,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Command line boundary, before Effect layers.
  platform: NodeJS.Platform = NodeOS.platform(),
  cwd = process.cwd(),
): string {
  if (platform !== "win32") return NodePath.posix.resolve(cwd, value);
  if (value.includes("/") || /^[a-z]:|^\\/i.test(value)) return value;
  return NodePath.win32.resolve(cwd, value);
}

/** Junctions and local SMB shares compare as their real local paths, including missing children. */
export function resolveRealLocalPath(
  filePath: string,
  localRoots: ReadonlyArray<string> = [],
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Synchronous bootstrap/standalone installer boundary, before Effect layers.
  platform: NodeJS.Platform = NodeOS.platform(),
  cwd = process.cwd(),
): string {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  if (platform === "win32") {
    // Check the original spelling before path.resolve can erase separators or segments.
    if (filePath.includes("/") || /^\\\\[?.]\\/.test(filePath)) {
      throw new Error(`Refusing Windows path spelling ${filePath}. Use its ordinary local path.`);
    }
    if (!/^(?:[a-z]:\\|\\\\)/i.test(filePath)) {
      throw new Error(
        `A full path is required, not ${filePath}. Start it with a drive such as C:\\.`,
      );
    }
    const segments = filePath.replace(/^[a-z]:/i, "").split("\\");
    if (segments.some((segment) => /[. ]$/.test(segment))) {
      throw new Error(
        `Windows ignores trailing dots and spaces in ${filePath}. Use the real directory name.`,
      );
    }
    if (segments.some((segment) => segment.includes(":") || /~\d/i.test(segment))) {
      throw new Error(
        `Refusing Windows short names or alternate data streams in ${filePath}. Use the real directory name.`,
      );
    }
  }
  // Filesystem aliases can only be resolved for the host platform.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Only the current OS can resolve its filesystem aliases.
  if (platform !== NodeOS.platform()) return path.resolve(cwd, filePath);
  const resolved = existingRealPath(path.resolve(cwd, filePath))
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
  if (platform !== "win32") return resolved;
  if (resolved.split("\\").some((segment) => /[. ]$/.test(segment) || /~\d/i.test(segment))) {
    throw new Error(
      `Cannot verify the real Windows directory for ${filePath}. Use its ordinary local path.`,
    );
  }
  if (!resolved.startsWith("\\\\")) return resolved;

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
