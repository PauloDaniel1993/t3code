import { expect, it } from "vite-plus/test";
import { EnvironmentId, FlowId, FlowRunId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useFlowPanelRequest } from "./flowPanelState";
it("consumes only the applied request, leaving a newer open request intact", () => {
  useFlowPanelRequest.setState({ requests: {} });
  const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  const first = { flowId: FlowId.make("first"), flowRunId: FlowRunId.make("run") };
  const next = { flowId: FlowId.make("second"), start: true };
  const key = scopedThreadKey(thread);
  useFlowPanelRequest.getState().open(thread, first);
  expect(useFlowPanelRequest.getState().requests[key]).toBe(first);
  useFlowPanelRequest.getState().open(thread, next);
  useFlowPanelRequest.getState().consume(key, first);
  expect(useFlowPanelRequest.getState().requests[key]).toBe(next);
  useFlowPanelRequest.getState().consume(key, next);
  expect(useFlowPanelRequest.getState().requests[key]).toBeUndefined();
});
