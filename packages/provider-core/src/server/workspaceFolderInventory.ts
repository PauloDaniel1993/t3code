/** Paths are JSON-encoded so folder names cannot escape the inventory block. */
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
