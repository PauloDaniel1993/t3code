import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FlowDefinition, FlowId, FlowValue } from "./flowDefinition.ts";

export const FlowRunId = TrimmedNonEmptyString.pipe(Schema.brand("FlowRunId"));
export type FlowRunId = typeof FlowRunId.Type;
export const FlowStepRunId = TrimmedNonEmptyString.pipe(Schema.brand("FlowStepRunId"));
export type FlowStepRunId = typeof FlowStepRunId.Type;
export const FlowRunStatus = Schema.Literals([
  "starting",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
]);
export type FlowRunStatus = typeof FlowRunStatus.Type;
export const FlowStepRunStatus = Schema.Literals([
  "pending",
  "running",
  "waiting_report",
  "waiting_approval",
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
  "cancelled",
]);
export type FlowStepRunStatus = typeof FlowStepRunStatus.Type;
export const FlowApprovalDecision = Schema.Literals(["approve", "reject"]);
const OutputRef = Schema.suspend((): Schema.Codec<FlowStepOutput> => FlowStepOutput);
export const FlowAgentOutput = Schema.StructWithRest(Schema.Struct({ text: Schema.String }), [
  Schema.Record(Schema.String, FlowValue),
]);
export const FlowCommandOutput = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  text: Schema.String,
  lines: Schema.Array(Schema.String),
});
export const FlowApprovalOutput = Schema.Struct({
  decision: FlowApprovalDecision,
  comment: Schema.optional(Schema.String),
});
export const FlowLoopOutput = Schema.StructWithRest(
  Schema.Struct({
    iterations: NonNegativeInt,
    exitReason: Schema.Literals(["condition", "maxIterations"]),
  }),
  [
    Schema.Record(
      Schema.String,
      Schema.Union([OutputRef, NonNegativeInt, Schema.Literals(["condition", "maxIterations"])]),
    ),
  ],
).check(
  Schema.makeFilter((output) =>
    Object.entries(output).every(
      ([key, value]) =>
        key === "iterations" ||
        key === "exitReason" ||
        (typeof value === "object" && value !== null),
    ),
  ),
);
export const FlowMapOutput = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ status: FlowStepRunStatus, outputs: Schema.Record(Schema.String, OutputRef) }),
  ),
});
export const FlowStepOutput = Schema.Union([
  FlowCommandOutput,
  FlowApprovalOutput,
  FlowLoopOutput,
  FlowMapOutput,
  FlowAgentOutput,
]);
export type FlowStepOutput =
  | ({ readonly text: string } & Readonly<Record<string, FlowValue>>)
  | typeof FlowCommandOutput.Type
  | typeof FlowApprovalOutput.Type
  | {
      readonly iterations: number;
      readonly exitReason: "condition" | "maxIterations";
      readonly [key: string]: FlowStepOutput | number | "condition" | "maxIterations";
    }
  | {
      readonly items: ReadonlyArray<{
        readonly status: FlowStepRunStatus;
        readonly outputs: Readonly<Record<string, FlowStepOutput>>;
      }>;
    };
export const FlowRunError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  path: Schema.optional(Schema.String),
});
const Timings = {
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
};
export const FlowRunSummary = Schema.Struct({
  id: FlowRunId,
  projectId: ProjectId,
  flowId: FlowId,
  flowRunThreadId: ThreadId,
  status: FlowRunStatus,
  activeStepRunIds: Schema.Array(FlowStepRunId),
  error: Schema.NullOr(FlowRunError),
  ...Timings,
  scheduledTaskId: Schema.optional(ScheduledTaskId),
});
export type FlowRunSummary = typeof FlowRunSummary.Type;
export const FlowStepRun = Schema.Struct({
  id: FlowStepRunId,
  flowRunId: FlowRunId,
  stepPath: Schema.Array(Schema.String),
  iteration: Schema.optional(NonNegativeInt),
  itemIndex: Schema.optional(NonNegativeInt),
  attempt: PositiveInt,
  status: FlowStepRunStatus,
  threadId: Schema.NullOr(ThreadId),
  output: Schema.NullOr(FlowStepOutput),
  error: Schema.NullOr(FlowRunError),
  ...Timings,
});
export type FlowStepRun = typeof FlowStepRun.Type;
export const FlowApproval = Schema.Struct({
  stepRunId: FlowStepRunId,
  prompt: Schema.String,
  decision: Schema.NullOr(FlowApprovalDecision),
  comment: Schema.optional(Schema.String),
  answeredBy: Schema.NullOr(Schema.String),
  answeredAt: Schema.NullOr(IsoDateTime),
});
export type FlowApproval = typeof FlowApproval.Type;
const FieldsRef = Schema.suspend((): Schema.Codec<FlowOutputFields> => FlowOutputFields);
export const FlowOutputFields = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("agent"),
    fields: Schema.Record(Schema.String.check(Schema.isPattern(/^(?!text$).+$/)), FlowValue),
  }),
  Schema.Struct({ kind: Schema.Literal("command") }),
  Schema.Struct({ kind: Schema.Literal("approval"), ...FlowApprovalOutput.fields }),
  Schema.Struct({
    kind: Schema.Literal("loop"),
    iterations: NonNegativeInt,
    exitReason: Schema.Literals(["condition", "maxIterations"]),
    steps: Schema.Record(Schema.String, FieldsRef),
  }),
  Schema.Struct({
    kind: Schema.Literal("map"),
    items: Schema.Array(
      Schema.Struct({
        status: FlowStepRunStatus,
        outputs: Schema.Record(Schema.String, FieldsRef),
      }),
    ),
  }),
]);
export type FlowOutputFields =
  | { readonly kind: "agent"; readonly fields: Readonly<Record<string, FlowValue>> }
  | { readonly kind: "command" }
  | ({ readonly kind: "approval" } & typeof FlowApprovalOutput.Type)
  | {
      readonly kind: "loop";
      readonly iterations: number;
      readonly exitReason: "condition" | "maxIterations";
      readonly steps: Readonly<Record<string, FlowOutputFields>>;
    }
  | {
      readonly kind: "map";
      readonly items: ReadonlyArray<{
        readonly status: FlowStepRunStatus;
        readonly outputs: Readonly<Record<string, FlowOutputFields>>;
      }>;
    };
export const FlowStepRunState = Schema.Struct({
  ...FlowStepRun.mapFields(({ output: _output, ...fields }) => fields).fields,
  outputFields: Schema.NullOr(FlowOutputFields),
});
export type FlowStepRunState = typeof FlowStepRunState.Type;
export const FlowRunSnapshot = Schema.Struct({
  definitionSnapshot: Schema.optional(FlowDefinition),
  summary: FlowRunSummary,
  stepRuns: Schema.Array(FlowStepRunState),
  approvals: Schema.Array(FlowApproval),
});
export type FlowRunSnapshot = typeof FlowRunSnapshot.Type;
