import { FlowError, FLOW_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const unavailable = () => Effect.fail(new FlowError({ message: "Flows are not implemented yet." }));
export const flowRpcHandlers = {
  [FLOW_WS_METHODS.flowList]: () => Stream.fromEffect(unavailable()),
  [FLOW_WS_METHODS.flowRuns]: () => Stream.fromEffect(unavailable()),
  [FLOW_WS_METHODS.flowRunForThread]: () => Effect.succeed(null),
  [FLOW_WS_METHODS.flowRun]: () => Stream.fromEffect(unavailable()),
  [FLOW_WS_METHODS.flowRunsPage]: unavailable,
  [FLOW_WS_METHODS.flowSave]: unavailable,
  [FLOW_WS_METHODS.flowRename]: unavailable,
  [FLOW_WS_METHODS.flowDelete]: unavailable,
  [FLOW_WS_METHODS.flowValidate]: unavailable,
  [FLOW_WS_METHODS.flowStart]: unavailable,
  [FLOW_WS_METHODS.flowStepRunOutput]: unavailable,
  [FLOW_WS_METHODS.flowStop]: unavailable,
  [FLOW_WS_METHODS.flowResume]: unavailable,
  [FLOW_WS_METHODS.flowRetryStep]: unavailable,
  [FLOW_WS_METHODS.flowAnswerApproval]: unavailable,
};
