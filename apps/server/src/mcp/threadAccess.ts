import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as OrchestrationMcp from "./OrchestratorMcpService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

const isThreadLaunchError = Schema.is(ThreadLaunch.ThreadLaunchError);

/**
 * A launch refused while validating its workspace, such as a provider that
 * can't reach every workspace folder, keeps its reason so the agent can act on
 * it, as over the transport. Anything else is unavailable.
 */
export const launchRefusal = (error: unknown) => {
  const message =
    isThreadLaunchError(error) && error.operation === "validate-workspace"
      ? userFacingDispatchErrorMessage(error.cause)
      : undefined;
  return message === undefined
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message });
};

/** A provider switch refused for workspace folder access says so; anything else is unavailable. */
export const switchRefusal = (error: unknown) =>
  userFacingDispatchErrorMessage(error) === PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE
    ? new OrchestratorMcpFailure({
        code: "invalid_request",
        message: PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE,
      })
    : unavailable();

export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const caller = yield* threads.getThreadShell(scope.threadId).pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return { scope, threads, caller };
});

function assertLiveCaller({
  caller,
  scope,
}: {
  caller: OrchestrationV2ThreadShell;
  scope: McpInvocationContext.McpInvocationScope;
}) {
  return caller.archivedAt !== null ||
    caller.activeRunId === null ||
    caller.providerInstanceId !== scope.providerInstanceId
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      )
    : Effect.void;
}
export const readMutationCaller = Effect.fn("mcp.readMutationCaller")(function* () {
  const context = yield* readCaller();
  yield* assertLiveCaller(context);
  return context;
});

/** Resolve the credential's project before looking up a caller-supplied thread. */
export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const { scope, threads, caller } = yield* readCaller();
  const projection = yield* threads
    .getProjectThreadRecords(
      { projectId: caller.projectId, threadId: threadId ?? caller.id },
      fields,
      { turnItemTypes: ["user_input_request"] },
    )
    .pipe(
      Effect.mapError((error) =>
        error._tag === "ThreadManagementThreadNotFoundError"
          ? new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The thread was not found in the calling project.",
            })
          : unavailable(),
      ),
    );
  return { scope, threads, caller, projection };
});

export const readWritableThread = Effect.fn("mcp.readWritableThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readThread(threadId, fields);
  yield* assertLiveCaller(context);
  yield* OrchestrationMcp.resolveRuntimeMode(
    context.caller.runtimeMode,
    context.projection.thread.runtimeMode,
  );
  yield* OrchestrationMcp.resolveInteractionMode(
    context.caller.interactionMode,
    context.projection.thread.interactionMode,
  );
  return context;
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(`mcp:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
});
