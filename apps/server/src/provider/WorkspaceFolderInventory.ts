/**
 * Tell the agent which folders a multi-folder run spans: its working directory
 * (the primary folder) and the run's additional directories, in order. Paths
 * are JSON strings, so no folder name can break out of the block. This only
 * informs the agent; the adapter grants access. Undefined for a one-folder
 * scope, which needs no inventory.
 */
export function buildWorkspaceFolderInventory(scope: {
  readonly cwd: string | null;
  readonly additionalDirectories: ReadonlyArray<string>;
}): string | undefined {
  if (scope.cwd === null || scope.additionalDirectories.length === 0) return undefined;
  return [
    "<workspace_folders>",
    "This thread's workspace spans several folders. Your working directory is its primary folder, and relative paths resolve from it. To work in another folder, use that folder's path as listed here. Paths are JSON strings.",
    `Primary folder: ${quotePath(scope.cwd)}`,
    "Other folders:",
    ...scope.additionalDirectories.map((path) => `- ${quotePath(path)}`),
    "</workspace_folders>",
  ].join("\n");
}

function quotePath(path: string): string {
  return JSON.stringify(path).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}
