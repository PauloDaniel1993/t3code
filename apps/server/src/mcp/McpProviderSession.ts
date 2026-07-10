import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

/**
 * Provider MCP clients impose their own outer tool-call deadline even though
 * T3 waits for user-input answers without a server-side timeout. Keep this
 * comfortably below the MCP credential idle lifetime while giving users time
 * to answer a multi-question prompt.
 */
export const T3_MCP_TOOL_TIMEOUT_MS = 10 * 60 * 1_000;
export const T3_MCP_TOOL_TIMEOUT_SECONDS = T3_MCP_TOOL_TIMEOUT_MS / 1_000;

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
