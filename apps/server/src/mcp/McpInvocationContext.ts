import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "tasks";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/**
 * Preview capability guard. Stays narrow to `"preview"` because
 * `PreviewAutomationUnavailableError` is part of the preview tool contract;
 * other capabilities use {@link hasMcpCapability} and raise their own toolkit's
 * error type.
 */
export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

/**
 * Resolve the invocation scope, or `null` when it does not grant `capability`.
 * Callers map the null case onto their own toolkit's failure schema.
 */
export const scopeWithCapability = Effect.fn("mcp.scopeWithCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  return invocation.capabilities.has(capability) ? invocation : null;
});
