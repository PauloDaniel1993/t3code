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
import { FlowDefinition, FlowId, FlowInputs, FlowValue } from "./flowDefinition.ts";

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
export const FlowAgentOutput = Schema.StructWithRest(
  Schema.Struct({ kind: Schema.Literal("agent"), text: Schema.String }),
  [Schema.Record(Schema.String, FlowValue)],
);
export const FlowCommandOutput = Schema.Struct({
  kind: Schema.Literal("command"),
  lineCount: NonNegativeInt.annotate({
    description: "Non-empty stdout line count before capping lines; maps reject truncated sources.",
  }),
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  text: Schema.String,
  lines: Schema.Array(Schema.String),
});
export const FlowApprovalOutput = Schema.Struct({
  kind: Schema.Literal("approval"),
  decision: FlowApprovalDecision,
  comment: Schema.optional(Schema.String),
});
export const FlowLoopOutput = Schema.StructWithRest(
  Schema.Struct({
    kind: Schema.Literal("loop"),
    iterations: NonNegativeInt,
    exitReason: Schema.Literals(["condition", "maxIterations"]),
  }),
  [
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^(?!(?:kind|iterations|exitReason)$).+$/)),
      OutputRef,
    ),
  ],
);
export const FlowMapOutput = Schema.Struct({
  kind: Schema.Literal("map"),
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
  | ({ readonly kind: "agent"; readonly text: string } & Readonly<Record<string, FlowValue>>)
  | typeof FlowCommandOutput.Type
  | typeof FlowApprovalOutput.Type
  | {
      readonly kind: "loop";
      readonly iterations: number;
      readonly exitReason: "condition" | "maxIterations";
      readonly [key: string]: FlowStepOutput | number | "loop" | "condition" | "maxIterations";
    }
  | {
      readonly kind: "map";
      readonly items: ReadonlyArray<{
        readonly status: FlowStepRunStatus;
        readonly outputs: Readonly<Record<string, FlowStepOutput>>;
      }>;
    };
export const FlowRunError = Schema.Struct({
  code: Schema.Literals([
    "missing_report",
    "interrupted",
    "command_timeout",
    "command_error",
    "turn_failed",
    "turn_cancelled",
    "max_items",
    "other",
  ]),
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
  runNumber: PositiveInt,
  flowTitle: Schema.String,
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
  parentStepRunId: Schema.NullOr(FlowStepRunId).annotate({
    description:
      "Enclosing container step run, or null at the top level. Full iteration/item coordinates follow the parent chain.",
  }),
  stepPath: Schema.Array(Schema.String),
  iteration: Schema.optional(NonNegativeInt),
  itemIndex: Schema.optional(NonNegativeInt),
  attempt: PositiveInt,
  status: FlowStepRunStatus,
  threadId: Schema.NullOr(ThreadId),
  output: Schema.NullOr(OutputRef),
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
export const FlowOutputFields = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("agent"),
    fields: Schema.Record(
      Schema.String.check(Schema.isPattern(/^(?!(?:text|kind)$).+$/)),
      FlowValue,
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    lineCount: NonNegativeInt.annotate({
      description:
        "Non-empty stdout line count before capping lines; maps reject truncated sources.",
    }),
  }),
  FlowApprovalOutput,
  Schema.Struct({
    kind: Schema.Literal("loop"),
    iterations: NonNegativeInt,
    exitReason: Schema.Literals(["condition", "maxIterations"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("map"),
    items: Schema.Array(Schema.Struct({ status: FlowStepRunStatus })),
  }),
]);
export type FlowOutputFields = typeof FlowOutputFields.Type;
export const FlowStepRunState = Schema.Struct({
  ...FlowStepRun.mapFields(({ output: _output, ...fields }) => fields).fields,
  outputFields: Schema.NullOr(FlowOutputFields),
});
export type FlowStepRunState = typeof FlowStepRunState.Type;
export const FlowRunSnapshot = Schema.Struct({
  definition: FlowDefinition,
  inputs: FlowInputs,
  summary: FlowRunSummary,
  stepRuns: Schema.Array(FlowStepRunState),
  approvals: Schema.Array(FlowApproval),
});
export type FlowRunSnapshot = typeof FlowRunSnapshot.Type;

export const FlowRunEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), ...FlowRunSnapshot.fields }),
  Schema.Struct({
    type: Schema.Literal("upsert"),
    summary: Schema.optional(FlowRunSummary),
    stepRuns: Schema.Array(FlowStepRunState),
    approvals: Schema.Array(FlowApproval),
  }),
]);
export type FlowRunEvent = typeof FlowRunEvent.Type;
export const FlowRunsCursor = Schema.Struct({ createdAt: IsoDateTime, id: FlowRunId });
export type FlowRunsCursor = typeof FlowRunsCursor.Type;
export const FlowRunsPage = Schema.Struct({
  runs: Schema.Array(FlowRunSummary).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(FlowRunsCursor),
});
export type FlowRunsPage = typeof FlowRunsPage.Type;
export const FlowRunsEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), ...FlowRunsPage.fields }),
  Schema.Struct({ type: Schema.Literal("upsert"), runs: Schema.Array(FlowRunSummary) }),
]);
export type FlowRunsEvent = typeof FlowRunsEvent.Type;
