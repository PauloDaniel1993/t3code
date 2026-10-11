import type { ProviderWorkspaceFolderAccess } from "@t3tools/contracts";

/**
 * Each provider's workspace-folder access, read by both its adapter's
 * runtime-policy capabilities and its provider snapshot, so the two can't
 * disagree. A provider becomes "supported" only in the PR whose live test reads
 * and edits a file in an extra folder after start, resume and fork.
 */
export const WORKSPACE_FOLDER_ACCESS = {
  codex: "unverified",
  claudeAgent: "unverified",
  cursor: "unverified",
  kimi: "unverified",
  // Registry agents stay unverified even when they advertise extra directories.
  acpRegistry: "unverified",
  antigravity: "unverified",
  opencode: "unverified",
  // OpenCode 2 and Grok have no way to be given folders beyond cwd.
  opencode2: "unsupported",
  grok: "unsupported",
  pi: "unverified",
} as const satisfies Record<string, ProviderWorkspaceFolderAccess>;
