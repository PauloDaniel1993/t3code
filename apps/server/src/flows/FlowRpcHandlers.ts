import { FLOW_WS_METHODS, FlowError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FlowService from "./FlowService.ts";

export const makeFlowRpcHandlers = Effect.gen(function* () {
  const service = yield* FlowService.FlowService;
  const connection = {};
  let subscriptions = 0;
  const bounded = <A>(stream: Stream.Stream<A, FlowError>) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          if (subscriptions >= 16)
            return yield* new FlowError({ message: "Too many flow subscriptions." });
          subscriptions++;
          return stream;
        }),
        () =>
          Effect.sync(() => {
            subscriptions--;
          }),
      ),
    );
  return {
    [FLOW_WS_METHODS.flowList]: ({
      projectId,
    }: {
      projectId: Parameters<typeof service.watch>[0];
    }) => bounded(service.watch(projectId, connection)),
    [FLOW_WS_METHODS.flowRuns]: ({
      projectId,
    }: {
      projectId: Parameters<typeof service.runs>[0];
    }) => bounded(service.runs(projectId)),
    [FLOW_WS_METHODS.flowRun]: ({ flowRunId }: { flowRunId: Parameters<typeof service.run>[0] }) =>
      bounded(service.run(flowRunId)),
    [FLOW_WS_METHODS.flowRunsPage]: ({
      projectId,
      before,
    }: {
      projectId: Parameters<typeof service.runsPage>[0];
      before: Parameters<typeof service.runsPage>[1];
    }) => service.runsPage(projectId, before),
    [FLOW_WS_METHODS.flowSave]: service.save,
    [FLOW_WS_METHODS.flowRename]: (input: {
      projectId: Parameters<typeof service.rename>[0];
      flowId: Parameters<typeof service.rename>[1];
      newFlowId: Parameters<typeof service.rename>[2];
    }) => service.rename(input.projectId, input.flowId, input.newFlowId),
    [FLOW_WS_METHODS.flowDelete]: (input: {
      projectId: Parameters<typeof service.delete>[0];
      flowId: Parameters<typeof service.delete>[1];
    }) => service.delete(input.projectId, input.flowId),
    [FLOW_WS_METHODS.flowValidate]: ({ definition }: { definition: unknown }) =>
      service.validate(definition),
    [FLOW_WS_METHODS.flowStart]: service.start,
    [FLOW_WS_METHODS.flowStop]: ({
      flowRunId,
    }: {
      flowRunId: Parameters<typeof service.stop>[0];
    }) => service.stop(flowRunId),
    [FLOW_WS_METHODS.flowResume]: ({
      flowRunId,
    }: {
      flowRunId: Parameters<typeof service.resume>[0];
    }) => service.resume(flowRunId),
    [FLOW_WS_METHODS.flowRetryStep]: ({
      stepRunId,
    }: {
      stepRunId: Parameters<typeof service.retryStep>[0];
    }) => service.retryStep(stepRunId),
    [FLOW_WS_METHODS.flowAnswerApproval]: (input: Parameters<typeof service.answerApproval>[0]) =>
      service.answerApproval(input, "user"),
    [FLOW_WS_METHODS.flowStepRunOutput]: ({
      stepRunId,
    }: {
      stepRunId: Parameters<typeof service.stepRunOutput>[0];
    }) => service.stepRunOutput(stepRunId),
    [FLOW_WS_METHODS.flowRunForThread]: ({
      threadId,
    }: {
      threadId: Parameters<typeof service.runForThread>[0];
    }) => service.runForThread(threadId),
  };
});
