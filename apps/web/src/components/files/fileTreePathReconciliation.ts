import type { FileTreeBatchOperation } from "@pierre/trees";
import type { ProjectEntry } from "@t3tools/contracts";

/** Search rows come only from the scoped response and the ancestors needed to reach them. */
export function fileTreeSearchEntries(entries: readonly ProjectEntry[]) {
  const result = new Map<string, ProjectEntry>();
  for (const entry of entries) {
    result.set(entry.path, entry);
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index++) {
      const path = segments.slice(0, index).join("/");
      if (!result.has(path)) result.set(path, { path, kind: "directory" });
    }
  }
  return [...result.values()];
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

export function buildFileTreePathUpdates(
  previousPaths: readonly string[],
  nextPaths: readonly string[],
): FileTreeBatchOperation[] {
  const previous = new Set(previousPaths);
  const next = new Set(nextPaths);
  const removedDirectoryRoots: string[] = [];
  const updates: FileTreeBatchOperation[] = [];

  const removedPaths = previousPaths
    .filter((path) => !next.has(path))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const path of removedPaths) {
    if (removedDirectoryRoots.some((directory) => path.startsWith(directory))) continue;
    const recursive = path.endsWith("/");
    updates.push({ type: "remove", path, ...(recursive ? { recursive: true } : {}) });
    if (recursive) removedDirectoryRoots.push(path);
  }

  const addedPaths = nextPaths
    .filter((path) => !previous.has(path))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const path of addedPaths) updates.push({ type: "add", path });

  return updates;
}
