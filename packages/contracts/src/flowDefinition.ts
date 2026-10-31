import * as Schema from "effect/Schema";

import { ProviderOptionSelectionValue } from "./model.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const FlowId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)).pipe(
  Schema.brand("FlowId"),
);
export type FlowId = typeof FlowId.Type;
export const FlowStepId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
const FieldName = Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_-]*$/));
export const FlowValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);
export type FlowValue = typeof FlowValue.Type;
export const FlowInputs = Schema.Record(Schema.String, FlowValue);
export type FlowInputs = typeof FlowInputs.Type;
export const FlowInput = Schema.Union([
  Schema.Struct({
    name: FieldName,
    type: Schema.Literal("string"),
    default: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    required: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    name: FieldName,
    type: Schema.Literal("number"),
    default: Schema.optional(Schema.Number),
    description: Schema.optional(Schema.String),
    required: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    name: FieldName,
    type: Schema.Literal("boolean"),
    default: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String),
    required: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    name: FieldName,
    type: Schema.Literal("string[]"),
    default: Schema.optional(Schema.Array(Schema.String)),
    description: Schema.optional(Schema.String),
    required: Schema.optional(Schema.Boolean),
  }),
]);
export type FlowInput = typeof FlowInput.Type;
export const FlowOutputField = Schema.Union([
  Schema.Struct({
    name: FieldName,
    type: Schema.Literals(["string", "number", "boolean", "string[]"]),
  }),
  Schema.Struct({
    name: FieldName,
    type: Schema.Literal("enum"),
    values: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  }),
]);
export type FlowOutputField = typeof FlowOutputField.Type;
const ConditionRef = Schema.suspend((): Schema.Codec<FlowCondition> => FlowCondition);
export const FlowCondition = Schema.Union([
  Schema.Struct({
    ref: Schema.String,
    op: Schema.Literals(["eq", "neq", "lt", "lte", "gt", "gte", "contains"]),
    value: FlowValue,
  }),
  Schema.Struct({ ref: Schema.String, op: Schema.Literal("isEmpty") }),
  Schema.Struct({ all: Schema.Array(ConditionRef) }),
  Schema.Struct({ any: Schema.Array(ConditionRef) }),
  Schema.Struct({ not: ConditionRef }),
]);
export type FlowCondition =
  | {
      readonly ref: string;
      readonly op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains";
      readonly value: FlowValue;
    }
  | { readonly ref: string; readonly op: "isEmpty" }
  | { readonly all: ReadonlyArray<FlowCondition> }
  | { readonly any: ReadonlyArray<FlowCondition> }
  | { readonly not: FlowCondition };
export const FlowEdge = Schema.Struct({
  from: FlowStepId,
  to: FlowStepId,
  when: Schema.optional(FlowCondition),
  on: Schema.optional(Schema.Literal("failure")),
});
export type FlowEdge = typeof FlowEdge.Type;
export const FlowModel = Schema.Struct({
  providerInstanceId: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  options: Schema.optional(Schema.Record(Schema.String, ProviderOptionSelectionValue)),
});
export type FlowModel = typeof FlowModel.Type;
export const FlowDefaults = Schema.Struct({
  model: Schema.optional(FlowModel),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export const FlowAgentStep = Schema.Struct({
  id: FlowStepId,
  kind: Schema.Literal("agent"),
  prompt: Schema.String,
  ...FlowDefaults.fields,
  outputs: Schema.optional(Schema.Array(FlowOutputField)),
  thread: Schema.optional(
    Schema.Union([Schema.Literals(["new", "continue"]), Schema.Struct({ sameAs: FlowStepId })]),
  ),
});
export const FlowCommandStep = Schema.Struct({
  id: FlowStepId,
  kind: Schema.Literal("command"),
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export const FlowApprovalStep = Schema.Struct({
  id: FlowStepId,
  kind: Schema.Literal("approval"),
  prompt: Schema.String,
});
const StepRef = Schema.suspend((): Schema.Codec<FlowStep> => FlowStep);
const ContainerFields = {
  id: FlowStepId,
  steps: Schema.Array(StepRef),
  edges: Schema.Array(FlowEdge),
};
export const FlowLoopStep = Schema.Struct({
  ...ContainerFields,
  kind: Schema.Literal("loop"),
  maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  until: FlowCondition,
});
export const FlowMapStep = Schema.Struct({
  ...ContainerFields,
  kind: Schema.Literal("map"),
  over: Schema.String,
  concurrency: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
  maxItems: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  onItemFailure: Schema.optional(Schema.Literals(["fail", "continue"])),
});
export const FlowStep = Schema.Union([
  FlowAgentStep,
  FlowCommandStep,
  FlowApprovalStep,
  FlowLoopStep,
  FlowMapStep,
]);
export type FlowStep =
  | typeof FlowAgentStep.Type
  | typeof FlowCommandStep.Type
  | typeof FlowApprovalStep.Type
  | {
      readonly id: string;
      readonly kind: "loop";
      readonly steps: ReadonlyArray<FlowStep>;
      readonly edges: ReadonlyArray<FlowEdge>;
      readonly maxIterations: number;
      readonly until: FlowCondition;
    }
  | {
      readonly id: string;
      readonly kind: "map";
      readonly steps: ReadonlyArray<FlowStep>;
      readonly edges: ReadonlyArray<FlowEdge>;
      readonly over: string;
      readonly concurrency?: number | undefined;
      readonly maxItems?: number | undefined;
      readonly onItemFailure?: "fail" | "continue" | undefined;
    };
export const FlowDefinition = Schema.Struct({
  version: Schema.Literal(1),
  title: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.Literals(["worktree", "root"])),
  inputs: Schema.optional(Schema.Array(FlowInput)),
  defaults: Schema.optional(FlowDefaults),
  steps: Schema.Array(FlowStep),
  edges: Schema.Array(FlowEdge),
  layout: Schema.optional(
    Schema.Record(FlowStepId, Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  ),
});
export type FlowDefinition = typeof FlowDefinition.Type;
export const FlowValidationError = Schema.Struct({ path: Schema.String, message: Schema.String });
export type FlowValidationError = typeof FlowValidationError.Type;
export const FlowValidationResult = Schema.Struct({
  valid: Schema.Boolean,
  errors: Schema.Array(FlowValidationError),
});
export type FlowValidationResult = typeof FlowValidationResult.Type;
export const FlowScheduledTarget = Schema.Struct({
  flowId: FlowId,
  inputs: Schema.Record(Schema.String, Schema.String),
  baseRef: Schema.optional(Schema.String),
});
