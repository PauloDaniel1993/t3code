import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId } from "./baseSchemas.ts";
import { FlowDefinition, FlowId, FlowInputs, FlowValidationResult } from "./flowDefinition.ts";
import {
  FlowApprovalDecision,
  FlowRunId,
  FlowRunSnapshot,
  FlowRunSummary,
  FlowStepOutput,
  FlowStepRunId,
} from "./flowRun.ts";

export const FLOW_WS_METHODS = {
  flowList: "flow.list",
  flowSave: "flow.save",
  flowRename: "flow.rename",
  flowDelete: "flow.delete",
  flowValidate: "flow.validate",
  flowStart: "flow.start",
  flowRuns: "flow.runs",
  flowRun: "flow.run",
  flowStepRunOutput: "flow.stepRunOutput",
  flowStop: "flow.stop",
  flowResume: "flow.resume",
  flowRetryStep: "flow.retryStep",
  flowAnswerApproval: "flow.answerApproval",
} as const;
export class FlowError extends Schema.TaggedError<FlowError>()("FlowError", {
  message: Schema.String,
}) {}
export const FlowListInput = Schema.Struct({ projectId: ProjectId });
export const FlowDefinitionEntry = Schema.Struct({
  flowId: FlowId,
  definition: Schema.NullOr(FlowDefinition),
  validation: FlowValidationResult,
});
export const FlowListResult = Schema.Struct({ flows: Schema.Array(FlowDefinitionEntry) });
export const FlowSaveInput = Schema.Struct({
  projectId: ProjectId,
  flowId: FlowId,
  definition: FlowDefinition,
});
export const FlowRenameInput = Schema.Struct({
  projectId: ProjectId,
  flowId: FlowId,
  newFlowId: FlowId,
});
export const FlowDeleteInput = Schema.Struct({ projectId: ProjectId, flowId: FlowId });
export const FlowValidateInput = Schema.Struct({
  projectId: ProjectId,
  definition: Schema.Unknown,
});
export const FlowStartInput = Schema.Struct({
  projectId: ProjectId,
  flowId: FlowId,
  inputs: FlowInputs,
  baseRef: Schema.optional(Schema.String),
});
export const FlowRunInput = Schema.Struct({ flowRunId: FlowRunId });
export const FlowStepRunInput = Schema.Struct({ stepRunId: FlowStepRunId });
export const FlowAnswerApprovalInput = Schema.Struct({
  stepRunId: FlowStepRunId,
  decision: FlowApprovalDecision,
  comment: Schema.optional(Schema.String),
});
const error = Schema.Union([FlowError, EnvironmentAuthorizationError]);
export const FlowRpcs = [
  Rpc.make(FLOW_WS_METHODS.flowList, {
    payload: FlowListInput,
    success: FlowListResult,
    error,
    stream: true,
  }),
  Rpc.make(FLOW_WS_METHODS.flowSave, {
    payload: FlowSaveInput,
    success: FlowDefinitionEntry,
    error,
  }),
  Rpc.make(FLOW_WS_METHODS.flowRename, {
    payload: FlowRenameInput,
    success: FlowDefinitionEntry,
    error,
  }),
  Rpc.make(FLOW_WS_METHODS.flowDelete, { payload: FlowDeleteInput, success: Schema.Void, error }),
  Rpc.make(FLOW_WS_METHODS.flowValidate, {
    payload: FlowValidateInput,
    success: FlowValidationResult,
    error,
  }),
  Rpc.make(FLOW_WS_METHODS.flowStart, { payload: FlowStartInput, success: FlowRunSummary, error }),
  Rpc.make(FLOW_WS_METHODS.flowRuns, {
    payload: FlowListInput,
    success: Schema.Struct({ runs: Schema.Array(FlowRunSummary) }),
    error,
    stream: true,
  }),
  Rpc.make(FLOW_WS_METHODS.flowRun, {
    payload: FlowRunInput,
    success: FlowRunSnapshot,
    error,
    stream: true,
  }),
  Rpc.make(FLOW_WS_METHODS.flowStepRunOutput, {
    payload: FlowStepRunInput,
    success: Schema.NullOr(FlowStepOutput),
    error,
  }),
  Rpc.make(FLOW_WS_METHODS.flowStop, { payload: FlowRunInput, success: FlowRunSummary, error }),
  Rpc.make(FLOW_WS_METHODS.flowResume, { payload: FlowRunInput, success: FlowRunSummary, error }),
  Rpc.make(FLOW_WS_METHODS.flowRetryStep, {
    payload: FlowStepRunInput,
    success: FlowRunSummary,
    error,
  }),
  Rpc.make(FLOW_WS_METHODS.flowAnswerApproval, {
    payload: FlowAnswerApprovalInput,
    success: FlowRunSummary,
    error,
  }),
] as const;
