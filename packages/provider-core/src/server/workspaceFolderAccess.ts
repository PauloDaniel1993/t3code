import type { ProviderWorkspaceFolderAccess } from "@t3tools/contracts";

/**
 * Each provider's workspace-folder access, read by both its adapter's
 * runtime-policy capabilities and its provider snapshot, so the two can't
 * disagree. A provider becomes "supported" only in the PR whose live test reads
 * and edits a file in an extra folder after start, resume and fork.
 */
export const WORKSPACE_FOLDER_ACCESS = {
  codex: "supported",
  claudeAgent: "supported",
  cursor: "unverified",
  kimi: "unverified",
  // Registry agents stay unverified even when they advertise extra directories.
  acpRegistry: "unverified",
  antigravity: "unverified",
  opencode: "unverified",
  // OpenCode 2 accepts directory rules; live folder verification is still pending.
  opencode2: "unverified",
  grok: "unsupported",
  pi: "unverified",
} as const satisfies Record<string, ProviderWorkspaceFolderAccess>;
