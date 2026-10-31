import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { FlowInputs, FlowValidationResult } from "./flowDefinition.ts";
import { FlowAnswerApprovalInput, FlowListResult, FlowStartInput } from "./flowRpc.ts";
import {
  FlowRunId,
  FlowRunSnapshot,
  FlowRunSummary,
  FlowStepOutput,
  FlowStepRunId,
} from "./flowRun.ts";

const FLOW_MCP_DESCRIPTION = "List, validate, start or manage a flow run.";
const FLOW_REPORT_MCP_DESCRIPTION = "Report this step's declared output fields.";
export const FlowMcpInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list"), projectId: Schema.optional(ProjectId) }),
  Schema.Struct({
    action: Schema.Literal("validate"),
    projectId: Schema.optional(ProjectId),
    flowId: FlowStartInput.fields.flowId,
  }),
  Schema.Struct({
    action: Schema.Literal("start"),
    ...FlowStartInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  Schema.Struct({
    action: Schema.Literal("read_run"),
    flowRunId: FlowRunId,
    stepRunId: Schema.optional(FlowStepRunId).annotate({
      description: "Include this step run's full output.",
    }),
  }),
  Schema.Struct({ action: Schema.Literals(["stop", "resume"]), flowRunId: FlowRunId }),
  Schema.Struct({ action: Schema.Literal("retry_step"), stepRunId: FlowStepRunId }),
  Schema.Struct({ action: Schema.Literal("answer_approval"), ...FlowAnswerApprovalInput.fields }),
]).annotate({ description: FLOW_MCP_DESCRIPTION });
export type FlowMcpInput = typeof FlowMcpInput.Type;
export const FlowMcpOutput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list"), ...FlowListResult.fields }),
  Schema.Struct({ action: Schema.Literal("validate"), ...FlowValidationResult.fields }),
  Schema.Struct({
    action: Schema.Literals(["start", "stop", "resume", "retry_step", "answer_approval"]),
    summary: FlowRunSummary,
  }),
  Schema.Struct({
    action: Schema.Literal("read_run"),
    ...FlowRunSnapshot.fields,
    stepOutput: Schema.optional(Schema.NullOr(FlowStepOutput)),
  }),
]);
export type FlowMcpOutput = typeof FlowMcpOutput.Type;
export const FlowReportMcpInput = Schema.Struct({ fields: FlowInputs }).annotate({
  description: FLOW_REPORT_MCP_DESCRIPTION,
});
export type FlowReportMcpInput = typeof FlowReportMcpInput.Type;
export const FlowReportMcpOutput = FlowValidationResult;
