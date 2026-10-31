import {
  FlowMcpInput,
  ProjectId,
  FlowId,
  FlowInputs,
  FlowRunId,
  FlowStepRunId,
  FlowApprovalDecision,
  FlowMcpOutput,
  FlowReportMcpInput,
  FlowReportMcpOutput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FlowService from "./FlowService.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const FlowToolInput = Schema.Struct({
  action: Schema.Literals([
    "list",
    "validate",
    "start",
    "read_run",
    "stop",
    "resume",
    "retry_step",
    "answer_approval",
  ]),
  projectId: Schema.optional(ProjectId),
  flowId: Schema.optional(FlowId),
  inputs: Schema.optional(FlowInputs),
  baseRef: Schema.optional(Schema.String),
  flowRunId: Schema.optional(FlowRunId),
  stepRunId: Schema.optional(FlowStepRunId),
  decision: Schema.optional(FlowApprovalDecision),
  comment: Schema.optional(Schema.String),
});
const decodeInput = Schema.decodeUnknownEffect(FlowMcpInput);
const dependencies = [
  FlowService.FlowService,
  Invocation.McpInvocationContext,
  Threads.ThreadManagementService,
];
export const FlowToolkit = Toolkit.make(
  Tool.make("t3_flow", {
    description: "List, validate, start or manage a flow run.",
    parameters: FlowToolInput,
    success: FlowMcpOutput,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }),
  Tool.make("t3_flow_report", {
    description: "Report this step's declared output fields before finishing.",
    parameters: FlowReportMcpInput,
    success: FlowReportMcpOutput,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }),
);
const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
const handle = Effect.fn("FlowMcp.handle")(function* (
  wireInput: typeof FlowToolInput.Type,
): Effect.fn.Return<
  FlowMcpOutput,
  OrchestratorMcpFailure,
  FlowService.FlowService | Invocation.McpInvocationContext | Threads.ThreadManagementService
> {
  const input = yield* decodeInput(wireInput).pipe(
    Effect.mapError(() => failure({ message: "Missing or invalid fields for this flow action." })),
  );
  const service = yield* FlowService.FlowService;
  if (input.action === "list" || input.action === "validate" || input.action === "start") {
    const invocation = yield* Invocation.McpInvocationContext;
    let projectId = input.projectId;
    if (!projectId && invocation.thread) {
      const threads = yield* Threads.ThreadManagementService;
      projectId = (yield* threads
        .getThreadShell(invocation.thread.threadId)
        .pipe(Effect.mapError(failure)))?.projectId;
    }
    if (!projectId) return yield* failure({ message: "Choose a projectId for the flow." });
    if (input.action === "list")
      return {
        action: "list",
        flows: yield* service.list(projectId).pipe(Effect.mapError(failure)),
      };
    if (input.action === "validate")
      return {
        action: "validate",
        ...(yield* service.read(projectId, input.flowId).pipe(
          Effect.map((entry) => entry.validation),
          Effect.mapError(failure),
        )),
      };
    return {
      action: "start",
      summary: yield* service.start({ ...input, projectId }).pipe(Effect.mapError(failure)),
    };
  }
  switch (input.action) {
    case "read_run": {
      const snapshot = yield* service.snapshot(input.flowRunId).pipe(Effect.mapError(failure));
      if (input.stepRunId && !snapshot.stepRuns.some((step) => step.id === input.stepRunId))
        return yield* failure({ message: "Step run does not belong to this flow run." });
      return {
        action: "read_run",
        ...snapshot,
        ...(input.stepRunId
          ? {
              stepOutput: yield* service
                .stepRunOutput(input.stepRunId)
                .pipe(Effect.mapError(failure)),
            }
          : {}),
      };
    }
    case "stop":
      return {
        action: input.action,
        summary: yield* service.stop(input.flowRunId).pipe(Effect.mapError(failure)),
      };
    case "resume":
      return {
        action: input.action,
        summary: yield* service.resume(input.flowRunId).pipe(Effect.mapError(failure)),
      };
    case "retry_step":
      return {
        action: input.action,
        summary: yield* service.retryStep(input.stepRunId).pipe(Effect.mapError(failure)),
      };
    case "answer_approval": {
      const invocation = yield* Invocation.McpInvocationContext;
      return {
        action: input.action,
        summary: yield* service
          .answerApproval(
            input,
            invocation.thread?.threadId ?? invocation.client?.sessionId ?? "mcp",
          )
          .pipe(Effect.mapError(failure)),
      };
    }
  }
});
const handlers = {
  t3_flow: McpToolAccess.either(
    (input: typeof FlowToolInput.Type) => ["list", "validate", "read_run"].includes(input.action),
    McpToolAccess.reads(handle),
    McpToolAccess.writesEnvironment(handle),
  ),
  t3_flow_report: McpToolAccess.actsAsCaller((input: FlowReportMcpInput) =>
    Effect.gen(function* () {
      const service = yield* FlowService.FlowService;
      const invocation = yield* Invocation.McpInvocationContext;
      if (!invocation.thread)
        return yield* failure({ message: "Report requires a flow step thread." });
      return yield* service
        .report(invocation.thread.threadId, input.fields)
        .pipe(Effect.mapError(failure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof FlowToolkit.tools>;
export const layer = McpToolAccess.toLayer(FlowToolkit, handlers);
